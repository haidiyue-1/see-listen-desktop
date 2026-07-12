const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const LX_MUSIC_PORT = process.env.LX_MUSIC_PORT || 23330;
const LX_MUSIC_HOST = process.env.LX_MUSIC_HOST || '127.0.0.1';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || ''; // Set via env var ACCESS_TOKEN to restrict playback controls (leave empty = no auth)

const PUBLIC_DIR = path.join(__dirname, 'public');

let weatherCache = null;
let lastWeatherFetch = 0;
const WEATHER_CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

// In-Memory Visitor 点歌队列
let visitorQueue = [];
let pendingScheme = null;
let requestHistory = []; // cache of recent requests for deduplication

const QUEUE_FILE = path.join(__dirname, 'visitor_queue.json');
const HISTORY_FILE = path.join(__dirname, 'request_history.json');
const STATS_FILE = path.join(__dirname, 'lx_stats.json');

let globalStats = {
  totalDuration: 0,
  totalPlays: 0,
  artistCounts: {},
  trackCounts: {},
  hourlyPlays: Array(24).fill(0),
  dailyPlays: {}
};

function loadQueueData() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      visitorQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
      console.log(`Loaded ${visitorQueue.length} queued songs from disk cache.`);
    }
    if (fs.existsSync(HISTORY_FILE)) {
      requestHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`Loaded ${requestHistory.length} request history items from disk cache.`);
    }
    if (fs.existsSync(STATS_FILE)) {
      globalStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      // Backwards compatibility array check
      if (!Array.isArray(globalStats.hourlyPlays) || globalStats.hourlyPlays.length !== 24) {
        globalStats.hourlyPlays = Array(24).fill(0);
      }
      console.log('Loaded global listening stats from disk cache.');
    }
  } catch (err) {
    console.error('Failed to load queue/stats cache:', err.message);
  }
}

// ── 脏标记：内存统计有变化时置为 true，由定时器批量落盘 ──
let statsDirty = false;

function saveStatsData() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(globalStats, null, 2), 'utf8');
    statsDirty = false;
  } catch (err) {
    console.error('Failed to save stats cache:', err.message);
  }
}

// 每 60 秒批量落盘（仅在有更新时写磁盘）
setInterval(() => {
  if (statsDirty) {
    saveStatsData();
    console.log('[Stats] Periodic flush: stats saved to disk.');
  }
}, 60 * 1000);

// 进程退出时强制落盘，避免数据丢失
process.on('exit', () => { if (statsDirty) saveStatsData(); });
process.on('SIGINT', () => { if (statsDirty) saveStatsData(); process.exit(0); });
process.on('SIGTERM', () => { if (statsDirty) saveStatsData(); process.exit(0); });



function saveQueueData() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(visitorQueue, null, 2), 'utf8');
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(requestHistory, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save queue cache:', err.message);
  }
}

// Helper to serve static files from /public
function serveStatic(filePath, res) {
  const safePath = path.resolve(filePath);
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    let contentType = 'text/plain; charset=utf-8';
    
    if (ext === '.html') contentType = 'text/html; charset=utf-8';
    else if (ext === '.css') contentType = 'text/css; charset=utf-8';
    else if (ext === '.js') contentType = 'application/javascript; charset=utf-8';
    else if (ext === '.json') contentType = 'application/json; charset=utf-8';
    else if (ext === '.png') contentType = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.gif') contentType = 'image/gif';
    else if (ext === '.svg') contentType = 'image/svg+xml';
    else if (ext === '.ico') contentType = 'image/x-icon';

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(safePath);
    stream.pipe(res);
  });
}

// Windows Scheme Protocol Play Command
function playSongViaScheme(song) {
  pendingScheme = song; // Cache it for browser session 1 polling
  
  const data = JSON.stringify({
    name: song.name,
    singer: song.singer,
    source: song.source || 'wy',
    songmid: song.songmid,
    types: [
      { type: '128k', size: '3.5M' },
      { type: '320k', size: '9M' },
      { type: 'flac', size: '25M' }
    ]
  });
  
  const encodedData = encodeURIComponent(data);
  const command = `cmd.exe /c start "" "lxmusic://music/play?data=${encodedData}"`;
  
  const { exec } = require('child_process');
  exec(command, (err) => {
    if (err) {
      console.error('Failed to trigger scheme playback:', err.message);
    }
  });
}

// ── 后台播放监听器（优化版）──
// 优化要点：
//   1. 累计有效播放秒数（≥15s 才算有效，解决无效播放）
//   2. 30 秒防刷缓存（同一首歌 30s 内只计一次，解决重复计数）
//   3. 脏标记 + 60s 批量落盘（解决高频 IO 瓶颈）

let backendCurrentTrackId  = '';   // 当前正在跟踪的曲目 ID
let backendPlayRegistered  = false; // 当前曲目是否已计入统计
let backendPlaySeconds     = 0;     // 当前曲目累计有效播放秒数

// 防刷缓存：trackId -> 最近一次计入时间戳(ms)
const recentPlaysCache = new Map();
const ANTI_REPEAT_MS   = 30 * 1000; // 30 秒内同一首歌不重复计数
const VALID_PLAY_SEC   = 15;        // 至少累计播放 15 秒才算有效

function startPlaybackMonitor() {
  setInterval(() => {
    const options = {
      hostname: LX_MUSIC_HOST,
      port: LX_MUSIC_PORT,
      path: '/status',
      method: 'GET',
      timeout: 1000
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const status = JSON.parse(body);

          if (status.status === 'playing' && status.name && status.singer) {
            const trackId = `${status.name} - ${status.singer}`;

            // ① 切歌时重置状态
            if (trackId !== backendCurrentTrackId) {
              backendCurrentTrackId = trackId;
              backendPlayRegistered  = false;
              backendPlaySeconds     = 0;
              console.log(`[Stats] Tracking new track: ${trackId}`);
            }

            // ② 累计有效播放秒数（每次轮询 +1s）
            if (!backendPlayRegistered) {
              backendPlaySeconds += 1;
            }

            // ③ 达到有效播放阈值 && 30 秒防刷检测
            if (!backendPlayRegistered && backendPlaySeconds >= VALID_PLAY_SEC) {
              const lastPlayed  = recentPlaysCache.get(trackId) || 0;
              const now         = Date.now();

              if (now - lastPlayed < ANTI_REPEAT_MS) {
                // 30 秒内已计过一次，标记跳过（不重置 registered，避免反复触发日志）
                backendPlayRegistered = true;
                console.log(`[Stats] Anti-repeat skip: ${trackId} (last play ${Math.round((now-lastPlayed)/1000)}s ago)`);
              } else {
                // ✅ 有效播放，写入内存统计
                backendPlayRegistered = true;
                recentPlaysCache.set(trackId, now);

                globalStats.totalPlays += 1;
                const artist = status.singer || '未知艺术家';
                globalStats.artistCounts[artist] = (globalStats.artistCounts[artist] || 0) + 1;

                if (!globalStats.trackCounts[trackId]) {
                  globalStats.trackCounts[trackId] = {
                    count: 0,
                    title: status.name,
                    artist: status.singer,
                    lastPlayed: 0
                  };
                }
                globalStats.trackCounts[trackId].count     += 1;
                globalStats.trackCounts[trackId].lastPlayed = now;

                const d       = new Date(now);
                const dateStr = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
                globalStats.dailyPlays[dateStr]  = (globalStats.dailyPlays[dateStr]  || 0) + 1;
                globalStats.hourlyPlays[d.getHours()] = (globalStats.hourlyPlays[d.getHours()] || 0) + 1;

                // 标记脏位，等待 60s 定时器批量落盘（不立即写磁盘）
                statsDirty = true;
                console.log(`[Stats] ✅ Valid play registered: ${trackId} (played ${backendPlaySeconds}s)`);
              }
            }

          }
          // 暂停/停止时不做任何处理，累计秒数保留（用户暂停后继续不会重置进度）
        } catch (e) {}
      });
    });

    req.on('error', () => {
      // LX Music 离线，静默忽略
    });
    req.end();
  }, 1000);
}

// HTTP Server Entry Point
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // 1. Auth check endpoint
  if (pathname === '/api/auth-check') {
    res.writeHead(200, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ authRequired: !!ACCESS_TOKEN }));
    return;
  }

  // Helper for authentication validation
  const isAuthorized = () => {
    if (!ACCESS_TOKEN) return true;
    const token = parsedUrl.query.token || req.headers['x-access-token'];
    return token === ACCESS_TOKEN;
  };

  // 1.5 Token verification endpoint
  if (pathname === '/api/verify-token') {
    res.writeHead(200, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ success: isAuthorized() }));
    return;
  }

  // 1.55 Time synchronization endpoint to bypass incorrect system clock on host
  if (pathname === '/api/time') {
    // 使用淘宝官方毫秒级授时接口，国内超快且精准
    const timeOptions = {
      hostname: 'api.m.taobao.com',
      path: '/txbin/query/ts?t=' + Date.now(),
      method: 'GET',
      timeout: 1500
    };

    const timeReq = http.request(timeOptions, (timeRes) => {
      let body = '';
      timeRes.on('data', chunk => body += chunk);
      timeRes.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          // 淘宝接口返回的是精确到毫秒的 Unix 时间戳字符串: { "t": "1783858000000" }
          const unixtimeMs = parseInt(parsed.t);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ unixtime: unixtimeMs }));
        } catch (e) {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ unixtime: Date.now(), fallback: true }));
        }
      });
    });

    timeReq.on('error', () => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ unixtime: Date.now(), fallback: true }));
    });

    timeReq.end();
    return;
  }

  // 1.6 Weather API endpoint (Proxying wttr.in with 15-minute cache)
  if (pathname === '/api/weather') {
    const now = Date.now();
    if (weatherCache && (now - lastWeatherFetch < WEATHER_CACHE_DURATION)) {
      res.writeHead(200, { 
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(weatherCache));
      return;
    }

    const weatherOptions = {
      hostname: 'wttr.in',
      path: '/Wuhan?format=j1',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };

    const weatherReq = http.request(weatherOptions, (weatherRes) => {
      let body = '';
      weatherRes.on('data', (chunk) => body += chunk);
      weatherRes.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const current = parsed.current_condition[0];
          const temp = current.temp_C;
          const desc = current.weatherDesc[0].value;
          
          weatherCache = { temp, desc, timestamp: now };
          lastWeatherFetch = now;
          
          res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(weatherCache));
        } catch (e) {
          res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ temp: '25', desc: 'Sunny', fallback: true }));
        }
      });
    });

    weatherReq.on('error', (err) => {
      console.error('Weather fetch error:', err.message);
      res.writeHead(200, { 
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ temp: '25', desc: 'Sunny', fallback: true }));
    });

    weatherReq.end();
    return;
  }

  // 1.65 Listening Stats Endpoints (GET and POST)
  if (pathname === '/api/stats') {
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(globalStats));
      return;
    }
    
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          let modified = false;

          // Track listening duration increment
          if (data.action === 'trackDuration' && typeof data.deltaSeconds === 'number' && data.deltaSeconds > 0) {
            globalStats.totalDuration += data.deltaSeconds;
            modified = true;
          }

          // Register a full track play count
          if (data.action === 'registerPlay' && data.name && data.singer) {
            globalStats.totalPlays += 1;
            
            const artist = data.singer || '未知艺术家';
            globalStats.artistCounts[artist] = (globalStats.artistCounts[artist] || 0) + 1;
            
            const songId = `${data.name} - ${data.singer}`;
            if (!globalStats.trackCounts[songId]) {
              globalStats.trackCounts[songId] = {
                count: 0,
                title: data.name,
                artist: data.singer,
                lastPlayed: 0
              };
            }
            globalStats.trackCounts[songId].count += 1;
            globalStats.trackCounts[songId].lastPlayed = Date.now();
            
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
            globalStats.dailyPlays[dateStr] = (globalStats.dailyPlays[dateStr] || 0) + 1;
            
            const hour = now.getHours();
            globalStats.hourlyPlays[hour] = (globalStats.hourlyPlays[hour] || 0) + 1;
            
            modified = true;
          }

          if (modified) {
            saveStatsData();
          }

          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: true, stats: globalStats }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Invalid payload' }));
        }
      });
      return;
    }
  }

  // 1.7 Music Search Proxy (Via GD Studio API)
  if (pathname === '/api/search-music') {
    const keyword = parsedUrl.query.keyword || '';
    if (!keyword) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ songs: [] }));
      return;
    }

    const encodedKeyword = encodeURIComponent(keyword);
    // 使用 GD Studio 聚合接口进行网易源搜索
    const searchUrl = `https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=${encodedKeyword}&count=20`;
    
    https.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (searchRes) => {
      let body = '';
      searchRes.on('data', (chunk) => body += chunk);
      searchRes.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const rawSongs = Array.isArray(parsed) ? parsed : [];
          // 适配前台渲染格式
          const songs = rawSongs.map(s => ({
            songmid: s.id.toString(), // track_id
            name: s.name,
            singer: Array.isArray(s.artist) ? s.artist.join('/') : (s.artist || '未知歌手'),
            source: s.source || 'netease'
          }));
          
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ songs }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ songs: [], error: 'Search failed' }));
        }
      });
    }).on('error', (err) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ songs: [], error: err.message }));
    });
    return;
  }

  // 1.8 Request/Add Song to Visitor Queue
  if (pathname === '/api/request-song') {
    const name = parsedUrl.query.name || '';
    const singer = parsedUrl.query.singer || '';
    const source = parsedUrl.query.source || 'wy';
    const songmid = parsedUrl.query.songmid || '';

    if (!name || !songmid) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing parameters' }));
      return;
    }

    // Limit visitor queue size to 20 songs to prevent spam
    if (visitorQueue.length >= 20) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '点歌队列已满（上限20首），请稍后再点' }));
      return;
    }

    // Clean up request history older than 5 minutes (300,000 ms)
    const now = Date.now();
    requestHistory = requestHistory.filter(h => now - h.timestamp < 5 * 60 * 1000);

    // Prevent duplicate entries of the exact same song ID currently in active queue
    const isDuplicate = visitorQueue.some(s => s.songmid === songmid);
    if (isDuplicate) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '该歌曲已在当前播放队列中' }));
      return;
    }

    // Check if the same song was requested within the last 5 minutes (even if played and removed)
    const isRecentDuplicate = requestHistory.some(h => h.songmid === songmid || (h.name === name && h.singer === singer));
    if (isRecentDuplicate) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '这首歌在 5 分钟内已被点过，请稍后再点' }));
      return;
    }

    const newSong = { name, singer, source, songmid, timestamp: now };
    visitorQueue.push(newSong);
    requestHistory.push({ songmid, name, singer, timestamp: now });
    saveQueueData();

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, queue: visitorQueue }));
    return;
  }

  // 1.9 Get Visitor Queue List
  if (pathname === '/api/get-queue') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ queue: visitorQueue }));
    return;
  }

  // 1.95 Remove Song from Queue (Control Auth check)
  if (pathname === '/api/remove-queued-song') {
    const idx = parseInt(parsedUrl.query.index, 10);
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (isNaN(idx) || idx < 0 || idx >= visitorQueue.length) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid index' }));
      return;
    }

    visitorQueue.splice(idx, 1);
    saveQueueData();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, queue: visitorQueue }));
    return;
  }

  // 1.96 Get Current Song Playable Audio Direct URL (With Netease -> Kuwo -> Bilibili Fallbacks + HTTPS enforce)
  if (pathname === '/api/get-current-audio') {
    const name = parsedUrl.query.name || '';
    const singer = parsedUrl.query.singer || '';
    
    if (!name) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ url: null }));
      return;
    }

    const keyword = encodeURIComponent(name + ' ' + singer);

    // 辅助函数：通过指定音乐源尝试获取直链
    const trySource = (sourceName, callback) => {
      const searchUrl = `https://music-api.gdstudio.xyz/api.php?types=search&source=${sourceName}&name=${keyword}&count=1`;
      
      https.get(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, (searchRes) => {
        let body = '';
        searchRes.on('data', chunk => body += chunk);
        searchRes.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const song = parsed && parsed[0];
            if (song && song.id) {
              const audioUrl = `https://music-api.gdstudio.xyz/api.php?types=url&source=${song.source}&id=${song.id}&br=320`;
              
              https.get(audioUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
              }, (audioRes) => {
                let audioBody = '';
                audioRes.on('data', chunk => audioBody += chunk);
                audioRes.on('end', () => {
                  try {
                    const audioParsed = JSON.parse(audioBody);
                    let rawUrl = audioParsed.url || '';
                    if (rawUrl && rawUrl.trim() !== '') {
                      // 核心修复：强制将 http:// 替换为 https:// 防止浏览器混合内容拦截
                      if (rawUrl.startsWith('http://')) {
                        rawUrl = rawUrl.replace('http://', 'https://');
                      }
                      callback(rawUrl);
                    } else {
                      callback(null);
                    }
                  } catch {
                    callback(null);
                  }
                });
              }).on('error', () => callback(null));
            } else {
              callback(null);
            }
          } catch {
            callback(null);
          }
        });
      }).on('error', () => callback(null));
    };

    // 级联降级策略：网易 -> 酷我 -> Bilibili
    trySource('netease', (url1) => {
      if (url1) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ url: url1 }));
      } else {
        console.log(`[Audio Sync] Netease source failed for "${name}". Falling back to Kuwo...`);
        trySource('kuwo', (url2) => {
          if (url2) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ url: url2 }));
          } else {
            console.log(`[Audio Sync] Kuwo source failed for "${name}". Falling back to Bilibili...`);
            trySource('bilibili', (url3) => {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ url: url3 }));
            });
          }
        });
      }
    });
    return;
  }

  // 1.97 Get Pending Scheme trigger (For Session 1 Browser-based Scheme Redirection)
  if (pathname === '/api/get-pending-scheme') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ song: pendingScheme }));
    pendingScheme = null; // Clear it immediately
    return;
  }

  // 1.98 Pop Next Queued Song (For Browser-driven queue progression)
  if (pathname === '/api/pop-next-queued-song') {
    const song = visitorQueue.shift();
    saveQueueData();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ song: song || null }));
    return;
  }

  // 1.99 Request/Play Song Now (Cut-in command)
  if (pathname === '/api/request-song-now') {
    const name = parsedUrl.query.name || '';
    const singer = parsedUrl.query.singer || '';
    const source = parsedUrl.query.source || 'wy';
    const songmid = parsedUrl.query.songmid || '';

    if (!name || !songmid) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing parameters' }));
      return;
    }

    pendingScheme = { name, singer, source, songmid };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 2. SSE subscription proxy (PUBLIC)
  if (pathname === '/subscribe-player-status') {
    const filter = parsedUrl.query.filter || '';
    const pathWithFilter = `/subscribe-player-status${filter ? `?filter=${filter}` : ''}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const options = {
      hostname: LX_MUSIC_HOST,
      port: LX_MUSIC_PORT,
      path: pathWithFilter,
      method: 'GET'
    };

    const proxyReq = http.request(options, (proxyRes) => {
      proxyRes.on('data', (chunk) => {
        res.write(chunk);
      });
      proxyRes.on('end', () => {
        res.end();
      });
    });

    proxyReq.on('error', (err) => {
      console.error('SSE Proxy connection to LX Music failed:', err.message);
      res.write('event: error\ndata: "LX Music is offline"\n\n');
      res.end();
    });

    req.on('close', () => {
      proxyReq.destroy();
    });

    proxyReq.end();
    return;
  }

  // 3. Status and Player Controller Proxy
  const publicEndpoints = ['/status', '/lyric', '/lyric-all'];
  const controlEndpoints = [
    '/play', '/pause', '/skip-next', '/skip-prev', 
    '/seek', '/volume', '/mute', '/collect', '/uncollect'
  ];

  if (publicEndpoints.includes(pathname) || controlEndpoints.includes(pathname)) {
    if (controlEndpoints.includes(pathname) && !isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const queryParams = { ...parsedUrl.query };
    delete queryParams.token;
    const queryString = new URLSearchParams(queryParams).toString();

    const options = {
      hostname: LX_MUSIC_HOST,
      port: LX_MUSIC_PORT,
      path: `${pathname}${queryString ? `?${queryString}` : ''}`,
      method: 'GET'
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`Proxy GET error for ${pathname}:`, err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'LX Music is offline' }));
    });

    proxyReq.end();
    return;
  }

  // 4. Fallback: serve static frontend files
  let targetPath = path.join(PUBLIC_DIR, pathname);
  if (pathname === '/') {
    targetPath = path.join(PUBLIC_DIR, 'index.html');
  }
  serveStatic(targetPath, res);
});

server.listen(PORT, () => {
  // Load queue cache from disk on startup
  loadQueueData();
  
  console.log(`LX Music Web Bridge Server running at http://localhost:${PORT}`);
  console.log(`Targeting LX Music at http://${LX_MUSIC_HOST}:${LX_MUSIC_PORT}`);
  if (ACCESS_TOKEN) {
    console.log('Access Control: ENABLED');
  } else {
    console.log('Access Control: DISABLED');
  }
  
  // Start the background playback monitor loop
  startPlaybackMonitor();
});

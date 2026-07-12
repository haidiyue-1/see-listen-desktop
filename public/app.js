// Player State Object
const state = {
  status: 'stopped', // playing, paused, error, stopped
  name: '等待播放',
  singer: '未知艺术家',
  albumName: '未知专辑',
  duration: 0,
  progress: 0,
  playbackRate: 1,
  picUrl: '',
  lyricLineText: '',
  lyric: '',
  tlyric: '',
  rlyric: '',
  lxlyric: '',
  collect: false,
  volume: 50,
  mute: false,
  
  // Client local tracking
  lastUpdate: 0,
  parsedLyrics: [],
  activeLyricIndex: -1,
  isSeeking: false,
  token: '',
  authRequired: false,
  showSubtitles: true,
  controlsUnlocked: false,
  currentTab: 'lyrics', // lyrics, stats, request
  
  // Audio Sync state
  isSyncAudioPlaying: false
};

// DOM Elements
const elements = {
  bgBlur: document.getElementById('bgBlur'),
  authModal: document.getElementById('authModal'),
  tokenInput: document.getElementById('tokenInput'),
  authBtn: document.getElementById('authBtn'),
  authError: document.getElementById('authError'),
  closeAuthModalBtn: document.getElementById('closeAuthModalBtn'),
  lockBtn: document.getElementById('lockBtn'),
  playerDashboard: document.getElementById('playerDashboard'),
  statusBadge: document.getElementById('statusBadge'),
  collectBtn: document.getElementById('collectBtn'),
  albumArt: document.getElementById('albumArt'),
  albumArtWrap: document.getElementById('albumArtWrap'),
  playStateIndicator: document.getElementById('playStateIndicator'),
  trackTitle: document.getElementById('trackTitle'),
  trackArtist: document.getElementById('trackArtist'),
  trackAlbum: document.getElementById('trackAlbum'),
  currentTime: document.getElementById('currentTime'),
  totalTime: document.getElementById('totalTime'),
  progressBarWrap: document.getElementById('progressBarWrap'),
  progressBarFill: document.getElementById('progressBarFill'),
  progressHandle: document.getElementById('progressHandle'),
  prevBtn: document.getElementById('prevBtn'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  nextBtn: document.getElementById('nextBtn'),
  muteBtn: document.getElementById('muteBtn'),
  volumeSliderWrap: document.getElementById('volumeSliderWrap'),
  volumeSliderFill: document.getElementById('volumeSliderFill'),
  volumeInput: document.getElementById('volumeInput'),
  volumeVal: document.getElementById('volumeVal'),
  modeLrc: document.getElementById('modeLrc'),
  modeSub: document.getElementById('modeSub'),
  lyricsContainer: document.getElementById('lyricsContainer'),
  lyricsWrapper: document.getElementById('lyricsWrapper'),
  offlineOverlay: document.getElementById('offlineOverlay'),
  reconnectBtn: document.getElementById('reconnectBtn'),
  
  // Widgets & Tab Elements
  widgetTime: document.getElementById('widgetTime'),
  widgetDate: document.getElementById('widgetDate'),
  weatherTemp: document.getElementById('weatherTemp'),
  weatherDesc: document.getElementById('weatherDesc'),
  weatherIcon: document.getElementById('weatherIcon'),
  lastPlayedInfo: document.getElementById('lastPlayedInfo'),
  lastPlayedTime: document.getElementById('lastPlayedTime'),
  lastPlayedTrack: document.getElementById('lastPlayedTrack'),
  lastPlayedProgress: document.getElementById('lastPlayedProgress'),
  tabLyrics: document.getElementById('tabLyrics'),
  tabStats: document.getElementById('tabStats'),
  tabRequest: document.getElementById('tabRequest'),
  lyricModeSelector: document.getElementById('lyricModeSelector'),
  statsContainer: document.getElementById('statsContainer'),
  requestContainer: document.getElementById('requestContainer'),
  
  // Sync Audio Elements
  syncAudio: document.getElementById('syncAudio'),
  syncAudioBtn: document.getElementById('syncAudioBtn'),
  
  // Search & Queue Elements
  songSearchInput: document.getElementById('songSearchInput'),
  songSearchBtn: document.getElementById('songSearchBtn'),
  searchResultsSection: document.getElementById('searchResultsSection'),
  searchResultsList: document.getElementById('searchResultsList'),
  queueList: document.getElementById('queueList')
};

// SSE and Interval Variables
let eventSource = null;
let progressInterval = null;
let reconnectTimeout = null;
let timeInterval = null;
let weatherInterval = null;

// Weather Canvas & Particle System Variables
let canvas = null;
let ctx = null;
let particles = [];
let weatherType = 'stars'; // stars, rain, snow, clouds
let animationId = null;
let resizeTimeout = null;

// Spectrum Visualizer Variables
let spectrumCanvas = null;
let spectrumCtx = null;
let spectrumBars = Array(28).fill(0).map(() => ({ val: 0, target: 0 }));

// Performance Caches: Cache karaoke words array to avoid querying DOM at 60fps
let cachedKaraokeWords = [];

// Listening Stats Tracking Variables
let currentSongTrackId = '';
let playRegistered = false;
let playStartTime = 0;
let lastTickTime = 0;
let queueTriggeredForCurrentSong = false;

// Initialize Web App
async function init() {
  state.token = localStorage.getItem('lx_web_token') || '';
  
  // Check if server requires authentication
  try {
    const res = await fetch('/api/auth-check');
    const data = await res.json();
    state.authRequired = data.authRequired;
  } catch (err) {
    console.error('Failed to contact backend server:', err);
    showOffline(true);
    return;
  }

  // Always show the player dashboard to spectators
  elements.playerDashboard.classList.remove('hidden');
  
  // Verify the saved token if access control is enabled
  if (state.authRequired && state.token) {
    try {
      const verifyRes = await fetch(`/api/verify-token?token=${encodeURIComponent(state.token)}`);
      const verifyData = await verifyRes.json();
      state.controlsUnlocked = verifyData.success;
    } catch {
      state.controlsUnlocked = false;
    }
  } else if (!state.authRequired) {
    state.controlsUnlocked = true;
  }

  // Initialize all features
  startConnection();
  setupEventListeners();
  loadSubSettings();
  updateLockBtnUI();
  
  // Start Time Widget
  initTimeWidget();
  
  // Initialize Weather Layer & Fetch Weather
  initWeatherCanvas();
  fetchWeather();
  weatherInterval = setInterval(fetchWeather, 15 * 60 * 1000); // refresh every 15 minutes
  
  // Initialize Stereo Spectrum Canvas
  initSpectrum();

  // Start real-time Karaoke sweeping loop
  requestAnimationFrame(updateKaraokeHighlight);
  
  // Check if offline/paused on startup to render "last played" status
  handleLastPlayedDisplay();

  // Start polling loop for pending local scheme playback triggers (Session 1 command forwarding)
  setInterval(async () => {
    if (!state.controlsUnlocked || state.status === 'offline') return;
    try {
      const res = await fetch(`/api/get-pending-scheme?token=${encodeURIComponent(state.token)}`);
      const data = await res.json();
      if (data.song) {
        triggerLocalScheme(data.song);
      }
    } catch (err) {
      // ignore
    }
  }, 2000);

  // Initialize interactive floating desktop pet
  initDesktopPet();

  // Show welcome guide for first-time visitors
  checkWelcomeGuide();
}

function checkWelcomeGuide() {
  const guideShown = localStorage.getItem('lx_guide_shown');
  const guideModal = document.getElementById('welcomeGuideModal');
  const closeBtn = document.getElementById('closeGuideBtn');
  
  if (!guideShown && guideModal) {
    guideModal.classList.remove('hidden');
    
    closeBtn.addEventListener('click', () => {
      guideModal.classList.add('hidden');
      localStorage.setItem('lx_guide_shown', 'true');
    });
  }
}

// Subtitle view configuration
function loadSubSettings() {
  const saved = localStorage.getItem('lx_show_subtitles');
  if (saved !== null) {
    state.showSubtitles = saved === 'true';
  }
  updateSubButtons();
}

function updateSubButtons() {
  if (state.showSubtitles) {
    elements.modeSub.classList.add('active');
    elements.modeLrc.classList.remove('active');
  } else {
    elements.modeLrc.classList.add('active');
    elements.modeSub.classList.remove('active');
  }
  renderLyrics();
}

// Show auth modal overlay
function showAuth() {
  elements.authModal.classList.remove('hidden');
  elements.offlineOverlay.classList.add('hidden');
  elements.tokenInput.focus();
}

// Hide auth modal overlay
function hideAuth() {
  elements.authModal.classList.add('hidden');
}

// Helper to require authorization before running control actions
function requireUnlock(action) {
  if (state.controlsUnlocked) {
    action();
  } else {
    showAuth();
  }
}

// Update lock button style and tooltip
function updateLockBtnUI() {
  if (!state.authRequired) {
    elements.lockBtn.classList.add('hidden');
    return;
  }
  elements.lockBtn.classList.remove('hidden');
  
  if (state.controlsUnlocked) {
    elements.lockBtn.classList.add('unlocked');
    elements.lockBtn.innerHTML = '<i class="fas fa-lock-open"></i>';
    elements.lockBtn.title = "已解锁控制权 (点击重新锁定)";
  } else {
    elements.lockBtn.classList.remove('unlocked');
    elements.lockBtn.innerHTML = '<i class="fas fa-lock"></i>';
    elements.lockBtn.title = "控制权已锁定 (点击输入密码解锁)";
  }
}

// Show offline screen
function showOffline(isOffline) {
  if (isOffline) {
    elements.offlineOverlay.classList.remove('hidden');
    elements.statusBadge.innerHTML = '<span class="pulse-dot"></span>离线';
    elements.statusBadge.classList.remove('online');
    clearInterval(progressInterval);
    
    // Stop local audio sync if we go offline
    if (state.isSyncAudioPlaying) {
      toggleSyncAudio(false);
    }
    
    // Toggles last played info
    handleLastPlayedDisplay();
  } else {
    elements.offlineOverlay.classList.add('hidden');
    elements.statusBadge.innerHTML = '<span class="pulse-dot"></span>在线';
    elements.statusBadge.classList.add('online');
  }
}

// Setup Event Listeners
function setupEventListeners() {
  // Auth validation events
  elements.authBtn.addEventListener('click', handleAuth);
  elements.tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAuth();
  });
  elements.closeAuthModalBtn.addEventListener('click', hideAuth);
  
  // Lock / Unlock button click
  elements.lockBtn.addEventListener('click', () => {
    if (state.controlsUnlocked) {
      state.controlsUnlocked = false;
      state.token = '';
      localStorage.removeItem('lx_web_token');
      updateLockBtnUI();
    } else {
      showAuth();
    }
  });

  // Reconnect button
  elements.reconnectBtn.addEventListener('click', () => {
    showOffline(false);
    startConnection();
  });

  // Playback controls
  elements.playPauseBtn.addEventListener('click', () => {
    requireUnlock(() => {
      const action = state.status === 'playing' ? 'pause' : 'play';
      sendControl(action);
    });
  });
  elements.prevBtn.addEventListener('click', () => {
    requireUnlock(() => sendControl('skip-prev'));
  });
  elements.nextBtn.addEventListener('click', () => {
    requireUnlock(() => sendControl('skip-next'));
  });
  
  // Like/Collect star
  elements.collectBtn.addEventListener('click', () => {
    requireUnlock(() => {
      const action = state.collect ? 'uncollect' : 'collect';
      sendControl(action);
    });
  });

  // Mute button
  elements.muteBtn.addEventListener('click', () => {
    requireUnlock(() => {
      sendControl('mute', { mute: !state.mute });
    });
  });

  // Volume slider input
  elements.volumeInput.addEventListener('input', (e) => {
    const val = e.target.value;
    if (!state.controlsUnlocked) {
      updateVolumeUI(state.volume, state.mute);
      showAuth();
    } else {
      updateVolumeUI(val, state.mute);
    }
  });
  elements.volumeInput.addEventListener('change', (e) => {
    const val = e.target.value;
    requireUnlock(() => {
      sendControl('volume', { volume: val });
    });
  });

  // Progress Bar click to seek
  elements.progressBarWrap.addEventListener('click', (e) => {
    requireUnlock(() => {
      if (!state.duration) return;
      const rect = elements.progressBarWrap.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const width = rect.width;
      const percentage = Math.max(0, Math.min(1, clickX / width));
      const offset = percentage * state.duration;
      
      updateProgressUI(offset);
      sendControl('seek', { offset: offset.toFixed(2) });
    });
  });

  // Lyrics view mode toggles
  elements.modeLrc.addEventListener('click', () => {
    state.showSubtitles = false;
    localStorage.setItem('lx_show_subtitles', 'false');
    updateSubButtons();
  });
  elements.modeSub.addEventListener('click', () => {
    state.showSubtitles = true;
    localStorage.setItem('lx_show_subtitles', 'true');
    updateSubButtons();
  });

  // Right card Tab selectors (Lyrics vs Stats vs Point-Song Request)
  elements.tabLyrics.addEventListener('click', () => {
    state.currentTab = 'lyrics';
    elements.tabLyrics.classList.add('active');
    elements.tabStats.classList.remove('active');
    elements.tabRequest.classList.remove('active');
    elements.lyricsContainer.classList.remove('hidden');
    elements.lyricModeSelector.classList.remove('hidden');
    elements.statsContainer.classList.add('hidden');
    elements.requestContainer.classList.add('hidden');
    renderLyrics();
  });

  elements.tabStats.addEventListener('click', () => {
    state.currentTab = 'stats';
    elements.tabStats.classList.add('active');
    elements.tabLyrics.classList.remove('active');
    elements.tabRequest.classList.remove('active');
    elements.lyricsContainer.classList.add('hidden');
    elements.lyricModeSelector.classList.add('hidden');
    elements.statsContainer.classList.remove('hidden');
    elements.requestContainer.classList.add('hidden');
    renderStats();
  });

  elements.tabRequest.addEventListener('click', () => {
    state.currentTab = 'request';
    elements.tabRequest.classList.add('active');
    elements.tabLyrics.classList.remove('active');
    elements.tabStats.classList.remove('active');
    elements.lyricsContainer.classList.add('hidden');
    elements.lyricModeSelector.classList.add('hidden');
    elements.statsContainer.classList.add('hidden');
    elements.requestContainer.classList.remove('hidden');
    fetchQueue();
  });

  // Sync Audio Headphones click handler
  elements.syncAudioBtn.addEventListener('click', () => {
    toggleSyncAudio(!state.isSyncAudioPlaying);
  });

  // Sync Audio tag error listener (Trigger warning popup if client browser blocks audio load)
  elements.syncAudio.addEventListener('error', () => {
    if (state.isSyncAudioPlaying && elements.syncAudio.src) {
      showAudioFailureModal(state.name, state.singer);
      elements.syncAudioBtn.innerHTML = '<i class="fas fa-headphones-simple"></i>';
    }
  });

  // Music Search Actions inside Request Tab
  elements.songSearchBtn.addEventListener('click', performMusicSearch);
  elements.songSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performMusicSearch();
  });
}

// Handle login token verification
async function handleAuth() {
  const token = elements.tokenInput.value.trim();
  if (!token) return;

  elements.authError.innerText = '';
  
  try {
    const res = await fetch(`/api/verify-token?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (data.success) {
      state.token = token;
      state.controlsUnlocked = true;
      localStorage.setItem('lx_web_token', token);
      elements.tokenInput.value = '';
      hideAuth();
      updateLockBtnUI();
      // Re-fetch queue to render delete buttons if applicable
      if (state.currentTab === 'request') fetchQueue();
    } else {
      elements.authError.innerText = '密码错误，请重试';
    }
  } catch (err) {
    elements.authError.innerText = '无法连接至代理服务器';
  }
}

// Send control command to backend
async function sendControl(endpoint, params = {}) {
  const queryParams = new URLSearchParams(params);
  if (state.token) {
    queryParams.append('token', state.token);
  }
  const queryStr = queryParams.toString();
  const url = `/${endpoint}${queryStr ? `?${queryStr}` : ''}`;
  
  try {
    const res = await fetch(url);
    if (res.status === 401) {
      showAuth();
      return;
    }
    if (!res.ok) {
      console.warn(`Control ${endpoint} failed:`, await res.text());
    }
  } catch (err) {
    console.error(`Control error for ${endpoint}:`, err);
  }
}

// Start SSE stream listener and fetch initial state
async function startConnection() {
  if (eventSource) {
    eventSource.close();
  }
  
  // Fetch initial status to build the UI immediately
  try {
    const res = await fetch('/status');
    if (res.status === 200) {
      const data = await res.json();
      updatePlayerState(data);
      showOffline(false);
    } else {
      showOffline(true);
    }
  } catch (err) {
    showOffline(true);
  }

  // Connect via SSE
  const filterParams = 'status,name,singer,albumName,duration,progress,playbackRate,picUrl,lyric,tlyric,rlyric,lxlyric,collect,volume,mute';
  const sseUrl = `/subscribe-player-status?filter=${filterParams}`;
  
  eventSource = new EventSource(sseUrl);
  
  const events = [
    'status', 'name', 'singer', 'albumName', 'duration', 'progress', 
    'playbackRate', 'picUrl', 'lyric', 'tlyric', 'rlyric', 'lxlyric', 'collect', 'volume', 'mute'
  ];

  events.forEach(eventName => {
    eventSource.addEventListener(eventName, (e) => {
      let data = e.data;
      if (data.startsWith('"') && data.endsWith('"')) {
        try { data = JSON.parse(data); } catch {}
      } else if (data === 'true' || data === 'false') {
        data = data === 'true';
      } else if (!isNaN(data) && data !== '') {
        data = parseFloat(data);
      }
      
      const updates = {};
      updates[eventName] = data;
      updatePlayerState(updates);
    });
  });

  eventSource.onopen = () => {
    console.log('SSE connection successfully opened');
    showOffline(false);
    clearTimeout(reconnectTimeout);
  };

  eventSource.onerror = (e) => {
    console.error('SSE Connection failed:', e);
    showOffline(true);
    eventSource.close();
    
    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(startConnection, 5000);
  };
}

// Update local player state with differential updates
function updatePlayerState(updates) {
  let lyricsChanged = false;
  let progressChanged = false;
  let trackChanged = false;

  for (const [key, val] of Object.entries(updates)) {
    if (state[key] !== val) {
      state[key] = val;
      
      if (key === 'lyric' || key === 'tlyric' || key === 'rlyric' || key === 'lxlyric') {
        lyricsChanged = true;
      }
      if (key === 'progress') {
        progressChanged = true;
      }
      if (key === 'name' || key === 'singer') {
        trackChanged = true;
        queueTriggeredForCurrentSong = false; // Reset trigger state for new track
      }
    }
  }

  // Handle track metadata changes
  if (updates.name !== undefined || updates.singer !== undefined || updates.albumName !== undefined) {
    elements.trackTitle.innerText = state.name || '等待播放';
    elements.trackArtist.innerText = state.singer || '未知艺术家';
    elements.trackAlbum.innerText = state.albumName ? `《${state.albumName}》` : '未知专辑';
  }

  if (updates.status !== undefined) {
    updatePlayStateUI(state.status);
    handleLastPlayedDisplay();
    
    // Sync Playback State to local Audio player
    if (state.isSyncAudioPlaying) {
      if (state.status === 'playing') {
        elements.syncAudio.play().catch(() => {});
      } else {
        elements.syncAudio.pause();
      }
    }
  }

  if (updates.duration !== undefined) {
    elements.totalTime.innerText = formatTime(state.duration);
  }

  if (progressChanged) {
    // SSE progress 事件只刷新本地推算基准（state.progress + state.lastUpdate）
    // UI 由 startProgressTicker 的本地 100ms ticker 平滑驱动，避免双重驱动抖动
    state.lastUpdate = Date.now();
  }

  // Cover Art updates with smooth cross-fade animation
  if (updates.picUrl !== undefined) {
    const fallbackArt = 'https://picsum.photos/400/400?blur=10';
    const finalUrl = state.picUrl || fallbackArt;
    
    elements.albumArt.classList.add('fading');
    setTimeout(() => {
      elements.albumArt.src = finalUrl;
      elements.bgBlur.style.backgroundImage = `url('${finalUrl}')`;
      
      elements.albumArt.onload = () => {
        elements.albumArt.classList.remove('fading');
      };
    }, 400);
  }

  if (updates.collect !== undefined) {
    if (state.collect) {
      elements.collectBtn.classList.add('collected');
      elements.collectBtn.querySelector('i').className = 'fas fa-star';
    } else {
      elements.collectBtn.classList.remove('collected');
      elements.collectBtn.querySelector('i').className = 'far fa-star';
    }
  }

  if (updates.volume !== undefined || updates.mute !== undefined) {
    updateVolumeUI(state.volume, state.mute);
  }

  if (lyricsChanged) {
    parseAndPrepareLyrics();
  }

  // Listening stats tracker hook
  if (state.status === 'playing' && state.name && state.singer) {
    const trackId = `${state.name} - ${state.singer}`;
    if (trackId !== currentSongTrackId) {
      // 切歌了：重置本地 ticker 基准，将进度对齐到 SSE 当前快照值
      currentSongTrackId = trackId;
      playRegistered = false;
      playStartTime = Date.now();
      lastTickTime = Date.now();
      // 切歌时做一次对齐：用当前收到的 progress 快照 + 网络传输时间差补唇
      const latencyComp = (Date.now() - state.lastUpdate) / 1000;
      const alignedProgress = state.progress + latencyComp * (state.playbackRate || 1.0);
      state.progress = alignedProgress;
      state.lastUpdate = Date.now();
      updateProgressUI(alignedProgress); // 只在切歌时强制对齐一次

      // Auto-load new online audio stream URL if in 同步收听 mode
      if (state.isSyncAudioPlaying) {
        loadAndSyncAudioUrl();
      }
    }
    
    // Cache current track state for offline "last played" retrieval
    saveLastPlayedState();
  }

  // Hook to update desktop pet visual states
  if (window.checkPetStateUpdates) {
    window.checkPetStateUpdates();
  }
}

// Update Play State Button, CD spin, and audio visualizer
function updatePlayStateUI(status) {
  const isPlaying = status === 'playing';
  
  if (isPlaying) {
    elements.playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
    elements.albumArtWrap.classList.add('playing');
    elements.playStateIndicator.innerHTML = '<i class="fas fa-pause"></i>';
    
    startProgressTicker();
  } else {
    elements.playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
    elements.albumArtWrap.classList.remove('playing');
    elements.playStateIndicator.innerHTML = '<i class="fas fa-play"></i>';
    
    clearInterval(progressInterval);
  }
}

// Local progress ticker with Stats tracking
function startProgressTicker() {
  clearInterval(progressInterval);
  lastTickTime = Date.now();
  
  progressInterval = setInterval(() => {
    if (state.status !== 'playing') return;
    
    const now = Date.now();
    const deltaSeconds = (now - lastTickTime) / 1000;
    lastTickTime = now;
    
    // 核心修复：如果在同步收听模式下，以本地正在播放的 Audio 进度为绝对基准，绝不采用网络包，防止歌词和进度条发生鬼扯拉扯
    let currentProgress;
    if (state.isSyncAudioPlaying && elements.syncAudio.src) {
      currentProgress = elements.syncAudio.currentTime;
    } else {
      const elapsed = (now - state.lastUpdate) / 1000;
      currentProgress = state.progress + elapsed * state.playbackRate;
    }
    
    if (currentProgress <= state.duration) {
      updateProgressUI(currentProgress);
      syncLyricsScroll(currentProgress);
    }
    
    // Accumulate total Duration into local statistics database
    trackListeningDuration(deltaSeconds);
    
    // Auto-progress to next queued song when current track is ending
    if (state.controlsUnlocked && state.duration > 0 && currentProgress >= state.duration - 1.2 && !queueTriggeredForCurrentSong) {
      queueTriggeredForCurrentSong = true;
      checkAndPlayNextQueuedSong();
    }
  }, 100);
}

// Update progress bar
function updateProgressUI(time) {
  if (state.isSeeking) return;
  
  elements.currentTime.innerText = formatTime(time);
  const pct = state.duration ? (time / state.duration) * 100 : 0;
  elements.progressBarFill.style.width = `${pct}%`;
  elements.progressHandle.style.left = `${pct}%`;
}

// Update volume elements
function updateVolumeUI(volume, mute) {
  elements.volumeInput.value = volume;
  elements.volumeVal.innerText = `${volume}%`;
  
  if (mute || volume === 0) {
    elements.muteBtn.innerHTML = '<i class="fas fa-volume-xmark"></i>';
    elements.volumeSliderFill.style.width = '0%';
  } else {
    elements.volumeSliderFill.style.width = `${volume}%`;
    if (volume < 40) {
      elements.muteBtn.innerHTML = '<i class="fas fa-volume-low"></i>';
    } else {
      elements.muteBtn.innerHTML = '<i class="fas fa-volume-high"></i>';
    }
  }
}

// Formats seconds into mm:ss
function formatTime(secs) {
  if (isNaN(secs) || secs === null) return '00:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Standard LRC Lyric Parsing
function parseLRC(lrcText) {
  if (!lrcText) return [];
  const lines = lrcText.split('\n');
  const lyrics = [];
  const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;
  
  for (const line of lines) {
    timeRegex.lastIndex = 0;
    const matches = [];
    let match;
    while ((match = timeRegex.exec(line)) !== null) {
      matches.push(match);
    }
    
    if (matches.length === 0) continue;
    
    const text = line.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim();
    
    for (const m of matches) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const ms = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      const time = min * 60 + sec + ms / 1000;
      lyrics.push({ time, text });
    }
  }
  
  lyrics.sort((a, b) => a.time - b.time);
  return lyrics;
}

// Parse Any Listen Karaoke lyrics line
function parseLXLine(lineText) {
  const timeRegex = /^\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/;
  const match = timeRegex.exec(lineText);
  if (!match) return null;
  
  const min = parseInt(match[1], 10);
  const sec = parseInt(match[2], 10);
  const ms = match[3] ? parseInt(match[3].padEnd(3, '0').slice(0, 3), 10) : 0;
  const time = min * 60 + sec + ms / 1000;
  
  const content = lineText.replace(timeRegex, '').trim();
  const charRegex = /<(\d+),(\d+)>([^<]+)/g;
  
  const words = [];
  let charMatch;
  while ((charMatch = charRegex.exec(content)) !== null) {
    const startOffset = parseInt(charMatch[1], 10) / 1000; // relative to line start (seconds)
    const duration = parseInt(charMatch[2], 10) / 1000;
    const text = charMatch[3];
    words.push({ startOffset, duration, text });
  }
  
  const plainText = content.replace(/<\d+,\d+>/g, '');
  return { time, words, text: plainText };
}

// Parse full Any Listen lxlyric script
function parseLXLyric(lxText) {
  if (!lxText) return [];
  const lines = lxText.split('\n');
  const result = [];
  for (const line of lines) {
    const parsed = parseLXLine(line);
    if (parsed) result.push(parsed);
  }
  return result;
}

// Parse lyrics and translations (Supports both Any Listen Karaoke and simulated sweeps)
function parseAndPrepareLyrics() {
  let main = [];
  
  // Try lxlyric (Any Listen) first
  if (state.lxlyric) {
    main = parseLXLyric(state.lxlyric);
  }
  
  // Fall back to standard LRC
  if (main.length === 0) {
    main = parseLRC(state.lyric);
  }
  
  const trans = parseLRC(state.tlyric);
  const roman = parseLRC(state.rlyric);
  
  const findMatch = (time, list) => {
    return list.find(item => Math.abs(item.time - time) < 0.15);
  };
  
  state.parsedLyrics = main.map((item, index) => {
    const tMatch = findMatch(item.time, trans);
    const rMatch = findMatch(item.time, roman);
    
    // Fallback: If no word timing exists (standard LRC), simulate word sweeps
    let words = item.words || [];
    if (words.length === 0 && item.text) {
      let duration = 4.0; // last line default
      if (index < main.length - 1) {
        duration = main[index + 1].time - item.time;
      }
      duration = Math.max(0.5, Math.min(6.0, duration)); // clamp 0.5s - 6s
      
      // Split into tokens: for English split by word boundaries keeping spaces;
      // for CJK split character by character.
      const isCJK = /[\u3040-\u9fff]/.test(item.text);
      let tokens;
      if (isCJK) {
        tokens = item.text.split('');
      } else {
        // Split into words + preserve spaces as separate tokens
        tokens = item.text.split(/(\s+)/).filter(t => t.length > 0);
      }
      const tokenDuration = duration / tokens.length;
      words = tokens.map((token, tokenIdx) => ({
        startOffset: tokenIdx * tokenDuration,
        duration: tokenDuration,
        text: token
      }));
    }
    
    return {
      time: item.time,
      text: item.text,
      words: words,
      translation: tMatch ? tMatch.text : '',
      romanization: rMatch ? rMatch.text : ''
    };
  });

  state.activeLyricIndex = -1;
  renderLyrics();
}

// Render lyrics with Karaoke span elements
function renderLyrics() {
  elements.lyricsWrapper.innerHTML = '';
  
  if (state.parsedLyrics.length === 0) {
    elements.lyricsWrapper.innerHTML = '<div class="lyric-line placeholder">暂无歌词</div>';
    cachedKaraokeWords = []; // clear performance cache
    return;
  }
  
  state.parsedLyrics.forEach((line, index) => {
    const lineEl = document.createElement('div');
    lineEl.className = 'lyric-line';
    lineEl.dataset.index = index;
    lineEl.dataset.time = line.time;
    
    // Generate Karaoke character spans
    let wordsHtml = '';
    line.words.forEach((word) => {
      const wordStart = line.time + word.startOffset;
      const wordEnd = wordStart + word.duration;
      const isSpace = /^\s+$/.test(word.text);
      
      if (isSpace) {
        // Render whitespace as a space-holder span (not a gradient clip)
        wordsHtml += `<span class="karaoke-space" data-start="${wordStart}" data-end="${wordEnd}" data-duration="${word.duration}">\u00a0</span>`;
      } else {
        const isLongTone = word.duration > 0.6 ? 'long-tone' : '';
        wordsHtml += `<span class="karaoke-word ${isLongTone}" data-start="${wordStart}" data-end="${wordEnd}" data-duration="${word.duration}">${word.text}</span>`;
      }
    });
    
    let content = `<span class="karaoke-line-container">${wordsHtml}</span>`;
    
    if (state.showSubtitles) {
      if (line.translation) {
        content += `<div class="lyric-sub translation">${line.translation}</div>`;
      }
      if (line.romanization) {
        content += `<div class="lyric-sub romanization">${line.romanization}</div>`;
      }
    }
    
    lineEl.innerHTML = content;
    
    // Seek to lyric line
    lineEl.addEventListener('click', () => {
      requireUnlock(() => {
        sendControl('seek', { offset: line.time.toFixed(2) });
        updateProgressUI(line.time);
      });
    });
    
    elements.lyricsWrapper.appendChild(lineEl);
  });

  // Re-cache word spans immediately to avoid running DOM queries in requestAnimationFrame
  cachedKaraokeWords = Array.from(elements.lyricsWrapper.querySelectorAll('.karaoke-word'));
}

// Real-time high frequency loop to update character-level sweeping highlights (DOM cache optimized)
function updateKaraokeHighlight() {
  if (state.status !== 'playing' || state.currentTab !== 'lyrics') {
    requestAnimationFrame(updateKaraokeHighlight);
    return;
  }
  
  // 核心修复：歌词高亮同样在同步收听下以本地 Audio 进度为绝对基准
  let currentTime;
  if (state.isSyncAudioPlaying && elements.syncAudio.src) {
    currentTime = elements.syncAudio.currentTime;
  } else {
    const elapsed = (Date.now() - state.lastUpdate) / 1000;
    currentTime = state.progress + elapsed * state.playbackRate;
  }
  
  const words = cachedKaraokeWords;
  const count = words.length;
  
  for (let i = 0; i < count; i++) {
    const word = words[i];
    const start = parseFloat(word.dataset.start);
    const end = parseFloat(word.dataset.end);
    const duration = parseFloat(word.dataset.duration);
    
    let progress = 0;
    if (currentTime >= end) {
      progress = 100;
      word.classList.remove('active-glow');
    } else if (currentTime < start) {
      progress = 0;
      word.classList.remove('active-glow');
    } else {
      progress = ((currentTime - start) / duration) * 100;
      word.classList.add('active-glow'); // Dynamic active character glow
    }
    
    word.style.setProperty('--progress', `${progress}%`);
  }
  
  requestAnimationFrame(updateKaraokeHighlight);
}

// Scroll active lyric to vertical center of panel (with perspective 3D rotation)
function syncLyricsScroll(time) {
  if (state.parsedLyrics.length === 0 || state.currentTab !== 'lyrics') return;
  
  let activeIndex = -1;
  for (let i = 0; i < state.parsedLyrics.length; i++) {
    if (state.parsedLyrics[i].time <= time) {
      activeIndex = i;
    } else {
      break;
    }
  }
  
  if (activeIndex !== state.activeLyricIndex) {
    state.activeLyricIndex = activeIndex;
  }
  
  const lines = elements.lyricsWrapper.querySelectorAll('.lyric-line');
  const containerHeight = elements.lyricsContainer.clientHeight;
  
  lines.forEach((line, i) => {
    const diff = i - activeIndex;
    
    line.classList.remove('active');
    if (diff === 0) {
      line.classList.add('active');
    }
    
    // 3D Perspective Roll & Fade-out calculations
    const absDiff = Math.abs(diff);
    const opacity = 1 - Math.min(0.85, absDiff * 0.18);
    const rotateX = diff * 7; // Tilt away
    const translateZ = -absDiff * 22; // Push back
    
    line.style.opacity = opacity;
    line.style.transform = `rotateX(${rotateX}deg) translateZ(${translateZ}px)`;
  });
  
  // Center scroll
  if (activeIndex !== -1) {
    const activeEl = lines[activeIndex];
    if (activeEl) {
      const activeTop = activeEl.offsetTop;
      const activeHeight = activeEl.clientHeight;
      const scrollOffset = containerHeight / 2 - activeTop - activeHeight / 2;
      elements.lyricsWrapper.style.transform = `translateY(${scrollOffset}px)`;
    }
  } else {
    elements.lyricsWrapper.style.transform = `translateY(0px)`;
  }
}

/* ==========================================
   TIME & REAL-TIME WUHAN WEATHER WIDGETS
   ========================================== */

let serverTimeOffset = 0; // ms offset between local system time and internet Beijing Time

async function syncTimeOffset() {
  try {
    const start = Date.now();
    const res = await fetch('/api/time');
    const data = await res.json();
    
    // HTTP latency compensation (half of RTT)
    const latency = (Date.now() - start) / 2;
    const internetTime = data.unixtime + latency;
    serverTimeOffset = internetTime - Date.now();
    console.log(`Internet time sync completed. Offset: ${serverTimeOffset}ms`);
  } catch (err) {
    console.error('Failed to synchronize internet time:', err);
  }
}

async function initTimeWidget() {
  // Sync offset once initially
  await syncTimeOffset();
  
  // Periodically re-sync every 30 minutes to correct clock drifts
  setInterval(syncTimeOffset, 30 * 60 * 1000);

  const updateTime = () => {
    // Current time compensated with Beijing Time offset
    const now = new Date(Date.now() + serverTimeOffset);
    
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    elements.widgetTime.innerText = `${hours}:${minutes}:${seconds}`;
    
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const date = now.getDate();
    const dayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const day = dayNames[now.getDay()];
    elements.widgetDate.innerText = `${year}年${month}月${date}日 ${day}`;
  };
  
  updateTime();
  timeInterval = setInterval(updateTime, 1000);
}

async function fetchWeather() {
  try {
    const res = await fetch('/api/weather');
    const data = await res.json();
    
    elements.weatherTemp.innerText = data.temp;
    const translated = translateWeather(data.desc);
    elements.weatherDesc.innerText = translated;
    
    elements.weatherIcon.innerHTML = getWeatherIconHTML(data.desc);
    updateWeatherEffects(data.desc);
  } catch (err) {
    console.error('Weather load error:', err);
  }
}

function translateWeather(desc) {
  const d = desc.toLowerCase();
  if (d.includes('sunny') || d.includes('clear')) return '晴朗';
  if (d.includes('partly cloudy')) return '多云';
  if (d.includes('cloudy') || d.includes('overcast')) return '阴天';
  if (d.includes('mist') || d.includes('fog')) return '有雾';
  if (d.includes('patchy rain') || d.includes('drizzle') || d.includes('light rain')) return '局部小雨';
  if (d.includes('heavy rain') || d.includes('moderate rain') || d.includes('shower')) return '下雨';
  if (d.includes('thunderstorm') || d.includes('storm')) return '雷阵雨';
  if (d.includes('snow') || d.includes('flurry') || d.includes('sleet')) return '雪天';
  return desc;
}

function getWeatherIconHTML(desc) {
  const d = desc.toLowerCase();
  if (d.includes('sunny') || d.includes('clear')) return '<i class="fas fa-sun"></i>';
  if (d.includes('partly cloudy')) return '<i class="fas fa-cloud-sun"></i>';
  if (d.includes('cloudy') || d.includes('overcast')) return '<i class="fas fa-cloud"></i>';
  if (d.includes('mist') || d.includes('fog') || d.includes('smog')) return '<i class="fas fa-smog"></i>';
  if (d.includes('rain') || d.includes('drizzle') || d.includes('shower')) return '<i class="fas fa-cloud-showers-heavy"></i>';
  if (d.includes('thunderstorm') || d.includes('storm')) return '<i class="fas fa-cloud-bolt"></i>';
  if (d.includes('snow') || d.includes('flurry')) return '<i class="fas fa-snowflake"></i>';
  return '<i class="fas fa-cloud-sun"></i>';
}

/* ==========================================
   WEATHER EFFECTS CANVAS PARTICLE SYSTEM
   ========================================== */

function initWeatherCanvas() {
  canvas = document.getElementById('weatherCanvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  createParticles();
  
  window.addEventListener('resize', handleResize);
  
  animateParticles();
}

function handleResize() {
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    createParticles();
  }, 200);
}

function createParticles() {
  particles = [];
  const count = weatherType === 'rain' ? 70 : (weatherType === 'snow' ? 50 : (weatherType === 'clouds' ? 4 : 35));
  for (let i = 0; i < count; i++) {
    particles.push(resetParticle({}));
  }
}

function resetParticle(p) {
  p.x = Math.random() * canvas.width;
  
  if (weatherType === 'rain') {
    p.y = Math.random() * -canvas.height;
    p.vy = 7 + Math.random() * 5;
    p.vx = -1 - Math.random() * 2;
    p.length = 12 + Math.random() * 15;
    p.width = 1 + Math.random() * 0.8;
    p.alpha = 0.15 + Math.random() * 0.25;
  } else if (weatherType === 'snow') {
    p.y = Math.random() * -canvas.height;
    p.vy = 0.8 + Math.random() * 1.5;
    p.vx = -0.5 + Math.random() * 1;
    p.radius = 1.2 + Math.random() * 2.5;
    p.alpha = 0.2 + Math.random() * 0.45;
    p.swaySpeed = 0.01 + Math.random() * 0.02;
    p.swayOffset = Math.random() * Math.PI * 2;
  } else if (weatherType === 'clouds') {
    p.y = Math.random() * canvas.height * 0.6;
    p.vx = 0.08 + Math.random() * 0.15;
    p.vy = 0;
    p.radius = 90 + Math.random() * 100;
    p.alpha = 0.04 + Math.random() * 0.05;
  } else {
    p.y = Math.random() * canvas.height;
    p.vx = -0.15 + Math.random() * 0.3;
    p.vy = -0.15 + Math.random() * 0.3;
    p.radius = 0.8 + Math.random() * 1.8;
    p.alpha = 0.12 + Math.random() * 0.35;
    p.swaySpeed = 0.01 + Math.random() * 0.02;
    p.swayOffset = Math.random() * Math.PI * 2;
  }
  return p;
}

function animateParticles() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  particles.forEach(p => {
    ctx.beginPath();
    
    if (weatherType === 'rain') {
      ctx.strokeStyle = `rgba(180, 220, 255, ${p.alpha})`;
      ctx.lineWidth = p.width;
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + p.vx * 1.2, p.y + p.length);
      ctx.stroke();
      
      p.y += p.vy;
      p.x += p.vx;
      
      if (p.y > canvas.height) resetParticle(p);
    } else if (weatherType === 'snow') {
      ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      
      p.y += p.vy;
      p.swayOffset += p.swaySpeed;
      p.x += p.vx + Math.sin(p.swayOffset) * 0.4;
      
      if (p.y > canvas.height || p.x < 0 || p.x > canvas.width) resetParticle(p);
    } else if (weatherType === 'clouds') {
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
      gradient.addColorStop(0, `rgba(255, 255, 255, ${p.alpha})`);
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gradient;
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      
      p.x += p.vx;
      if (p.x - p.radius > canvas.width) {
        p.x = -p.radius;
        p.y = Math.random() * canvas.height * 0.6;
      }
    } else {
      p.swayOffset += p.swaySpeed;
      const alphaPulse = p.alpha * (0.2 + 0.8 * Math.abs(Math.sin(p.swayOffset)));
      ctx.fillStyle = `rgba(167, 139, 250, ${alphaPulse})`;
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      
      p.x += p.vx;
      p.y += p.vy;
      
      if (p.x < 0 || p.x > canvas.width || p.y < 0 || p.y > canvas.height) resetParticle(p);
    }
  });
  
  animationId = requestAnimationFrame(animateParticles);
}

function updateWeatherEffects(desc) {
  const d = desc.toLowerCase();
  let type = 'stars';
  if (d.includes('rain') || d.includes('drizzle') || d.includes('shower') || d.includes('storm')) {
    type = 'rain';
  } else if (d.includes('snow') || d.includes('flurry') || d.includes('sleet')) {
    type = 'snow';
  } else if (d.includes('cloud') || d.includes('overcast') || d.includes('fog') || d.includes('mist') || d.includes('haze')) {
    type = 'clouds';
  }
  
  if (type !== weatherType) {
    weatherType = type;
    createParticles();
  }
}

/* ==========================================
   REAL-TIME STEREO AUDIO SPECTRUM VISUALIZER
   ========================================== */

function initSpectrum() {
  spectrumCanvas = document.getElementById('spectrumCanvas');
  if (!spectrumCanvas) return;
  spectrumCtx = spectrumCanvas.getContext('2d');
  
  spectrumCanvas.width = 280;
  spectrumCanvas.height = 40;
  
  drawSpectrum();
}

function drawSpectrum() {
  if (!spectrumCtx || !spectrumCanvas) return;
  
  spectrumCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
  
  const barCount = spectrumBars.length;
  const gap = 2.5;
  const barWidth = (spectrumCanvas.width - (barCount - 1) * gap) / barCount;
  const isPlaying = state.status === 'playing';
  
  for (let i = 0; i < barCount; i++) {
    const bar = spectrumBars[i];
    
    if (isPlaying) {
      const t = Date.now() * 0.0035;
      let baseVal = 2;
      let wave = 0;
      
      if (i < 5) {
        baseVal = 9;
        wave = Math.sin(t * 4.2 + i * 0.6) * 7 + Math.sin(t * 1.5) * 5;
      } else if (i < 18) {
        baseVal = 6;
        wave = Math.sin(t * 5.8 - i * 0.7) * 4.5 + Math.cos(t * 2.2) * 3;
      } else {
        baseVal = 3.5;
        wave = Math.sin(t * 8.5 + i * 1.2) * 3 + Math.sin(t * 3.8) * 1.5;
      }
      
      bar.target = Math.max(2, baseVal + wave);
      bar.val += (bar.target - bar.val) * 0.28;
    } else {
      bar.val += (1.5 - bar.val) * 0.08;
    }
    
    const gradient = spectrumCtx.createLinearGradient(0, spectrumCanvas.height, 0, 0);
    gradient.addColorStop(0, '#8b5cf6');
    gradient.addColorStop(1, '#06b6d4');
    
    spectrumCtx.fillStyle = gradient;
    
    const h = (bar.val / 20) * spectrumCanvas.height;
    const x = i * (barWidth + gap);
    const y = spectrumCanvas.height - h;
    
    drawRoundedRect(spectrumCtx, x, y, barWidth, h, 1.5);
  }
  
  requestAnimationFrame(drawSpectrum);
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  if (h < 2) h = 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

/* ==========================================
   OFFLINE / NOT PLAYING LAST STATE CACHE
   ========================================== */

function saveLastPlayedState() {
  const stateData = {
    name: state.name,
    singer: state.singer,
    albumName: state.albumName,
    duration: state.duration,
    progress: state.progress,
    picUrl: state.picUrl,
    timestamp: Date.now()
  };
  localStorage.setItem('lx_last_played', JSON.stringify(stateData));
}

function handleLastPlayedDisplay() {
  const isPlaying = state.status === 'playing';
  const isConnected = !elements.statusBadge.innerHTML.includes('离线');
  
  if (!isPlaying) {
    const saved = localStorage.getItem('lx_last_played');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        elements.lastPlayedInfo.classList.remove('hidden');
        
        const dateObj = new Date(data.timestamp);
        const today = new Date();
        let dateStr = '';
        const pad = (n) => n.toString().padStart(2, '0');
        if (dateObj.toDateString() === today.toDateString()) {
          dateStr = `今天 ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
        } else {
          dateStr = `${pad(dateObj.getMonth()+1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
        }
        
        elements.lastPlayedTime.innerText = dateStr;
        elements.lastPlayedTrack.innerText = `《${data.name}》 - ${data.singer}`;
        elements.lastPlayedProgress.innerText = formatTime(data.progress);
        
        if (!isConnected || state.status === 'stopped') {
          elements.trackTitle.innerText = data.name;
          elements.trackArtist.innerText = data.singer;
          elements.trackAlbum.innerText = data.albumName ? `《${data.albumName}》` : '未知专辑';
          elements.totalTime.innerText = formatTime(data.duration);
          updateProgressUI(data.progress);
          
          if (data.picUrl) {
            elements.albumArt.src = data.picUrl;
            elements.bgBlur.style.backgroundImage = `url('${data.picUrl}')`;
          }
        }
      } catch (err) {
        console.warn('Error reading last played stats:', err);
      }
    }
  } else {
    elements.lastPlayedInfo.classList.add('hidden');
  }
}

/* ==========================================
   LISTENING STATISTICS ENGINE
   ========================================== */

// Cached global stats loaded from server to avoid lag
let cachedStats = {
  totalDuration: 0,
  totalPlays: 0,
  artistCounts: {},
  trackCounts: {},
  hourlyPlays: Array(24).fill(0),
  dailyPlays: {}
};

async function syncStatsFromServer() {
  try {
    const res = await fetch('/api/stats');
    if (res.status === 200) {
      cachedStats = await res.json();
    }
  } catch (err) {
    console.error('Failed to sync listening stats from server:', err);
  }
}

// Perform initial sync on launch
syncStatsFromServer();

async function trackListeningDuration(deltaSeconds) {
  if (isNaN(deltaSeconds) || deltaSeconds <= 0) return;
  // Only the main playing browser or controller should upload stats, but to make sure
  // we count accurately without duplicates, we let any connected admin client post.
  // Actually, to make it clean, we only update duration if we unlocked control (meaning it's the notebook/admin)
  if (!state.controlsUnlocked) return;
  
  try {
    const res = await fetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trackDuration', deltaSeconds })
    });
    if (res.status === 200) {
      const data = await res.json();
      cachedStats = data.stats;
    }
  } catch (err) {
    console.error('Failed to update duration on server:', err);
  }
}



async function renderStats() {
  // Sync the latest statistics data from server before drawing stats tab
  await syncStatsFromServer();
  
  const stats = cachedStats;
  const totalHrs = (stats.totalDuration / 3600).toFixed(1);
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-`;
  let monthlyPlays = 0;
  for (const [date, count] of Object.entries(stats.dailyPlays)) {
    if (date.startsWith(monthPrefix)) {
      monthlyPlays += count;
    }
  }
  
  const activeDays = Object.keys(stats.dailyPlays).length;
  const topArtists = Object.entries(stats.artistCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
    
  const topTracks = Object.values(stats.trackCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const maxHourCount = Math.max(...stats.hourlyPlays, 1);

  let html = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">累计听歌时长</div>
        <div class="stat-value">${totalHrs}<span class="stat-unit">小时</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">本月已播歌曲</div>
        <div class="stat-value">${monthlyPlays}<span class="stat-unit">首</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">活跃听歌足迹</div>
        <div class="stat-value">${activeDays}<span class="stat-unit">天</span></div>
      </div>
    </div>
    
    <div class="stats-row">
      <div class="stats-list">
        <div class="stats-section-title"><i class="fas fa-microphone-lines"></i> 最常听歌手</div>
        ${topArtists.length === 0 ? '<div class="stats-item-sub">暂无统计数据</div>' : ''}
        ${topArtists.map(([name, count], index) => `
          <div class="stats-item">
            <div class="stats-item-left">
              <span class="stats-rank stats-rank-${index+1}">${index+1}</span>
              <span class="stats-item-name">${name}</span>
            </div>
            <span class="stats-item-count">${count}次</span>
          </div>
        `).join('')}
      </div>
      
      <div class="stats-list">
        <div class="stats-section-title"><i class="fas fa-music"></i> 最常听曲目</div>
        ${topTracks.length === 0 ? '<div class="stats-item-sub">暂无统计数据</div>' : ''}
        ${topTracks.map((song, index) => `
          <div class="stats-item">
            <div class="stats-item-left">
              <span class="stats-rank stats-rank-${index+1}">${index+1}</span>
              <div class="stats-item-info">
                <span class="stats-item-name">${song.title}</span>
                <span class="stats-item-sub">${song.artist}</span>
              </div>
            </div>
            <span class="stats-item-count">${song.count}次</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="stats-chart-wrap">
      <div class="stats-section-title"><i class="fas fa-chart-simple"></i> 活跃时段分布</div>
      <div class="chart-bars">
        ${stats.hourlyPlays.map((val, hour) => {
          const heightPct = (val / maxHourCount) * 100;
          const formattedHour = hour.toString().padStart(2, '0');
          return `
            <div class="chart-bar-container" title="${formattedHour}:00 - 播放 ${val} 次">
              <div class="chart-bar-fill" style="height: ${Math.max(heightPct, 3)}%"></div>
              <div class="chart-bar-label">${hour % 4 === 0 ? formattedHour : ''}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div style="font-size: 0.65rem; color: var(--text-dimmed); text-align: center; margin-top: 10px;">
      数据来源：LX Music Desktop Local API Bridge · 播放源：本地代理分发
    </div>
  `;
  
  elements.statsContainer.innerHTML = html;
}

/* ==========================================
   🎧 ONLINE AUDIO SYNCHRONIZATION SYSTEM
   ========================================== */

function toggleSyncAudio(shouldPlay) {
  state.isSyncAudioPlaying = shouldPlay;
  
  if (shouldPlay) {
    elements.syncAudioBtn.classList.add('syncing');
    elements.syncAudioBtn.title = "已开启同步收听 (点击关闭)";
    loadAndSyncAudioUrl();
  } else {
    elements.syncAudioBtn.classList.remove('syncing');
    elements.syncAudioBtn.title = "同步收听 (浏览器播放)";
    elements.syncAudio.pause();
    elements.syncAudio.src = '';
  }
}

async function loadAndSyncAudioUrl() {
  if (state.name === '等待播放') return;
  
  // Visual indicators
  elements.syncAudioBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  
  try {
    const res = await fetch(`/api/get-current-audio?name=${encodeURIComponent(state.name)}&singer=${encodeURIComponent(state.singer)}`);
    const data = await res.json();
    
    if (data.url) {
      elements.syncAudio.src = data.url;
      elements.syncAudio.load();
      
      // Align playhead to current state progress
      elements.syncAudio.currentTime = state.progress;
      
      // Match play state
      if (state.status === 'playing') {
        elements.syncAudio.play()
          .then(() => {
            elements.syncAudioBtn.innerHTML = '<i class="fas fa-headphones"></i>';
          })
          .catch((err) => {
            console.warn('Sync audio play blocked:', err);
            elements.syncAudioBtn.innerHTML = '<i class="fas fa-headphones-simple"></i>';
            if (err.name === 'NotAllowedError') {
              showToast('播放受限，请在页面任意位置点击以激活声音');
            } else {
              showAudioFailureModal(state.name, state.singer);
            }
          });
      } else {
        elements.syncAudio.pause();
        elements.syncAudioBtn.innerHTML = '<i class="fas fa-headphones"></i>';
      }
    } else {
      elements.syncAudioBtn.innerHTML = '<i class="fas fa-headphones-simple"></i>';
      elements.syncAudio.src = '';
      showAudioFailureModal(state.name, state.singer);
    }
  } catch (err) {
    console.error('Failed to sync audio link:', err);
    elements.syncAudioBtn.innerHTML = '<i class="fas fa-headphones-simple"></i>';
    showAudioFailureModal(state.name, state.singer);
  }
}

// Beautiful Glassmorphic pop-up modal for audio sync failure
// Translucent overlay warning on top of the left player panel for audio sync failures
function showAudioFailureModal(songName, artistName) {
  const existing = document.getElementById('audioFailureOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'audioFailureOverlay';
  overlay.className = 'left-panel-overlay';
  
  overlay.innerHTML = `
    <div class="left-panel-overlay-box">
      <div class="left-panel-overlay-icon">
        <i class="fas fa-headphones-simple"></i>
      </div>
      <div class="left-panel-overlay-title">🎧 同步收听受限</div>
      <div class="left-panel-overlay-text">
        歌曲《${songName}》由于版权保护或会员限制，网页端无法拉取播放源。
        已自动切至<b>「静音围观」</b>，歌词与 3D 动画将保持同步。
      </div>
      <button id="closeFailureOverlayBtn" class="left-panel-overlay-btn">我知道了</button>
    </div>
  `;
  
  const playerLeft = document.querySelector('.player-left');
  if (playerLeft) {
    playerLeft.appendChild(overlay);
  }
  
  document.getElementById('closeFailureOverlayBtn').addEventListener('click', () => {
    overlay.remove();
  });
}

// Simple absolute toast system
function showToast(msg) {
  const toast = document.createElement('div');
  toast.style.position = 'fixed';
  toast.style.bottom = '30px';
  toast.style.left = '50%';
  toast.style.transform = 'translateX(-50%) translateY(20px)';
  toast.style.background = 'rgba(8, 9, 20, 0.85)';
  toast.style.border = '1px solid rgba(139, 92, 246, 0.3)';
  toast.style.color = '#ffffff';
  toast.style.padding = '10px 20px';
  toast.style.borderRadius = '12px';
  toast.style.fontSize = '0.78rem';
  toast.style.fontWeight = '600';
  toast.style.zIndex = '9999';
  toast.style.opacity = '0';
  toast.style.transition = 'all 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
  toast.innerText = msg;
  
  document.body.appendChild(toast);
  
  // animate enter
  setTimeout(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  }, 50);
  
  // animate leave
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3500);
}

/* ==========================================
   🤝 VISITOR INTERACTIVE SONG REQUESTS
   ========================================== */

async function performMusicSearch() {
  const kw = elements.songSearchInput.value.trim();
  if (!kw) return;
  
  elements.songSearchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  
  try {
    const res = await fetch(`/api/search-music?keyword=${encodeURIComponent(kw)}`);
    const data = await res.json();
    
    elements.songSearchBtn.innerHTML = '<i class="fas fa-magnifying-glass"></i> 搜索';
    elements.searchResultsSection.classList.remove('hidden');
    elements.searchResultsList.innerHTML = '';
    
    if (data.songs && data.songs.length > 0) {
      data.songs.forEach(song => {
        const item = document.createElement('div');
        item.className = 'search-item';
        
        item.innerHTML = `
          <div class="song-info">
            <span class="song-name">${song.name}</span>
            <span class="song-artist">${song.singer}</span>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="request-item-btn queue-btn" data-name="${encodeURIComponent(song.name)}" data-singer="${encodeURIComponent(song.singer)}" data-songmid="${song.songmid}">
              <i class="fas fa-plus"></i> 点歌
            </button>
            <button class="request-item-btn cut-in-btn" data-name="${encodeURIComponent(song.name)}" data-singer="${encodeURIComponent(song.singer)}" data-songmid="${song.songmid}" style="background: rgba(6, 182, 212, 0.1); border-color: rgba(6, 182, 212, 0.25); color: #22d3ee;">
              <i class="fas fa-bolt"></i> 切歌
            </button>
          </div>
        `;
        
        // Add click listener for enqueuing song
        item.querySelector('.queue-btn').addEventListener('click', (e) => {
          const btn = e.currentTarget;
          requestSong(
            decodeURIComponent(btn.dataset.name),
            decodeURIComponent(btn.dataset.singer),
            btn.dataset.songmid,
            false
          );
        });

        // Add click listener for cutting in immediately
        item.querySelector('.cut-in-btn').addEventListener('click', (e) => {
          const btn = e.currentTarget;
          requestSong(
            decodeURIComponent(btn.dataset.name),
            decodeURIComponent(btn.dataset.singer),
            btn.dataset.songmid,
            true
          );
        });
        
        elements.searchResultsList.appendChild(item);
      });
    } else {
      elements.searchResultsList.innerHTML = '<div class="queue-placeholder">没有找到相关歌曲，换个词搜搜吧~</div>';
    }
  } catch (err) {
    console.error('Search failed:', err);
    elements.songSearchBtn.innerHTML = '<i class="fas fa-magnifying-glass"></i> 搜索';
    showToast('搜索服务出错，请稍后重试');
  }
}

async function requestSong(name, singer, songmid, playNow = false) {
  const endpoint = playNow ? '/api/request-song-now' : '/api/request-song';
  try {
    const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&singer=${encodeURIComponent(singer)}&songmid=${songmid}&source=wy`);
    const data = await res.json();
    
    if (data.success) {
      if (playNow) {
        showToast(`正在切歌并播放：《${name}》`);
      } else {
        showToast(`点歌成功：${name} - ${singer} 已加入待播队列`);
        renderQueue(data.queue);
      }
    } else {
      showToast(data.error || '点歌失败');
    }
  } catch (err) {
    console.error('Request song failed:', err);
    showToast('点歌请求发送失败');
  }
}

async function checkAndPlayNextQueuedSong() {
  try {
    const res = await fetch('/api/pop-next-queued-song');
    const data = await res.json();
    if (data.song) {
      triggerLocalScheme(data.song);
    }
  } catch (err) {
    console.error('Failed to check and play next queued song:', err);
  }
}

async function fetchQueue() {
  try {
    const res = await fetch('/api/get-queue');
    const data = await res.json();
    renderQueue(data.queue);
  } catch (err) {
    console.error('Failed to get queue list:', err);
  }
}

function renderQueue(queue) {
  elements.queueList.innerHTML = '';
  
  if (!queue || queue.length === 0) {
    elements.queueList.innerHTML = '<div class="queue-placeholder">当前点歌列表为空，快去搜歌点一首吧~</div>';
    return;
  }
  
  queue.forEach((song, idx) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    
    let actionBtnHtml = '';
    // Show delete/remove button if viewer has admin controls unlocked
    if (state.controlsUnlocked) {
      actionBtnHtml = `
        <button class="queue-remove-btn" data-index="${idx}">
          <i class="fas fa-trash-can"></i> 移除
        </button>
      `;
    } else {
      actionBtnHtml = `
        <span style="font-size: 0.65rem; color: var(--text-dimmed); font-style: italic;">排队中</span>
      `;
    }
    
    const timeText = song.timestamp ? new Date(song.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    
    item.innerHTML = `
      <div class="song-info">
        <span class="song-name">${song.name}</span>
        <span class="song-artist">${song.singer} ${timeText ? `<span style="font-size: 0.62rem; color: var(--text-dimmed); opacity: 0.65; margin-left: 6px;"><i class="far fa-clock"></i> ${timeText}</span>` : ''}</span>
      </div>
      ${actionBtnHtml}
    `;
    
    if (state.controlsUnlocked) {
      item.querySelector('.queue-remove-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        removeQueuedSong(btn.dataset.index);
      });
    }
    
    elements.queueList.appendChild(item);
  });
}

async function removeQueuedSong(index) {
  const url = `/api/remove-queued-song?index=${index}${state.token ? `&token=${encodeURIComponent(state.token)}` : ''}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.success) {
      showToast('已从点歌队列中移除');
      renderQueue(data.queue);
    } else {
      showToast(data.error || '移除失败');
    }
  } catch (err) {
    console.error('Remove failed:', err);
    showToast('删除请求发送失败');
  }
}

// Trigger Local Scheme Protocol URL in Session 1 Browser Frame
function triggerLocalScheme(song) {
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
  const url = `lxmusic://music/play?data=${encodedData}`;
  
  console.log('Triggering local scheme playback via browser:', song.name);
  
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = url;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 1000);
  
  showToast(`正在自动切播点歌：《${song.name}》`);
}

// Initialize Floating Desktop Pet Engine
function initDesktopPet() {
  const pet = document.getElementById('desktopPet');
  const bubble = document.getElementById('petBubble');
  const character = document.getElementById('petCharacter');
  const petImg = document.getElementById('petImg');
  const particlesContainer = document.getElementById('petParticles');
  
  if (!pet) return;
  
  let isDragging = false;
  let isInteractionActive = false;
  let isAutoMoving = false;
  let currentGif = '';
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;
  let hasMoved = false;
  let bubbleTimeout = null;
  let idleInterval = null;
  let particleInterval = null;
  let autoMoveTimer = null;

  // Helper to change current pet GIF src smoothly
  const setPetImage = (gifName) => {
    if (currentGif === gifName) return;
    currentGif = gifName;
    if (petImg) petImg.src = gifName;
  };
  
  // Load saved position if any
  const savedLeft = localStorage.getItem('lx_pet_left');
  const savedTop = localStorage.getItem('lx_pet_top');
  if (savedLeft && savedTop) {
    pet.style.left = savedLeft;
    pet.style.top = savedTop;
    pet.style.bottom = 'auto';
    pet.style.right = 'auto';
  }
  
  // Dragging event handlers (support both Mouse and Touch screen events)
  const onStart = (e) => {
    isDragging = true;
    hasMoved = false;
    pet.classList.add('dragging');
    setPetImage('moving.gif');
    
    const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
    const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
    
    startX = clientX;
    startY = clientY;
    
    const rect = pet.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    
    // Disable float animation transition during drag
    pet.style.transition = 'none';
  };
  
  const onMove = (e) => {
    if (!isDragging) return;
    e.preventDefault(); // prevent scrolling
    
    const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
    const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
    
    const dx = clientX - startX;
    const dy = clientY - startY;
    
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      hasMoved = true;
    }
    
    let newLeft = initialLeft + dx;
    let newTop = initialTop + dy;
    
    // Clamp inside viewport boundaries
    const padding = 10;
    newLeft = Math.max(padding, Math.min(window.innerWidth - 100, newLeft));
    newTop = Math.max(padding, Math.min(window.innerHeight - 120, newTop));
    
    pet.style.left = `${newLeft}px`;
    pet.style.top = `${newTop}px`;
    pet.style.bottom = 'auto';
    pet.style.right = 'auto';
  };
  
  const onEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    pet.classList.remove('dragging');
    pet.style.transition = 'transform 0.2s ease, top 0.8s cubic-bezier(0.25,0.46,0.45,0.94), left 0.8s cubic-bezier(0.25,0.46,0.45,0.94)';
    
    // Save position to localStorage
    localStorage.setItem('lx_pet_left', pet.style.left);
    localStorage.setItem('lx_pet_top', pet.style.top);
    
    if (!hasMoved) {
      // Trigger click interaction if mouse didn't drag far
      triggerPetClickReaction();
    } else {
      updatePetVisualState();
    }
  };
  
  pet.addEventListener('mousedown', onStart);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onEnd);
  
  pet.addEventListener('touchstart', onStart, { passive: false });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onEnd);
  
  // Custom dialog speech bubble triggers
  const showBubble = (text, duration = 4000) => {
    clearTimeout(bubbleTimeout);
    bubble.innerText = text;
    bubble.classList.add('visible');
    
    bubbleTimeout = setTimeout(() => {
      bubble.classList.remove('visible');
    }, duration);
  };
  
  // Interactive Click Reaction
  const triggerPetClickReaction = () => {
    if (isDragging) return;
    
    isInteractionActive = true;
    
    // 360-degree spin
    character.style.transform = 'rotate(360deg) scale(1.15)';
    setTimeout(() => {
      character.style.transform = 'none';
    }, 600);
    
    // Randomly pick a click GIF reaction from happy, jumping, or wave
    const reactionGifs = ['happy.gif', 'jumping.gif', 'wave.gif'];
    const pickGif = reactionGifs[Math.floor(Math.random() * reactionGifs.length)];
    setPetImage(pickGif);
    
    const clickPhrases = [
      "哎呀！别摇我了，脑阔疼 😵",
      "摸摸头，音乐不停，舞蹈不止！⚡",
      "啦啦啦~ 本小歌娘是这儿的 DJ 馆长！🎧",
      "你把我拽到好玩的地方放着吧~ ✨",
      "点首歌听听嘛，我的耳朵已经迫不及待了！🎵",
      "主人辛苦啦！给你笔芯 ❤️"
    ];
    const pickText = clickPhrases[Math.floor(Math.random() * clickPhrases.length)];
    showBubble(pickText, 4500);
    
    // Restore visual state after 2.5 seconds
    setTimeout(() => {
      isInteractionActive = false;
      updatePetVisualState();
    }, 2500);
  };
  
  // Emit musical notes / sleep Z particles
  const spawnParticle = () => {
    if (state.status === 'offline') return;
    
    const particle = document.createElement('div');
    particle.className = 'pet-particle';
    
    const isPlaying = state.status === 'playing';
    if (isPlaying) {
      const notes = ['♪', '♫', '♬', '♩'];
      particle.innerText = notes[Math.floor(Math.random() * notes.length)];
      particle.style.color = Math.random() > 0.5 ? '#f472b6' : '#22d3ee';
    } else {
      particle.innerText = 'z';
      particle.style.fontSize = Math.random() > 0.5 ? '0.55rem' : '0.7rem';
      particle.style.color = 'rgba(244, 114, 182, 0.4)';
    }
    
    // random starting offset near pet head center
    const leftOffset = 25 + Math.random() * 30;
    particle.style.left = `${leftOffset}px`;
    particle.style.top = '15px';
    
    // set random float direction
    const xOffset = -15 + Math.random() * 30;
    particle.style.setProperty('--x-offset', `${xOffset}px`);
    
    particlesContainer.appendChild(particle);
    
    // auto remove particle after animation ends
    setTimeout(() => particle.remove(), 1800);
  };
  
  // Real-time pet visual state manager
  const updatePetVisualState = () => {
    if (isDragging || isInteractionActive) return;
    
    pet.classList.remove('dancing', 'sleeping');
    
    if (state.status === 'playing') {
      pet.classList.add('dancing');
      setPetImage('play.gif');
    } else if (state.status === 'paused' || state.status === 'stopped') {
      pet.classList.add('sleeping');
      setPetImage('idle.gif');
    } else if (state.status === 'offline' || state.status === 'error') {
      setPetImage('boring.gif');
    }
  };
  
  // Setup intervals for idle dialogue comments
  idleInterval = setInterval(() => {
    if (state.status === 'offline') {
      showBubble("哎呀，跟笔记本的连接断开了... 😭", 5000);
      return;
    }
    
    if (state.status === 'playing') {
      // Lyrics singing is handled dynamically by lyric trigger, so skip idle chats
      return;
    }
    
    // Idle comments when paused or stopped
    const weatherText = document.getElementById('weatherTemp') ? document.getElementById('weatherTemp').innerText : '';
    const descText = document.getElementById('weatherDesc') ? document.getElementById('weatherDesc').innerText : '';
    
    const idlePhrases = [
      "点首好听的歌听听嘛~ 🎵",
      "戴上耳机(🎧)，跟我一起开启同步收听！",
      "你可以用鼠标把我拖拽到屏幕任何地方哦~",
      "主人的歌单里全都是宝藏歌曲！✨",
      "想点歌的话，可以去「互动点歌」选项卡找我！",
      "无歌播放中，DJ 馆长正在闭目养神 zZZ..."
    ];
    
    if (weatherText && descText) {
      idlePhrases.push(`武汉今天的天气是${descText}，温度大约有 ${weatherText}°C 哟！☁️`);
    }
    
    const pick = idlePhrases[Math.floor(Math.random() * idlePhrases.length)];
    showBubble(pick, 4500);
  }, 16000);
  
  // Note particle generator
  particleInterval = setInterval(() => {
    if (state.status === 'playing') {
      spawnParticle();
    } else if (state.status === 'paused' && Math.random() > 0.4) {
      spawnParticle();
    }
  }, 1600);
  
  // Observe state changes to trigger visual updates
  const checkStateUpdates = () => {
    updatePetVisualState();
  };
  
  // ── Autonomous Small-Step Wandering Engine ──
  // Pet takes small steps (60-180px each), pauses briefly between steps,
  // then rests longer after a burst of steps — like gently strolling.
  
  let stepsRemaining = 0; // steps left in current burst
  
  const doAutoStep = () => {
    if (isDragging || isInteractionActive) {
      autoMoveTimer = setTimeout(doAutoStep, 2000);
      return;
    }
    
    // If burst is exhausted → enter rest phase
    if (stepsRemaining <= 0) {
      isAutoMoving = false;
      character.style.transform = 'scaleX(1)';
      if (state.status !== 'playing') {
        const restGifs = ['idle.gif', 'idle.gif', 'idle.gif', 'wave.gif', 'happy.gif'];
        setPetImage(restGifs[Math.floor(Math.random() * restGifs.length)]);
      }
      // Rest 3–7 s, then start a new burst
      const restMs = 3000 + Math.random() * 4000;
      stepsRemaining = 3 + Math.floor(Math.random() * 4); // 3–6 steps next burst
      autoMoveTimer = setTimeout(doAutoStep, restMs);
      return;
    }
    
    stepsRemaining--;
    
    const petW = pet.offsetWidth  || 90;
    const petH = pet.offsetHeight || 120;
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const padding = 16;
    
    // Small step: offset from current position by 60–180px in a random direction
    const curLeft = parseFloat(pet.style.left) || (vw - petW - 20);
    const curTop  = parseFloat(pet.style.top)  || (vh - petH - 20);
    
    const stepSize = 60 + Math.random() * 120; // 60–180 px
    const angle    = Math.random() * Math.PI * 2;
    
    let targetLeft = curLeft + Math.cos(angle) * stepSize;
    let targetTop  = curTop  + Math.sin(angle) * stepSize;
    
    // Clamp within viewport
    targetLeft = Math.max(padding, Math.min(vw - petW - padding, targetLeft));
    targetTop  = Math.max(padding, Math.min(vh - petH - padding, targetTop));
    
    const movingRight = targetLeft >= curLeft;
    character.style.transform = movingRight ? 'scaleX(1)' : 'scaleX(-1)';
    
    // Walk animation (mostly moving.gif, rarely jumping)
    if (state.status !== 'playing') {
      setPetImage(Math.random() < 0.15 ? 'jumping.gif' : 'moving.gif');
    }
    
    isAutoMoving = true;
    
    // Each small step: 1.2–2.2 s
    const stepDuration = 1200 + Math.random() * 1000;
    pet.style.transition = `left ${stepDuration}ms linear, top ${stepDuration}ms linear`;
    pet.style.left   = `${targetLeft}px`;
    pet.style.top    = `${targetTop}px`;
    pet.style.bottom = 'auto';
    pet.style.right  = 'auto';
    
    // Brief pause between steps: 0.6–1.8 s
    const pauseMs = 600 + Math.random() * 1200;
    autoMoveTimer = setTimeout(doAutoStep, stepDuration + pauseMs);
  };
  
  // Init burst count, kick off after short delay
  stepsRemaining = 3 + Math.floor(Math.random() * 4);
  autoMoveTimer = setTimeout(doAutoStep, 2000);
  
  // Watch lyrics updates to make pet "sing along"
  let lastLrcText = '';
  setInterval(() => {
    if (state.status !== 'playing' || !state.lyricLineText) return;
    if (state.lyricLineText !== lastLrcText) {
      lastLrcText = state.lyricLineText;
      // Make bubble sing along
      showBubble(`🎤 ${lastLrcText}`, 4500);
    }
  }, 500);
  
  // Expose checkStateUpdates to global update loop
  window.checkPetStateUpdates = checkStateUpdates;
  
  // Initialize initial state immediately
  updatePetVisualState();
  showBubble("哈罗！我是您的 DJ 馆长桌宠，点击或拖拽我来玩耍吧！✨", 6000);
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', init);

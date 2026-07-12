<div align="center">

# 🎵 See-Listen-Desktop

**一个优雅的 LX Music 网页伴侣 · An Elegant Web Companion for LX Music**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![LX Music](https://img.shields.io/badge/LX%20Music-API-purple)](https://github.com/lyswhut/lx-music-desktop)

*实时展示 LX Music 当前播放状态，支持卡拉OK歌词、听歌统计、访客点歌、天气时钟等功能，可通过 Cloudflare Tunnel 对外公开访问。*

</div>

---

## ✨ 功能特性

| 功能 | 描述 |
|------|------|
| 🎵 **实时播放状态** | 通过 SSE 实时推送歌曲名、歌手、专辑、进度、封面 |
| 🎤 **卡拉OK歌词** | 逐字扫光高亮，支持翻译歌词和罗马音 |
| 📊 **听歌统计** | 累计播放数、艺术家排行、时段热力图、日历图 |
| 🎧 **访客点歌** | 访客搜索并提交曲目，主播审核后一键播放 |
| 🌤️ **天气时钟** | 实时天气 + 本地时间组件（15分钟缓存） |
| 🔒 **访问控制** | 可选 Token 鉴权，控制操作权限与公开访问分离 |
| 🐾 **桌宠** | 可爱的互动桌宠，根据播放状态切换动画 |
| 📡 **Cloudflare Tunnel** | 无需公网IP，一键穿透对外提供访问 |

---

## 📸 预览

> 部署完成后可在此处添加截图

---

## 🚀 快速开始

### 必备依赖

| 依赖 | 版本要求 | 获取方式 |
|------|----------|----------|
| **Node.js** | ≥ 18.x | [nodejs.org](https://nodejs.org/) |
| **LX Music Desktop** | 最新版 | [GitHub Releases](https://github.com/lyswhut/lx-music-desktop/releases) |
| **Cloudflare Tunnel** *(可选)* | 任意 | [cloudflare.com](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) |

### 1. 配置 LX Music

打开 LX Music Desktop → **设置 → 其他设置 → 开启本地API服务**

- 默认端口：`23330`（如修改，需同步修改 `LX_MUSIC_PORT` 环境变量）

### 2. 克隆项目

```bash
git clone https://github.com/YOUR_USERNAME/see-listen-desktop.git
cd see-listen-desktop
```

### 3. 启动服务

#### 方式一：直接运行（推荐开发调试）

```bash
node server.js
```

#### 方式二：使用启动脚本（Windows，后台静默运行）

双击 `启动.bat`，脚本会自动：
1. 结束旧的 Node 进程
2. 后台静默启动 Node 服务
3. 重启 Cloudflare Tunnel 服务（如已安装）

> ⚠️ 需要以**管理员权限**运行 `.bat` 文件

#### 方式三：npm 启动

```bash
npm start
```

### 4. 访问网页

浏览器打开：`http://localhost:3000`

---

## ⚙️ 环境变量配置

可通过环境变量或直接修改 `server.js` 顶部常量来配置：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3000` | Web 服务监听端口 |
| `LX_MUSIC_PORT` | `23330` | LX Music 本地 API 端口 |
| `LX_MUSIC_HOST` | `127.0.0.1` | LX Music API 地址（本机留默认） |
| `ACCESS_TOKEN` | *(空，无鉴权)* | 设置后开启 Token 鉴权，控制操作权限 |

**示例（Windows CMD）：**

```cmd
set ACCESS_TOKEN=your_secret_token
node server.js
```

**示例（PowerShell）：**

```powershell
$env:ACCESS_TOKEN = "your_secret_token"
node server.js
```

**示例（Linux/macOS）：**

```bash
ACCESS_TOKEN=your_secret_token node server.js
```

---

## 🌐 Cloudflare Tunnel 对外访问（可选）

> 适合没有公网IP、想把页面分享给朋友的场景

1. 安装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)
2. 登录并创建隧道：

```bash
cloudflared tunnel login
cloudflared tunnel create see-listen
```

3. 配置 `~/.cloudflared/config.yml`：

```yaml
tunnel: <your-tunnel-id>
credentials-file: /path/to/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: music.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

4. 运行隧道：

```bash
cloudflared tunnel run see-listen
```

---

## 📁 项目结构

```
see-listen-desktop/
├── server.js              # Node.js 后端主文件
├── package.json           # 项目配置
├── 启动.bat               # Windows 一键启动脚本
├── public/                # 前端静态文件
│   ├── index.html         # 主页面
│   ├── app.js             # 前端逻辑（SSE、歌词、统计、点歌）
│   ├── style.css          # 样式（深色玻璃拟态主题）
│   ├── offline.html       # 离线状态页
│   └── *.gif              # 桌宠动画资源
├── lx_stats.json          # 听歌统计数据（运行时生成，不纳入版本控制）
├── visitor_queue.json     # 访客点歌队列（运行时生成）
└── request_history.json   # 点歌历史记录（运行时生成）
```

---

## 🔧 API 端点说明

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 主页 |
| `/status` | GET | 获取当前播放状态（JSON） |
| `/subscribe-player-status` | GET | SSE 实时推送播放事件 |
| `/api/auth-check` | GET | 检查是否需要鉴权 |
| `/api/verify-token` | GET | 验证 Token |
| `/api/time` | GET | 获取网络精准时间（淘宝授时） |
| `/api/weather` | GET | 获取天气数据（15分钟缓存） |
| `/api/stats` | GET | 获取听歌统计数据 |
| `/api/search` | GET | 搜索歌曲（通过 GD Studio API） |
| `/api/visitor-request` | POST | 访客提交点歌请求 |
| `/api/visitor-queue` | GET | 获取点歌队列 |
| `/play` `pause` `prev` `next` | GET | 播放控制（需鉴权） |
| `/seek` `/volume` `/mute` | GET | 进度/音量控制（需鉴权） |

---

## 📊 听歌统计逻辑

- **有效播放**：连续播放满 **15 秒**才计入一次
- **防重复**：同一首歌 **30 秒内**只计一次（防刷榜/刷新重计）
- **高效落盘**：内存实时更新，每 **60 秒**批量写入磁盘（`lx_stats.json`）
- **进程保护**：服务关闭时自动强制落盘，数据不丢失

---

## 🐛 常见问题

**Q：页面显示"离线"**
> 检查 LX Music 是否已开启本地 API（设置 → 其他设置），并确认端口与 `LX_MUSIC_PORT` 一致。

**Q：歌词不显示**
> 在 LX Music 设置中确认已启用"歌词"推送。部分歌曲没有歌词属于正常现象。

**Q：点歌功能不可用**
> 点歌需要主播解锁控制权（输入 Token），访客仅能搜索并提交请求。

**Q：启动.bat 无法运行**
> 右键 → 以管理员身份运行。若 Node.js 路径不同，编辑 `启动.bat` 第23行修改路径。

---

## 📝 更新日志

### v2.4.0 (2025-07-13)
- ✅ 优化听歌统计：15s有效播放阈值 + 30s防刷 + 60s批量落盘
- ✅ 修复进度条/歌词双重驱动抖动问题（SSE 不再直接驱动 UI）
- ✅ 专辑封面纯圆形展示，无镂空中轴
- ✅ 时间同步改用淘宝授时 API，解决时钟漂移

### v2.3.0
- ✅ 网易云/酷我/Bilibili 级联直链降级策略
- ✅ 访客点歌队列系统
- ✅ 听歌统计图表（热力图、艺术家排行、时段分布）

---

## 🙏 致谢 / Acknowledgements

本项目的诞生离不开以下工具与社区的支持，在此致以诚挚的感谢。

### 🤖 AI 协作

本项目全程由 AI 辅助编写，感谢以下模型的协作与贡献：

| 模型 | 职责 |
|------|------|
| **Gemini 3.5 Flash** | 快速迭代、功能原型、代码补全 |
| **Gemini 3.1 Pro** | 架构设计、复杂逻辑推理 |
| **Claude Sonnet 4.6** | 代码审查、逻辑优化、文档撰写 |
| **GPT-OSS 120B** | 功能探索与多方案评估 |

### 🎨 资源致谢

- **爱弥斯 GIF 动画** — 由 B 站用户 [@haidiyue](https://space.bilibili.com/486401719) 提供，感谢其创作与分享的可爱桌宠形象

### 🛠️ 开源项目

- **[LX Music Desktop](https://github.com/lyswhut/lx-music-desktop)** — 本项目所依托的本地音乐播放器，感谢 lyswhut 及所有贡献者
- **[GD Studio Music API](https://music.gdstudio.xyz/)** — 提供多平台音乐搜索与直链解析服务

---

## 📄 License

MIT © 2025

---

<div align="center">

Made with ❤️ for music lovers

</div>

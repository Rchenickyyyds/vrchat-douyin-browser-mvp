# VRChat 抖音远程浏览器 MVP

用服务器上的 Chromium 打开抖音，经 FFmpeg 输出 HLS，再由 VRChat World 中的 AVPro 播放器观看；UdonSharp 脚本通过固定 GET URL 发送翻页、点赞、收藏等控制请求。

这是基于 **2026-08-28 初版源码**整理的 **0.1.0 首次公开版本准备稿**。源码包含 Node 服务端和需导入现有 VCC World 项目的 UdonSharp 脚本，没有完整 Unity 工程。本轮未验证生产部署是否使用此快照，也未完成 Docker、真实抖音、VRChat 多客户端或 Quest 的全链路测试。下文的功能说明来自实际代码，操作步骤须在目标环境复核。

**先了解安全边界：API 没有鉴权。** 任何能访问它的人都能创建、操作或关闭 Session，选用 User1/User2 永久 Profile，并观看可访问的 HLS。VRChat Display Name 仅用于客户端选择 Profile，可以修改，不能证明身份。永久 Profile 只应放隔离测试账号；不要直接把本服务裸露到公网。默认配置仅绑定本机，进一步部署见 [部署说明](docs/deployment.md) 和 [安全说明](SECURITY.md)。

## 架构与代码范围

```text
VRChat UdonSharp ──固定 GET URL──> Node HTTP API
                                      │
                              Slot / Profile 管理
                                      │
                           Playwright + Chromium
                                      │
                           Xvfb 画面 + PulseAudio
                                      │
                                   FFmpeg
                                      │
VRChat AVPro <── HLS /stream/{slot}/index.m3u8 ── Caddy
```

| 目录 | 内容 |
| --- | --- |
| `server/src/` | Session、Slot、Profile、浏览器、抓流及 HTTP API 集成代码 |
| `server/config/` | 默认运行参数、抖音 DOM selector 和翻页按键 |
| `server/test/` | Node 最小测试；部分使用模拟对象，不启动真实浏览器 |
| `server/Dockerfile`、`docker-compose.yml`、`Caddyfile` | 获取运行时依赖、持久化数据及反向代理的部署配方 |
| `unity/Assets/DouyinRemoteBrowser/Runtime/` | 3 个 UdonSharp 脚本，需导入自己的 VCC World 工程 |

仓库提供项目集成代码与配置。Playwright、Chromium、Node.js、FFmpeg、Xvfb、PulseAudio、Caddy、Unity 和 VRChat SDK 均属于第三方；其源码、SDK、二进制及示例素材未随此源码快照打包，按安装步骤获取。详见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 代码包含的功能

- 默认 16 个 Slot，每个活跃 Session 启动独立 Chromium、虚拟显示、虚拟音频和 HLS 输出。
- User1/User2 使用 `profile_user_1`、`profile_user_2` 持久化目录；同一永久 Profile 在单个服务进程中只允许一个活跃 Session，重复申请返回 HTTP 409。
- Guest 每次创建随机目录，关闭后删除；服务启动时清理遗留 Guest 目录。永久 Profile 会保留。
- 默认 90 秒无 heartbeat 后回收，按 10 秒间隔检查；收到正常退出信号时尝试关闭 Session。
- 使用可配置按键翻页，按配置 selector 查找可见的点赞/收藏按钮。网站 DOM 变化会影响操作。
- 自动模式按 FFmpeg 列出的能力尝试 NVENC、QSV、AMF，启动失败时尝试 `libx264`；这不代表本轮已验证相应硬件。
- Udon 手动同步 Slot、Profile、控制者和状态；代码包含 late join、控制者离开、视频加载重试等处理，仍需真实客户端验证。

## 本机快速开始

服务端目标环境是 Linux；抓屏和音频流程依赖 Xvfb、PulseAudio 与 FFmpeg。Docker 配方使用 Node 22。先安装 Docker Engine 和 Compose，然后在克隆后的项目根目录执行：

```bash
cd server
cp .env.example .env
docker compose config
docker compose up -d --build
curl --fail http://127.0.0.1:8080/health
```

示例默认 `DOMAIN=http://localhost:8080`、`BIND_ADDRESS=127.0.0.1`。`/health` 返回 `ok` 只表示 HTTP 服务可达，不会启动 Chromium，也不能证明视频链路正常。Docker 完整构建/抓流本轮尚未验证。

依赖安装、原生 Linux 启动、Guest 视频检查、GPU 配置、数据备份以及显式启用公网 HTTPS 的步骤见 [部署说明](docs/deployment.md)。

## Unity 接线

先通过 [VRChat Creator Companion](https://vcc.docs.vrchat.com/) 创建或打开 World 项目并安装 Worlds SDK。使用其要求的 Unity 版本；本仓库没有固定或附带 Unity/SDK 版本。将 `unity/Assets/DouyinRemoteBrowser` 复制到目标项目的 `Assets/`。

1. 从 SDK 的 `Packages/VRChat SDK - Worlds/Samples/UdonExampleScene/Prefabs/VideoPlayers` 选用带 `VRCAVProVideoPlayer` 的示例。保留画面、音频和播放器组件，移除示例自带的同步 UdonBehaviour，由本项目 Manager 处理状态。
2. 在 `VRCAVProVideoPlayer` 所在 GameObject 上添加 `DouyinBrowserManager`，让视频事件送到 Manager。
3. 添加 `BrowserSlotUrls`，将 `Server Base Url` 填为可达的服务地址，末尾不加 `/`。修改后编辑器会重建 URL；也可右键组件选择“重新生成 Slot 0-15 URL”。远端测试使用有效 HTTPS 地址。
4. 添加 `DouyinBrowserUI`。将 Manager 的 `Slot Urls`、`Video Player`、`Ui` 引用拖好，并把 UI 的 `Manager` 拖回 Manager。
5. 建 9:16 的画面，可调整 AVPro 示例屏幕 Mesh；如果所用 SDK 提供低延迟选项，再按其说明设置。HLS 是直播流，无需加入播放进度同步脚本。
6. 建 World Space Canvas，添加 `VRC_UIShape`，Canvas 使用 `Default` 层。放置 6 个 Button，其 OnClick 依次绑定 `DouyinBrowserUI.InitializeBrowser`、`GetControl`、`Previous`、`Next`、`Like`、`Favorite`。
7. 放置 5 个 Legacy UI `Text`，拖入 Browser、Profile、Controller、Slot、Status 字段；把 6 个 Button 拖入 UI 对应字段。

AVPro 不能靠 Unity Editor Play Mode 验证播放，需使用 SDK Build & Test。自有域名若不在 VRChat allowlist，观看者还需开启 **Allow Untrusted URLs**。相关行为以 [VRChat Video Players](https://creators.vrchat.com/worlds/udon/video-players/) 和 [String Loading](https://creators.vrchat.com/worlds/udon/string-loading/) 官方文档为准。

## 配置

| 配置 | 位置与说明 |
| --- | --- |
| User1/User2 的 Display Name | `DouyinBrowserManager.cs` 的 `VRC_USER_1`、`VRC_USER_2`，默认为 `Example User One`、`Example User Two`；仅用于 UI 分支，不是鉴权 |
| Unity 服务地址 | 场景中 `BrowserSlotUrls.serverBaseUrl`，统一生成 16 个 Slot URL |
| 服务绑定与 Caddy 地址 | `server/.env`；Compose 会读取，原生 `npm start` 不自动读取该文件 |
| 服务端口、Slot 数、超时、分辨率、码率 | `server/config/default.json`；Unity URL 数量固定为 16，更改 Slot 数需同步调整并验证客户端 |
| 编码器 | 环境变量 `H264_ENCODER` 或默认 JSON；可选 `auto`、`libx264`、`h264_nvenc`、`h264_qsv`、`h264_amf` |
| selector 和翻页按键 | `server/config/selectors.json` |
| 运行时数据目录 | `DOUYIN_DATA_ROOT`，默认 `server/data`；Compose 使用 `app_data` volume |

Cookie、LocalStorage、IndexedDB 会保存在 Chromium Profile 中。API 不直接导出这些文件，但无鉴权控制接口仍可操作已登录浏览器，HLS 也会展示浏览器画面；数据和备份都应按敏感资料保护。

## API

API 与 HLS 共用服务地址，没有身份认证、Session 所有者校验或服务端请求限速。不要将 UI 控制者检查当作 API 授权。

```text
GET  /health
POST /api/session/create                 JSON: {"profile":"user1|user2|guest"}
GET  /api/session/create/user1
GET  /api/session/create/user2
GET  /api/session/create/guest

GET 或 POST /api/session/{slot}/next
GET 或 POST /api/session/{slot}/prev
GET 或 POST /api/session/{slot}/like
GET 或 POST /api/session/{slot}/favorite
GET 或 POST /api/session/{slot}/heartbeat
GET 或 POST /api/session/{slot}/close

GET /stream/{slot}/index.m3u8
GET /stream/{slot}/segment_{number}.ts
```

创建成功返回 HTTP 201 和纯文本 Slot 数字，便于 `int.TryParse`；其他成功控制请求返回 `ok`。Slot 默认是 0–15。服务端提供有副作用的固定 GET 路径，是为了适配此客户端的预生成 `VRCUrl` 与 String Loading；仅打开这些 URL 就可能执行操作。

## 验证方法与边界

先运行不启动 Chromium 的现有测试：

```bash
cd server
npm ci
npm test
```

它们覆盖部分 API 路由、Profile 生命周期、Slot 分配和编码器候选选择，不能验证网站操作、实际视频/音频、GPU、Docker 或 Udon 同步。隔离环境的真实 Guest 检查见 [部署说明](docs/deployment.md)。

完成服务器视频检查后，再用真实 VRChat 客户端验证：两名测试用户匹配 User1/User2 分支，其他名字使用 Guest；重开 Session 检查持久化差异，停止 heartbeat 检查回收；第二个客户端 late join 检查 Slot/状态/视频；控制者退出后检查释放与重新获取控制权。最后单独检查 Quest/Android、音画同步和 HTTPS。ClientSim 可辅助测试 UI 和名字分支，无法替代 AVPro 真机播放。

## 已知限制

- 本快照适合隔离环境开发验证。鉴权、服务端限速和安全的多用户授权尚未实现；把固定密钥写入公开 World 不能解决身份问题。
- Chromium 使用 `--no-sandbox`，Session 之间不是强安全隔离。使用独立低权限环境，不挂载宿主机秘密或真实个人浏览器资料。
- Slot 和永久 Profile 锁仅存在于进程内，不支持多个 API 副本共享同一数据目录。
- String Loading 官方限制每 5 秒一次，超量请求可能乱序；代码使用 5.2 秒冷却，按钮无法连续快速操作。HLS 也会产生延迟。
- 极端同时初始化可能在 VRChat 所有权同步窗口内留下额外后端 Session；超时回收不是并发正确性的完整证明。
- 抖音 selector、验证码、登录要求和服务器 IP 限制会变化；当前网站操作与账号持久化未在本轮实测。
- JavaScript 依赖由 lockfile 固定；Docker 基础镜像、Caddy 镜像和系统包仍随上游更新，未做镜像 digest 固定或逐字节可复现构建。

## 许可

原创集成代码的开源许可证**待作者确认**，当前快照未附项目级 `LICENSE`，不能据此假定已获得 MIT 等开源授权。第三方组件继续适用各自条款，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

# 部署与隔离验证

本说明适用于 `0.1.0` 源码快照。目标是让安装者在自己的隔离环境重建服务。Docker 镜像构建、实际抖音控制、GPU 编码、VRChat 和 Quest 的完整链路尚未在本轮验证；HTTP 健康检查或单元测试通过不代表这些步骤已成功。

## 环境要求

- Linux 主机，能安装 Xvfb、PulseAudio、FFmpeg 与 Playwright 所需系统库。Docker 配方以 Debian Bookworm + Node 22 为基础。
- Node.js 满足 `server/package.json` 的 `>=20` 要求；推荐使用仍受支持且与所用 Playwright 兼容的版本。容器方案由 Dockerfile 获取 Node 22。
- 首次安装需要访问 npm、Playwright 浏览器下载源、Debian 软件源及容器镜像源。
- 默认抓取 1080×1920 / 30 fps、输出 540×960 HLS。16 是 Slot 上限，不是已验证的主机并发容量。先从一个 Guest Session 测试资源占用。

使用专用低权限环境，不挂载宿主机 SSH、云凭据、个人浏览器资料或其他秘密。Chromium 的 `--no-sandbox` 使容器和主机隔离尤为重要。

## Docker：默认本机访问

从项目根目录进入 `server`：

```bash
cd server
cp .env.example .env
docker compose config
docker compose up -d --build
curl --fail http://127.0.0.1:8080/health
docker compose logs --tail=100 app caddy
```

默认值为：

```dotenv
DOMAIN=http://localhost:8080
BIND_ADDRESS=127.0.0.1
HOST=127.0.0.1
H264_ENCODER=auto
```

Compose 会读取 `.env`。`HOST` 在容器内部被覆盖为 `0.0.0.0`，让 Caddy 通过 Compose 网络访问 Node；Node 的 3000 端口没有直接发布到宿主机。Caddy 的宿主机端口默认绑定 `127.0.0.1`，本机 HTTP 测试走 8080。这些默认值不提供远端 VRChat 接入。

`/health` 返回 `ok` 表示 API 可达。Session 创建时才会启动 Xvfb、音频、Chromium 和 FFmpeg，因此健康检查成功后仍需进行下方 Guest 测试。

## 原生 Linux 启动

先安装 Node.js、FFmpeg、Xvfb、PulseAudio 以及提供 `pactl` 的工具包，再在 `server` 中执行：

```bash
npm ci
npm run install-browser
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/douyin-pulse-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
pulseaudio --daemonize=yes --exit-idle-time=-1
HOST=127.0.0.1 H264_ENCODER=libx264 npm start
```

`npm run install-browser` 会安装 Chromium 并尝试安装系统依赖，可能需要系统包管理权限。原生 `npm start` **不自动读取 `.env`**；请像上面这样显式传入环境变量，或自行使用合适的服务管理器配置。默认端口为 3000，此方式检查 `http://127.0.0.1:3000/health`。

## 单个 Guest Session 检查

下面示例在 Docker 的本机地址操作 Guest。它会打开 `config/default.json` 指定的网站并产生视频数据，需完整运行时和网络。首次测试不要登录真实账号。

```bash
base=http://127.0.0.1:8080
slot=$(curl --fail --silent --show-error "$base/api/session/create/guest")
curl --fail "$base/stream/$slot/index.m3u8"
curl --fail "$base/api/session/$slot/heartbeat"
curl --fail "$base/api/session/$slot/next"
curl --fail "$base/api/session/$slot/close"
```

创建返回 Slot 不代表画面已有可播放分片；如收到 `stream not ready`，查看日志，等待分片生成后重试。可使用本机支持 HLS 的播放器检查音画。创建成功后每 90 秒内需发送 heartbeat，否则会被回收。`next` 请求成功仅说明按键已发送，实际网页是否翻页仍需看画面。

关闭后检查 Guest 目录是否删除、该 Slot 是否可重用。User1/User2 的 API 结构相同，但会保留登录态；仅在隔离测试账号上验证重开后仍保持登录。Guest 目录不是安全擦除机制，备份和主机存储也需自行管理。

## 显式启用远端 HTTPS 前

当前 API 没有鉴权，HLS 没有访问控制。任何可达者均可选用持久 Profile 并发送控制请求。**不要只把绑定改为公网再登录个人账号。** 先补齐适合参与者的网络访问边界与服务端授权；公开 World 中的固定秘密不能证明用户身份。需要所有观看者可达 API/HLS 时，应先设计并验证相应授权代理，该功能尚未在此快照实现。

在已确认访问范围、使用测试账号的受控环境中，远端 HTTPS 配置步骤为：

1. 准备真实域名和 DNS，让目标客户端可解析到服务；证书申请方式与网络应满足所用 Caddy 的要求。
2. 将 `.env` 的 `DOMAIN` 显式改为该域名，例如 `browser.example.com`。Caddy 会按其自动 HTTPS 规则处理；`http://localhost:8080` 仅供默认本机测试。
3. 只将 `BIND_ADDRESS` 改为所需接口地址，并在主机防火墙/上游网络限制参与者。常规 HTTPS 涉及 TCP 443；Caddy 自动证书流程可能需要 TCP 80，HTTP/3 另涉及 UDP 443。确认 8080 不被无意公开。
4. 重新 `docker compose config`，检查实际发布的端口和地址，再启动并核对证书与 `/health`。HTTPS 不等于鉴权。
5. Unity 的 `BrowserSlotUrls.serverBaseUrl` 改为完全一致的 `https://` 地址，重新生成 URL，在真实客户端 Build & Test。Quest/Android 的 HTTPS 与媒体兼容性需单独实测。

## 数据、停止与备份

Compose 的 `app_data` volume 保存 Profile、Guest 目录和 HLS；`caddy_data` / `caddy_config` 保存 Caddy 状态。停止而保留 volume：

```bash
docker compose down
```

不要在需要保留 Profile 时执行 `docker compose down -v`，它会删除项目管理的命名 volume。备份永久 Profile 前先关闭相关 Session，避免复制使用中的 Chromium 数据库。备份同样包含凭据，不得提交到仓库或附在公开问题中。

## 编码器与可复现边界

先用 `H264_ENCODER=libx264` 验证 CPU 路径。NVIDIA 需要主机驱动、NVIDIA Container Toolkit 和适当 GPU 映射；Intel/AMD 通常需要配置 `/dev/dri` 及权限，FFmpeg 构建也必须支持对应编码器。`auto` 仅按可见编码器尝试，不保证容器内可用设备或流启动后的长期稳定性。

`npm ci` 使用锁定的 JavaScript 依赖。当前 Dockerfile 的 Node 标签、Compose 的 Caddy 标签和 apt 系统包未锁 digest/版本；不同日期构建可能得到不同运行时。需要严格重建相同二进制时，另行固定这些来源并保留实际包/镜像许可。此仓库当前提供可重复执行的安装配方，未声称逐字节构建一致。

最小测试命令：

```bash
npm ci
npm test
```

现有测试不会启动真实网站、虚拟显示、音频或硬件编码器。完成上述步骤后，仍需按 README 的 Unity 接线执行真实 VRChat、late join 与 Quest 验证。

# VRChat 抖音远程浏览器

在自己的 Linux worker 上运行 Chromium，经 Xvfb / PulseAudio / FFmpeg 输出 HLS，供 VRChat AVPro 播放。操作员在受鉴权的网页控制台创建、翻页和关闭浏览器；VRChat 只接收短期只读观看链接。

这是 2026-08-28 历史 MVP 的安全改造分支，不等同于后续 Rust/Go 生产服务。仓库包含 Node 服务端和 3 个需导入 VCC World 的 UdonSharp 脚本，没有完整 Unity 工程。

## 部署边界

**每个信任域使用独立的专用容器栈或 VM。** 默认只允许一个并发 Session；互不信任的操作员不要共用 worker、数据 volume 或出口网络。浏览器 sandbox、Profile 目录和应用权限不能代替不同租户的操作系统隔离。同一 Unix UID 下的进程仍可访问彼此的文件和 PulseAudio；worker 内不要放其他账号资料、SSH、云凭据或 Docker socket。

推荐使用仓库的 Docker Compose 配方：非 root、强制 Chromium sandbox、私有显示/音频、只读根文件系统、无额外 capabilities，以及禁止直接外联的 worker 网络与受控出口代理。不要通过关闭 sandbox、`--privileged`、`SYS_ADMIN` 或宿主 IPC 解决启动失败。详见 [部署说明](docs/deployment.md) 与 [SECURITY](SECURITY.md)。

## 快速开始

需要 Docker Engine **28 或以上**、Compose，以及支持 Chromium 非特权 user namespace 的 Linux 内核。Mac/Windows 需要自己的 Linux VM。首次构建需要访问官方镜像、npm、Playwright 和 Debian 软件源。

```bash
cd server
cp .env.example .env
docker compose config --quiet
docker compose build
docker compose --profile setup run --rm init-access
docker compose up -d
curl --fail http://localhost:8080/health
```

初始化命令在独立 `access` volume 生成随机操作员密钥，文件权限为 0600；重复初始化会拒绝覆盖。密钥不会写入镜像、日志或仓库。按 [部署说明](docs/deployment.md#读取操作员密钥) 私下取出并复制到本机 `http://localhost:8080` 控制台。默认只授予 `guest` 权限，不会自动接入旧永久 Profile。

控制台依次执行连接、创建 Session、复制观看链接。创建浏览器可能需要几十秒，HLS 分片还需数秒。不要在登录二维码或私人资料出现在画面时分享链接。关闭会话会立即撤销后续控制与观看请求；已下载或录制的内容无法撤回。

默认端口只发布到本机。远端 VRChat 需要真实 HTTPS 域名、匹配的 `PUBLIC_ORIGIN`、有效证书及部署检查，不能用默认 localhost URL。不要把操作员密钥粘进 VRChat 输入框或 World 资源。

## 架构

```text
操作员网页 ── POST + Bearer ──> Caddy ──> Node / Session / Profile ACL
                                                   │
                                      sandboxed Chromium + 私有 Xvfb/Pulse
                                                   │
                                            FFmpeg → HLS
                                                   │
VRChat AVPro <── /stream/<随机会话>/<短期只读令牌>/index.m3u8

worker 只在隔离内网 → Squid 出口代理 → 公网 HTTP/HTTPS
```

## 已实现

- 操作员随机 Bearer 密钥、服务端 Profile 白名单、owner 范围列表及并发配额；持久 Profile 按 owner 哈希分目录。
- 每次创建随机 UUID 会话和独立控制令牌。Slot 仅用于内部容量分配；旧 Slot 地址没有控制或观看权限。
- 独立的只读观看令牌，同时保护 playlist 与每个 segment；路径中携带令牌使播放器能解析相对分片 URL。默认 10 分钟有效，重新发放立即撤销旧链接。
- 默认 90 秒无控制心跳或最长 1 小时后回收 Session。观看请求不延长寿命；控制台选中会话后每 30 秒续心跳。
- 创建/动作限速、8 项有界串行动作队列、请求体 8 KiB 限制、非同源 Origin 拒绝、无通配 CORS，控制操作只接受 POST。
- 关闭会等待已接收动作和资源退出；关闭开始即撤销访问。关机等待创建中任务。清理失败后 worker 拒绝新建与在途发布，保留受影响的 Profile/Slot 和数据锁；其他已有会话可能继续，部署者应尽快重启专用栈。
- Chromium sandbox 必开，浏览器不继承操作员密钥环境；每会话有独立 Xauthority、显示、音频进程和运行目录。Guest 关闭后删除，永久 Profile 保留。
- Compose 的 worker 网络没有外部默认路由或宿主 bridge IPv4 地址，app 显式禁用 IPv6；Squid 只允许公网 80/443，拒绝私网、回环、link-local、云 metadata 等地址。代理端口不向宿主发布。

## Unity / VRChat

新版本移除了旧匿名 GET 按钮与 Display Name 权限。原场景需要按 [Unity 迁移说明](docs/unity-migration.md) 重新接线。

用户在 `VRCUrlInputField` 粘贴完整 HTTPS 观看 URL，Manager 本地播放，不默认同步给其他玩家。每个收到 URL 的人都获得可转发的观看权；令牌不证明 VRChat 身份，也不能防止录屏。Udon 的 URL 和 String Loading 限制见迁移文档的官方依据。

## API

```text
GET  /health                               无敏感信息的存活检查
GET  /                                     本机/HTTPS 控制台
GET  /api/sessions                         操作员 Bearer，仅列本人活跃会话
POST /api/sessions                         操作员 Bearer，JSON {"profile":"guest"}
POST /api/sessions/<uuid>/<action>           本人操作员或该会话控制 Bearer
GET  /stream/<uuid>/<view-token>/index.m3u8  只读观看能力
GET  /stream/<uuid>/<view-token>/segment_N.ts 同样鉴权
```

action 可取 `next`、`prev`、`like`、`favorite`、`heartbeat`、`share`、`close`。创建返回 `id`、内部 `slot`、`controlToken`、`viewUrl`、`expiresAt`、`viewExpiresAt`；控制令牌不能创建会话、列出他人会话或改变 Profile。`share` 返回新的观看 URL 并撤销旧链接。错误返回 JSON，不回显内部路径或浏览器错误内容。旧 `/api/session/...` 与 `/stream/<slot>/...` 已移除，不能继续使用。

## 测试与实际验证

```bash
cd server
npm ci --ignore-scripts
npm test
```

单测包含真实 HTTP 请求、授权/越权/过期/轮换/清理竞态；浏览器与抓流部分使用可计数测试替身。独立 Linux 验证已实际运行 sandboxed Chromium 动态画面与 WebAudio → 私有 Xvfb / PulseAudio → FFmpeg → H.264/AAC HLS，并检查解码帧变化与非静音音轨。它证明受控网页的服务器采集链路，不能代表抖音当前登录/selector 或 VRChat 播放通过。

最终 Compose 还以默认分辨率实际打开抖音未登录首页，经 HTTP 取回并解码 HLS；该界面是视频网格，音轨近静音。`/recommend` 当次跳转 `/jingxuan`，没有就绪视频源，并出现登录/外部应用提示，未登录或批准提示。因此短视频实际播放、翻页/点赞 selector、持久登录、Unity/UdonSharp、PCVR/Quest 和多客户端仍需自己的授权环境验收。健康接口仅表示 HTTP/worker 可用，不验证媒体。GPU、公网 TLS 和长时间高负载也未验收。

## 来源、维护与许可

集成代码、配置与测试由本项目维护。Chromium/Playwright、Node、FFmpeg、Xvfb、PulseAudio、Squid、Caddy、Unity/VRChat SDK 按上游获取；不附带账号数据、SDK、World 素材或网站内容。唯一随源码分发的上游配置是有明确来源和修改记录的 Playwright seccomp 配方及其 Apache-2.0 许可证。

原创部分采用 [MIT License](LICENSE)，第三方按各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。构建标签和 apt 包会更新；这是可重复执行的部署配方，不保证逐字节相同镜像。安全反馈方式与支持范围见 [SECURITY](SECURITY.md)。

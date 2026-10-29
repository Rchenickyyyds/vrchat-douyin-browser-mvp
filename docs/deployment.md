# 部署与验收

推荐专用 Linux VM，Docker Engine >=28 + Compose。worker 会运行不可信网页，主机不要有其他私人工作负载、云实例权限或 Docker socket 挂载。不同信任域用不同 VM 或独立容器栈/数据/网络。默认单 Session，先验收再考虑提高容量。

## 初始化与启动

```bash
cd server
cp .env.example .env
docker compose config --quiet
docker compose build
docker compose --profile setup run --rm init-access
docker compose up -d
curl --fail http://localhost:8080/health
```

基础镜像及系统包未锁定 digest，首次构建需要公网安装源。JavaScript 用 lockfile 的确切版本。镜像不会复制本机 .env、secrets、Profile 或运行数据。init-access 在 `access` volume 创建随机密钥，0600，拒绝覆盖；应用将该 volume 只读挂载，不从环境变量接受明文操作员密钥。

app 以 UID1000 非 root运行，根文件系统只读，capabilities全部移除，保留 no-new-privileges；临时目录、数据卷和共享内存为独立受限存储。Chromium sandbox 如果不能正常启动，请检查宿主 user namespace/seccomp/AppArmor支持。不要关闭系统防护、增加 SYS_ADMIN 或使用 no-sandbox 作为正式修复。

## 读取操作员密钥

仅在自己的终端，将配置导出到私有临时目录，再用自己的安全编辑器读取/复制 token：

```bash
umask 077
mkdir -p private-access
docker compose run --rm --no-deps --entrypoint cat app /app/access/access.json > private-access/access.json
```

`private-access` 在 server/.dockerignore 与项目 .gitignore 中排除；不要移动到公开目录。浏览器打开本机控制台，在 password 框粘贴 token。控制台不会写入 localStorage；断开或离开页面清除其内存引用。关闭控制台不会立即关闭会话，心跳停止后超时回收。操作员 token 可以操控自己所有会话，应与会话控制令牌、只读观看链接区分。

需要持久 Profile 时，在第一次初始化前覆盖命令明确授权：

```bash
docker compose --profile setup run --rm init-access /app/access/access.json operator guest,user1,user2
```

已有配置的管理、增加相互信任的操作员或轮换密钥需先停止 app，私下编辑 access volume 的 JSON 并保持 UID1000/0600。每项格式为 id、随机43字符以上base64url token、profiles数组、maxSessions整数；id和token不得重复，maxSessions不得超过SLOT_COUNT。不要使用示例固定密钥。轮换后重启 app，旧会话不会从磁盘恢复。

## 会话与观看验证

在控制台连接后创建 Guest。确认有随机会话ID、可过期观看链接，HLS分片通常比创建完成晚数秒。先用自己支持HLS的播放器确认画面与音频，再把完整HTTPS观看URL粘到VRChat输入框。

验收至少包括：

1. 没有Bearer不能创建或控制；另一个owner/另一个会话的控制token不能操作此会话；未授权Profile被拒。
2. 没有观看token、错误token或只凭旧Slot不能取playlist/segment。观看token不能调用控制API。
3. 发放新观看链接后旧playlist和segment立即拒绝；关闭后旧控制与观看均拒绝，Slot重用仍不能访问新会话。
4. 停止心跳90秒后访问拒绝，随后目录与子进程回收；Guest不保留，永久Profile只属于对应owner。
5. ffprobe确认H.264/AAC，并实际解码变化的画面与非静音音轨。健康检查不替代此项；抖音可能因登录/验证码/DOM变化而单独失败。

控制台选中会话每30秒发心跳。默认最长1小时；观看链接默认10分钟，需要重新发放并粘贴。不要在个人资料或登录二维码显示时分享。API协议见README；不要把带Bearer的curl命令或完整观看URL粘进公开工单。

## 网络出口

app只连worker网络：`internal:true` 且 `gateway_mode_ipv4:isolated`，没有公网默认路由及宿主bridge IPv4地址；app网络命名空间显式禁用IPv6。Caddy与Squid是双网侧车；app不能直接连公网，Chromium经Squid到公网80/443。Squid在连接目标前拒绝私网、回环、link-local、metadata、IPv6 ULA等地址，CONNECT仅443。出口端口不发布；不缓存或记录访问URL。

Docker旧版本不支持该网络模式，不能删除选项假装保持同等隔离。不要开启host网络或把其他私人服务连进worker网。浏览器仍能访问本worker的本地服务，因此API始终要求凭据；文件、音频和内核边界仍以专用worker为信任域。Caddy默认不启用访问日志，并过滤运行时错误日志的整个request字段，避免502等错误记录观看路径或鉴权头；新增CDN/反向代理/日志采集也需做同等脱敏，不要开启记录凭据或debug请求正文。

官方依据：[Docker isolated gateway](https://docs.docker.com/engine/network/port-publishing/)、[Docker28变更](https://docs.docker.com/engine/release-notes/28/)、[Squid访问控制](https://www.squid-cache.org/Doc/config/http_access/)、[Playwright Docker sandbox](https://playwright.dev/docs/docker)。

## 远端 HTTPS

准备自己的域名、DNS和有效证书。设置示例（替换为自己的真实域名）：

```dotenv
DOMAIN=browser.example.com
PUBLIC_ORIGIN=https://browser.example.com
BIND_ADDRESS=0.0.0.0
SLOT_COUNT=1
H264_ENCODER=libx264
```

确认 DOMAIN 与 PUBLIC_ORIGIN 对应同一站点，再执行 `docker compose config --quiet`、构建并启动。Caddy负责HTTPS，通常需要TCP80/443；HTTP3另用UDP443。主机/云防火墙只放需要的入口，公网禁止8080，Node3000与代理3128均不发布。PUBLIC_ORIGIN不能含路径、userinfo或非本机HTTP，避免Host头参与生成分享地址。

确认浏览器证书、Origin检查、未鉴权拒绝和观看撤销后再让远端客户端使用。公网TLS、DNS和真实PCVR/Quest仍需各部署验收，不是本仓库自动提供的外部服务。

## 数据、停止与故障恢复

`app_data`含owner哈希分层的永久Profile、Guest和HLS；`access`含操作员密钥，Caddy卷含证书/状态。备份前关闭Session，备份按秘密保护。旧 `/profiles/profile_user_1` 等目录不会自动分配给新owner，需明确确认权属并离线迁移，不能让新用户自动继承历史登录态。

```bash
docker compose down
```

上面保留卷。不要对需要保留的配置执行down -v或公开volume备份。正常退出会清理Session并删除 `.worker-lock`；crash或清理失败会保留锁，拒绝另一个worker共享数据。

遇到 stale lock：先 `docker compose down`，确认该专用栈的容器与浏览器/FFmpeg/Xvfb/Pulse进程已经退出，再在离线数据卷维护时删除 `.worker-lock`，随后启动。不要删除仍在运行实例的锁；不确定时停止整个专用VM并核对备份。清理失败后不能仅在API中释放Slot继续服务。

## 可复现的离线媒体验收

镜像构建后可在独立、无网络、无数据卷的临时容器中运行受控动态画面与音频。该命令显式请求启动真实浏览器、显示、音频和编码器；使用约2CPU/2GiB，不要与繁忙会话争用资源：

```bash
docker run --rm --init --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --security-opt seccomp=./chromium-seccomp.json \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 \
  --tmpfs /home/node:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=700 \
  --shm-size 512m --memory 2g --cpus 2 --pids-limit 512 \
  --entrypoint node vrchat-douyin-browser:local scripts/verify-runtime.mjs --run
```

输出仅检查结果、编码/解码统计，不打印密钥或观看链接。成功需要权限检查、Chromium sandbox、变化的视频帧、非静音AAC音轨、HTTP HLS取回、观看轮换及关闭撤销和目录清理全部通过；默认不会作为npm单测自动运行。可选 `--output-dir` 仅接受自己的私有目录，生成独立子目录存报告/抽帧；不要把真实站点或个人画面放进公开报告。

该受控网页测试不证明抖音登录、当前selector或VRChat/Quest播放；这些仍需各自验收。

## 原生 Linux 开发

仅用于专用隔离开发环境；没有Compose的网络出口边界，不作为公网部署配方。安装Node>=20、Playwright Chromium及依赖、Xvfb/PulseAudio/pactl/FFmpeg，然后：

```bash
npm ci --ignore-scripts
npm run install-browser
node scripts/create-access.mjs secrets/access.json operator guest
ACCESS_FILE="$PWD/secrets/access.json" PUBLIC_ORIGIN=http://localhost:3000 HOST=127.0.0.1 H264_ENCODER=libx264 npm start
```

不用共享PulseAudio daemon；每会话启动自己的私有实例。原生npm不自动读.env。root运行与缺少sandbox能力均不应作为部署捷径。单测用 `npm test`；真实VRChat接线与待验收项见 [Unity迁移](unity-migration.md)。

# 安全说明

## 范围与维护状态

覆盖当前源码分支的 Node API、会话编排、示例容器栈和 UdonSharp 只读播放器。没有长期支持分支、响应 SLA 或漏洞赏金承诺。旧匿名 `0.1.0` 接口不适合公网部署；本分支存在破坏兼容的权限和客户端变化。

## 部署前提

- 每个信任域一个专用容器栈/VM。互不信任的操作者必须分离 worker、数据、凭据和网络；不要把同 Unix UID 的多 Profile 或私有 Pulse cookie 宣称为强租户隔离。
- 使用非 root 用户、启用 Chromium sandbox 和仓库 seccomp 配方；不要挂 Docker socket、宿主目录、SSH/云凭据，不要使用 privileged/SYS_ADMIN/宿主 IPC 或关闭 sandbox。
- Compose 要求 Docker Engine >=28，保留 worker 的 internal/isolated 网络与 Squid 出口限制。私有服务不要加入该内网；worker 内服务仅信任本应用的鉴权。公网出口代理不是内容审查系统，不阻止访问其他公网网站。
- 操作员密钥只在控制台本页内存使用，不进 URL、localStorage 或 World。会话控制令牌只授予该会话的操控；观看 URL 是可转发的 bearer，所有分片受相同检查。
- 使用 HTTPS 和匹配的 PUBLIC_ORIGIN；限制公网入口、保护主机及上游网络。反向代理/CDN/监控不得记录完整观看路径，也不得缓存 HLS 或绕过 Node 直接映射数据目录。
- 永久 Profile、Guest、HLS、access volume、证书和备份含敏感信息。只在自己获授权的账号/系统使用；分享画面前检查二维码、账号和私人资料。

## 撤销与故障

观看默认10分钟、会话最长1小时，90秒未收到控制心跳后不可访问；清理扫描默认每10秒一次。重新分享撤销旧观看链接，关闭从开始清理时就拒绝新控制/观看请求。已经交付的分片、浏览器缓存或录屏无法撤回。

Guest 删除不是安全擦除。浏览器/编码器退出无法确认时，worker 拒绝继续创建并保留 Profile/Slot 和数据锁；先停止该专用容器/VM并确认旧进程消失，再按部署文档恢复。不要直接删除运行中 worker 的锁。

浏览器 sandbox、容器内核和上游依赖仍可能存在漏洞。及时更新并重新验收；跨会话显示和音频进程的分离不能替代独立租户实例。不要把本分支称为经过外部审计或已获安全认证。

## 验证边界

本分支有权限、令牌生命周期、请求边界、并发清理及隔离资源的自动测试，并在独立 Linux 环境实测受控动态网页和 WebAudio 到可解码 HLS。抖音实际登录/操作、Unity/UdonSharp、VRChat PC/Quest、公网 TLS 和长期负载尚未完整验收。

## 漏洞反馈

尚未配置并验证私密报告入口。请先在 [仓库 Issues](https://github.com/Rchenickyyyds/vrchat-douyin-browser-mvp/issues) 仅提出联系请求，不公开 exploit、真实密钥、观看 URL、Cookie、二维码或个人数据。维护者确认私密渠道后再交换细节；此文件不代表已有私密接收流程。

报告应包含 commit、受影响配置、隔离复现和脱敏影响。确认问题后核对范围、修复、测试并与报告者协调公开时间；发布日期及履历以真实记录为准。上游 Chromium/Playwright/FFmpeg/Node/Caddy/Squid/Unity/VRChat 的问题也应按各自安全流程报告。

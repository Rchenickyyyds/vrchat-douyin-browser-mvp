# Unity 只读播放器迁移

当前三个 UdonSharp 类型名保留，场景字段和按钮事件有破坏性变更。它们只在本机播放由授权控制端提供的短期 HTTPS HLS 观看 URL。服务器 Session 的创建、控制、续期和关闭由外部受鉴权控制端执行；World 不保存管理密钥、不通过 Display Name 选择已登录 Profile，也不再请求旧的匿名 GET 控制接口。

## 接线

1. 在自己的 VCC World 工程中更新 `Assets/DouyinRemoteBrowser/Runtime/` 三个源文件并重新编译 UdonSharp。本仓库没有完整 Unity 工程，本次尚未完成 Unity/UdonSharp 编译或 VRChat Build & Test。
2. 使用 Worlds SDK 示例的 `VRCAVProVideoPlayer`，将 `DouyinBrowserManager` 放在接收该播放器视频事件的 GameObject 上。保留画面、音频和 AVPro 组件，移除示例同步播放器 UdonBehaviour，避免它另外同步或覆盖播放 URL。关闭 AVPro 的自动播放和循环，清空其默认 URL。
3. 在 World Space Canvas 中添加 SDK 的 `VRCUrlInputField` 输入组件，并保持场景中的默认 URL 为空。使用 `VRC_UIShape` 和 Default 层，按所用 SDK 的输入组件要求接线。
4. 将输入组件拖到 `BrowserSlotUrls.streamUrlInput`，再将 `BrowserSlotUrls`、AVPro、`DouyinBrowserUI` 分别拖到 Manager 的 `slotUrls`、`videoPlayer`、`ui`。UI 的 `manager` 指向同一个 Manager。
5. 建两个 Button：播放绑定 `DouyinBrowserUI.PlayEnteredStream`，停止绑定 `DouyinBrowserUI.StopPlayback`。建两个可选的 Legacy UI `Text`，分别绑定 UI 的 `playbackText` 和 `statusText`。删除原初始化、获取控制权、上一条、下一条、点赞、收藏按钮上的所有旧事件。
6. 通过外部授权控制端创建会话并取得观看链接。由每名获准观看的人在 VRChat 内输入完整链接，再点击播放。本组件只接受 `https://`，不会把响应文本拼成新 URL。过期、关闭或撤销后的链接应由服务端拒绝；新的观看链接需要重新粘贴。

停止会清空本组件持有的 URL 引用和输入框，并停止本地播放器，不会关闭服务器 Session。清空组件引用和输入框不等同于服务端撤销，也不保证抹除 SDK、客户端日志或缓存中已持有的内容；控制端仍须负责撤销或关闭。播放后的 URL 不显示在本组件状态文字中；也不要将链接写入调试日志、录像说明或公开截图。

## 播放与重试

每次加载相隔至少 5.2 秒；一次手动播放最多自动重试三次，每次等待至少六秒。即使中途成功开始播放，该次手动播放的重试次数也不会重置。达到上限后请检查链接有效期、HTTPS、Allow Untrusted URLs 和服务器状态，再由用户明确重试。停止会取消待重试动作。此冷却只覆盖本组件；同一 World 的其他播放器也可能占用 VRChat 的全局五秒 URL 限额。

## 权限与共享边界

三个组件均使用 `BehaviourSyncMode.None`，没有同步 URL、Slot、Profile、控制者字段，也不进行网络所有权转移。默认每名观看者单独输入自己的观看链接，late joiner 不会自动收到链接。Udon 中的本地按钮、Display Name、实例 playerId 和物体所有权都不构成服务端身份凭据。

观看 URL 是 bearer capability：任何获得它的人都可能在有效期内观看和转发。将链接发给别人、在屏幕上展示或自行加入网络同步，都相当于分享对应观看权限。它不能防止录屏，也不能证明观看者的 VRChat 身份。不得把管理员密钥、控制令牌、真实个人 Profile 或长期观看链接预填进公开 World。受信任的 World 仍可能处理用户输入，应只在信任的 World 中粘贴观看链接。

## 官方依据与待验证项

- [External URLs](https://creators.vrchat.com/worlds/udon/external-urls/) 与 [UdonSharp VRChat API](https://udonsharp.docs.vrchat.com/vrchat-api/)：`VRCUrl` 构造器用于编辑期；运行时完整 URL 可从 `VRCUrlInputField.GetUrl()` 获取。自有域名通常需要用户开启 Allow Untrusted URLs。
- [String Loading](https://creators.vrchat.com/worlds/udon/string-loading/)：`LoadUrl` 接收 URL 与回调对象，不提供此项目所需的 POST/Authorization 控制面；每五秒一次且超量可能乱序。因此旧的匿名 GET 控制方式已移除。
- [Video Players](https://creators.vrchat.com/worlds/udon/video-players/)：AVPro 需 Build & Test，无法用 Editor Play Mode 证明播放可用；新视频 URL 存在每用户全局五秒限制。
- [Network Variables](https://creators.vrchat.com/worlds/udon/networking/variables/)：同步变量会发给实例玩家及 late joiner；默认不使用这种方式传递观看权限。

还需在实际 SDK/Unity 工程中验证组件编译、输入接线、HTTPS HLS 播放、停止后不再重试、链接撤销、过期后的行为，以及 PC/Quest 的音视频与多客户端表现。Node/HLS 服务端验证不能替代这些客户端检查。

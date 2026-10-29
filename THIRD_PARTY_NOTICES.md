# 第三方组件与来源

本仓库的源码快照包含浏览器/推流编排、HTTP API、UdonSharp 客户端脚本与配置。第三方代码、SDK、可执行文件、浏览器 Profile、视频、音频及 World 示例素材不随快照打包；安装过程会从上游获取必要运行时。

原创集成代码的项目级许可证待作者确认。此文件是来源清单，不替代各上游许可证，也不将上游组件重新许可。

## npm 依赖

以下版本和许可字段来自 `server/package-lock.json`。`package.json` 的 Playwright 声明为 `^1.55.0`，`npm ci` 以当前 lockfile 的确切版本安装。

| 包 | 锁定版本 | 上游与许可 | 获取方式 |
| --- | --- | --- | --- |
| `playwright` | 1.62.1 | Microsoft / Playwright；[Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) | `npm ci` |
| `playwright-core` | 1.62.1 | Microsoft / Playwright；[Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) | Playwright 依赖，由 `npm ci` 获取 |
| `fsevents` | 2.3.2 | fsevents contributors；[MIT](https://github.com/fsevents/fsevents/blob/v2.3.2/LICENSE) | macOS 可选依赖，不是 Linux 抓流必需组件 |

安装后各包的 LICENSE / NOTICE 保留在其发行包中。`node_modules` 与 Playwright 浏览器下载缓存不应提交到此仓库。若以后分发已构建镜像或二进制，需要单独检查其中实际组件的许可证和 notice。

## 外部运行时与开发工具

| 组件 | 项目中的作用与来源 | 分发情况 |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | JavaScript 运行时；Node.js 主体使用 [MIT 与第三方许可证](https://github.com/nodejs/node/blob/main/LICENSE)；Docker 配方使用 Node 22 | 由用户安装或拉取官方基础镜像，不内置可执行文件 |
| [Chromium](https://www.chromium.org/) | Playwright 启动的浏览器，包含多种上游组件和许可证 | 通过 `playwright install` 获取，不内置 Chromium |
| [FFmpeg](https://ffmpeg.org/) | 捕获画面/音频、编码和生成 HLS | 由系统包安装；具体许可证取决于构建，参见 [上游说明](https://ffmpeg.org/legal.html) |
| [X.Org / Xvfb](https://www.x.org/) | 虚拟 X 显示 | 由系统包安装，保留系统包版权信息 |
| [PulseAudio](https://www.freedesktop.org/wiki/Software/PulseAudio/) | 每个 Slot 的虚拟音频 sink | 由系统包安装，保留系统包版权信息 |
| [Caddy](https://caddyserver.com/) | HTTP/HTTPS 反向代理；上游 [Apache-2.0](https://github.com/caddyserver/caddy/blob/master/LICENSE) | Compose 拉取官方 `caddy:2` 镜像；仓库仅有配置 |
| [Unity](https://unity.com/) | 编辑 World 和运行客户端开发工具 | 用户按 Unity 条款自行安装，仓库不附编辑器或素材 |
| [VRChat Creator Companion / Worlds SDK](https://vcc.docs.vrchat.com/) | 提供 UdonSharp、`VRCUrl`、AVPro 接口、Build & Test 及示例 | 用户从 VRChat 官方渠道安装；仓库不附 SDK、AVPro 插件或 SDK 示例素材 |

FFmpeg 的 LGPL/GPL 范围与所用构建选项有关，不能把本项目未来选择的许可证套到 FFmpeg 二进制上。本源码以子进程调用 FFmpeg；若后续发布容器镜像，应保留实际系统包的版权/许可，并核对相应源码提供等义务。

## 网站内容与名称

抖音网页、视频、音频、商标及第三方账户内容属于各自权利人，不是项目原创资源，仓库不包含或授予其使用权。VRChat、Unity、Chromium、Playwright、Caddy、FFmpeg 等名称用于说明兼容组件和依赖，不表示上游背书。

本快照未加入额外图片、模型、字体、音乐、SDK 或来历不明素材。后续若引入，应先记录具体文件、来源、版本、许可及修改情况。

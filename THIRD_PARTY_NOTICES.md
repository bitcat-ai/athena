# Third-party notices

核查日期：2026-10-31（HugeIcons 依赖于 2026-11-03 核查，agent-browser 于 2026-11-12 核查）。版本来自本次安装的包及锁文件；正式构建以 `package-lock.json` 和实际随包内容为准。

Athena（仓库名 `athena`）的仓库公开可见，项目代码保持 `UNLICENSED`，尚未授予开源许可证。以下许可属于相应第三方组件，不构成对 Athena 本身的 MIT 或其他许可授权。

## 独立进程组件

| 项目             | 本项目使用方式                                                                                                                                                                  | 上游许可                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent-browser    | 0.42.0 官方发布的未修改二进制，作为独立进程运行；首次启动网页功能时下载到应用数据目录并按固定的 SHA-256 校验，不随源码仓库分发；通过其本机 socket 协议连接 Athena 启动的 Chrome | [agent-browser LICENSE：Apache-2.0](https://github.com/vercel-labs/agent-browser/blob/v0.42.0/LICENSE)；[项目说明](https://github.com/vercel-labs/agent-browser/tree/v0.42.0) |
| Google Chrome    | 用户自行安装，Athena 不下载、不分发、不修改；以独立进程和 Athena 专用 profile 启动，页面帧流嵌入 Athena 同窗口的右侧面板                                                        | [Google Chrome 服务条款](https://www.google.com/chrome/terms/)；[Chromium LICENSE](https://chromium.googlesource.com/chromium/src/+/main/LICENSE)                             |
| OpenAI Codex CLI | 用户自行安装并登录，本应用通过其 `app-server` 接口交互                                                                                                                          | [Codex LICENSE：Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE)；[NOTICE](https://github.com/openai/codex/blob/main/NOTICE)                                    |

Electron 包含 Chromium 及其他第三方组件，各组件可能采用不同许可证。保留官方运行时分发随附的完整 LICENSE、NOTICE 和 Chromium 第三方声明；Chromium 本身的许可见 [Chromium LICENSE](https://chromium.googlesource.com/chromium/src/+/main/LICENSE)。

本项目未修改 agent-browser，也没有改变其许可证。若今后把该二进制随安装包分发，需同时附带上游 LICENSE 与 NOTICE；独立进程架构不应被解读为对任何重分发、修改或组合分发义务的豁免，对外分发前需按采用的具体版本和分发形式核对上游条款。

## 直接运行依赖

| 组件                                 | 核查版本 | 许可与来源                                                                                                              |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| Electron                             | 45.1.0   | [MIT](https://github.com/electron/electron/blob/main/LICENSE)；其内含 Chromium/Node.js 的声明另行保留                   |
| `@larksuiteoapi/node-sdk`            | 1.76.0   | [MIT](https://github.com/larksuite/node-sdk/blob/main/LICENSE)                                                          |
| `@a2ui/react`、`@a2ui/web_core`      | 0.14.0   | [Apache-2.0](https://github.com/a2ui-project/a2ui/blob/main/LICENSE)；采用 v0.9.1 协议，Athena 自定义受信任控件 catalog |
| `zod`                                | 3.25.76  | [MIT](https://github.com/colinhacks/zod/blob/main/LICENSE)                                                              |
| React、React DOM                     | 19.3.1   | [MIT](https://github.com/react/react/blob/main/LICENSE)                                                                 |
| `react-markdown`                     | 10.1.0   | [MIT](https://github.com/remarkjs/react-markdown/blob/main/license)                                                     |
| `remark-gfm`（Markdown 表格）        | 4.0.1    | [MIT](https://github.com/remarkjs/remark-gfm/blob/main/license)                                                         |
| `shiki`（Pro 工具参数高亮）          | 4.6.0    | [MIT](resources/licenses/shiki-LICENSE.txt)                                                                             |
| `@hugeicons/react`                   | 1.1.10   | React 渲染器，[MIT](https://github.com/hugeicons/hugeicons/blob/main/packages/react/LICENSE.md)                         |
| `@hugeicons-pro/core-stroke-rounded` | 4.4.0    | 通用操作图标，[HugeIcons Pro 商业许可](https://hugeicons.com/license-agreement)                                         |
| `qrcode`                             | 1.5.4    | [MIT](https://github.com/soldair/node-qrcode/blob/master/license)                                                       |
| `ws`                                 | 8.22.0   | [MIT](https://github.com/websockets/ws/blob/master/LICENSE)                                                             |

按钮 SVG 的悬停动效改编自 [lucide-animated](https://github.com/pqoqubbw/icons/tree/4662fff2b60fdcf4751b32013606756caf7c4c26)，使用 Motion 和原生 Web Animations 播放。作者版权声明和 MIT 许可随应用保存在 [lucide-animated-LICENSE.txt](resources/licenses/lucide-animated-LICENSE.txt)。

## HeroUI 界面组件

`@heroui/react`、`@heroui/styles` 3.2.7 使用 MIT；`@heroui-pro/react` 1.0.0-beta.10 为 NextUI Inc. 的商业授权包，不能把 Pro 包及其源码作为本项目的开源代码分发。具体条款保留在 `resources/licenses/heroui-pro-LICENSE.txt`。安装复用本机授权缓存，缺少构件时通过 `hpsetup` 4.7.4 中转；项目不包含授权密钥或完整 Pro 包。

Motion 14.9.0、`react-resizable-panels` 4.15.3、`tailwind-merge` 3.5.0、Tailwind CSS 4.3.3 及其 Vite 插件均使用 MIT。`react-resizable-panels` 与 `tailwind-merge` 是 Pro 包声明的 peer dependencies；Athena 的浏览器尺寸与坐标校验仍由原有逻辑负责。

Athena 黑白女性侧脸标识为本次 GPT Image 生成的项目素材，存放于 `src/renderer/assets/brand/`，PNG/ICNS 放在 `resources/`，不依赖运行时远程图片。

## CLI 品牌图标

Codex、Claude Code、Gemini CLI、OpenCode 使用 [Lobe Icons](https://github.com/lobehub/lobe-icons) 的专属 SVG（Codex、Claude Code、Gemini CLI 使用上游原色版本，OpenCode 使用原有黑白版本），来自 `@lobehub/icons-static-svg@1.101.0`，固定发布提交 `aea0ecb0fe1439467219197c52ffaeb579dfe33f`。图标保持上游图形与配色不变，随应用内置，不在运行时请求 CDN。

上游为 MIT，Copyright (c) 2023 LobeHub。完整许可随源码及应用保存在 `resources/licenses/lobe-icons-LICENSE.txt`；文件来源见 `src/renderer/assets/agents/README.md`。品牌标识用于识别对应 CLI，不表示本项目与相应权利人存在关联或背书。

Pi 使用 [官方 Press Kit](https://pi.dev/press-kit) 的自适应浅/深色 SVG badge；Cursor 使用 [官方品牌资源](https://cursor.com/brand) 的 2D cube 浅/深色标识。2026-11-05 获取，原始 SVG 未修改并随应用内置。上述品牌资源不沿用 Lobe Icons 的包许可；品牌权利属于各自权利人，仅用于识别对应产品，不表示关联或背书。

## 构建与测试依赖

| 组件                                                                            | 核查版本 | 上游许可                                                                                      |
| ------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `@playwright/test`                                                              | 1.64.1   | [Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE)                       |
| TypeScript                                                                      | 7.0.2    | [Apache-2.0](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt)                   |
| Vite                                                                            | 8.3.5    | [MIT](https://github.com/vitejs/vite/blob/main/LICENSE)                                       |
| `@vitejs/plugin-react`                                                          | 6.1.2    | [MIT](https://github.com/vitejs/vite-plugin-react/blob/main/LICENSE)                          |
| esbuild                                                                         | 0.28.2   | [MIT](https://github.com/evanw/esbuild/blob/main/LICENSE.md)                                  |
| tsx                                                                             | 4.23.15  | [MIT](https://github.com/privatenumber/tsx/blob/master/LICENSE)                               |
| electron-builder                                                                | 26.18.0  | [MIT](https://github.com/electron-userland/electron-builder/blob/master/LICENSE)              |
| `@types/node`、`@types/react`、`@types/react-dom`、`@types/qrcode`、`@types/ws` | 见锁文件 | [DefinitelyTyped MIT](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE) |

本清单列出直接依赖与独立运行的软件，不是完整的传递依赖 SBOM。npm 包内原有许可证应保留；未来对外发布安装包时，应同时核对实际打包的传递依赖和二进制附带声明。

飞书平台、OpenAI 模型服务及其他外部服务的账户和服务条款独立于其 SDK/CLI 的源码许可证；开源许可证不等于免费模型额度或服务使用授权。

A2UI 上游当前仍依赖 Zod 3，`npm audit` 对其 oversized constrained collections 内存耗尽问题报 high（以及上层依赖的派生项），未有兼容 Zod 3 的修复版本。本应用在调用上游解析器之前限制控件数、ID 长度、属性类型、范围和结构；不接收任意 A2UI JSON/表达式/HTML。此处是应用边界缓解，不是上游漏洞已修复的声明。未使用上游 Markdown 控件；传递 DOMPurify 固定到已修复的 3.4.17，未执行破坏兼容性的 `audit fix --force`。

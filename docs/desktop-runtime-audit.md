# Athena 桌面体验与运行时体检

2026-11-20 · macOS Apple Silicon · 本地开发版

## 页面共享

浏览器工具栏提供发起和加入两个入口。收到邀请的人可以直接粘贴链接，加入流程使用独立 Electron 会话。新版链接中的指纹限定本次可接受的证书，旧版链接可手动填写指纹。主持人批准前看不到网页，获得查看许可后仍需另行交接控制权。实际验收覆盖同机 HTTPS/WSS、错误指纹被拒绝、宿主批准到访客看到画面。跨网连接仍需双方网络可达。[使用与连接范围](shared-workspace.md)

## 运行时与生图

- Kimi Code CLI 2.1.1 通过 ACP 接入结构化对话。本机 CLI 与本地模型替身完成图片、原生 Skill、浏览器读回、命令审批、用户问答、停止和续聊。现有登录的无网络握手返回 6 个模型和 136 个 Skill。其内置文件编辑器在 Git 工作区有自行批准写入的行为，结构化对话只开放能兑现宿主审批的工具。[Kimi 适配和验收](mainstream-cli-support.md)
- 在 Agent 菜单打开原生会话会用真正的伪终端在当前工作目录运行所选二进制。原生会话有独立的历史，使用原 CLI 的插件、命令与授权。设置也可发现已安装的其他终端运行时或选择自己的可执行文件。本机查到 Grok 和 Amp。终端窗口没有聊天窗口的宿主桥，访客网页也没有终端桥。终端前端代码按窗口单独加载。
- 本机 Codex 0.171.0 的 ChatGPT 登录报告支持原生生图。此前 Athena 没有消费 `imageGeneration` 事件；原生工具和 Python/Images API 路线有不同的凭据要求。现已让普通 Codex 对话按运行时能力使用原生工具，保存、校验和展示实际图片。隔离测试用真正的 Codex app-server 调用本地 Responses 与 Images 替身，以模拟登录身份完成一次原生图像工具调用，未提供 OpenAI API key。另在 Electron 中验证了图片预览和磁盘产物。服务端账号额度和所选 Provider 仍决定用户当次能否生成。[OpenAI 的协议示例](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/imagegen_extension.rs)

## 输入框

“＋”支持图片与工作区文件，图片可粘贴或拖入，工作区文件也可拖入或用 `@` 搜索。短文本在发送时保存内容快照，大文件和二进制以工作区相对路径引用。草稿、移除、队列取回和历史消息保留附件。斜杠菜单区分应用命令和当前 CLI 的可调用 Skill，支持 Codex 的 `$skill`、Claude 的斜杠 Skill 与兼容命令目录。其他原生命令可在所选 CLI 的原生会话中操作。

交互参考了本机 Codex 桌面资源中的附件和命令入口，以及 Claude 桌面的文件使用说明。实际验证覆盖隔离 Electron、脚本 Pi 协议接收图片和文本、键盘操作、队列重发，以及 760 像素宽窗口。[Claude 桌面文档](https://code.claude.com/docs/en/desktop)

## 响应速度

对同一段网页脚本，旧工具要等光标动画播放结束才交回结果。改动后，页面修改生效即可返回，下一次读取或操作前收起演示。生成代码时，界面也不再随每个文本片段重渲染全部历史 Markdown、重复给右侧位图赋值。

在这台 Mac 上，脚本回执中位数从 1,669 ms 降至 143 ms，可见演示期间宿主捕获帧率从 24.4 提升至 51.7 fps。固定 16 条历史回答和 96 段新增代码，界面帧间隔 P95 从 43.3 ms 降至 10.2 ms，右侧点击到网站确认的中位数从 35.5 ms 降至 15.5 ms。这些数据衡量本机执行和渲染，不含远端模型生成时间。[实验与复测方法](browser-interaction-performance.md)

## 复测

在仓库根目录执行。交互检查使用隔离档案；Kimi 与 Codex 协议检查需要相应的本机 CLI，以下命令使用本地模型服务替身。

```sh
npm run typecheck
npm test
npm run build
npx tsx tests/desktop-entries.e2e.ts
ATHENA_SHARE_LOOPBACK=1 npm run test:sharing
npx tsx tests/kimi-native.e2e.ts --electron
npx tsx tests/codex-image-runtime.e2e.ts
npx tsx tests/provider-skill-send.e2e.ts
```

为 `desktop-entries.e2e.ts` 指定 `ATHENA_DESKTOP_APP`，可在打包后的可执行文件上验证邀请证书、访客批准、原生终端、窗口关闭后的子进程收尾和生成图片的聊天预览。

本机最终检查中，类型检查与构建通过。默认测试集 721 项，664 项通过，57 项按环境条件跳过，失败 0 项；另行运行了上述真实 CLI、Electron 与 Chrome 检查。打包后的 arm64 应用通过 ad-hoc 深度签名及冗余文件检查，并通过同一台 Mac 上两个独立进程经实际局域网地址连接的共享验收。构建仍报告部分前端分块超过 500 kB。这里没有跨物理设备的测试结论，也没有进行远端发行。

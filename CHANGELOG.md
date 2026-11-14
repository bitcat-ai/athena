# 更新日志

## 未发布

- 网页功能改用本机已安装的 Google Chrome 和固定版本的 agent-browser 0.42.0，不再下载、启动或回退到 BrowserOS neo。执行器首次启动时从官方发布下载并校验 SHA-256。
- 工具、审批、恢复屏障、人工接管、录制与共享的行为保持不变；补齐页面脚本、上传、下载、PDF、对话框、差异和标签组，页面脚本在受限的独立进程中运行。
- 网页工具的名称前缀由 `neo_` 改为 `web_`；此前对话中记录的工具调用仍按原样显示。
- 浏览器数据使用新的独立 profile，此前在 BrowserOS profile 中的网站登录需要重新登录；旧的网页任务记录保留在磁盘上，不再在应用内显示。
- Agent 修改、新增或撤销网页元素时，由多枚光标在页面上演示改动过程（选框与尺寸、逐字输入、样式过渡、间距标线、逐层绘制）。目标不在可视区域时先滚动到它。演示只影响画面，页面内容、观察结果、截图和撤销保持不变；手动调整与「减弱动态效果」下不播放。形式参考 Joel Califa 的 [Swarm](https://github.com/DhvanilPatel/swarm-cursors)，为独立实现，未使用其代码或素材。
- Agent 用页面脚本（`web_evaluate_in_page`、`web_run`）改动页面时同样播放光标演示，包括注入带 `!important` 的样式表给整页换风格：脚本运行期间画面保持原样，返回后由光标把可视区域内变化的部分逐块拉开、露出新样子；可视区域之外的改动先不显示，页面随后从顶部向下滚动，光标逐屏把它们画出来，结束后回到原来的位置。光标数量按每一屏要画的内容多少决定，不设上限。脚本结果在演示结束后返回，`web_run` 内连续的改动只演示最初几次。此前这类改动绕过了元素编辑，没有任何演示。

详情见 [网页执行器](docs/web-executor.md)。

## 0.9.0 · 2026-11-06

- 首次准备改为连续对话：欢迎开场、Agent 胶囊选择、选项转为用户回复和短句呈现；回看历史时保留位置。
- 项目文件夹可选。完成真实准备后自动进入主界面，并在右侧打开可交互的 Athena 欢迎页。
- 兼容 Pi 1.x 的扩展隔离；Cursor 目录信任逐次确认，保留 Ask 只读边界；认证和额度错误提供明确提示。
- 补齐 Pi/Cursor 品牌标识及深色显示；纳入本机多 CLI 适配、安装包去重与贡献指南。
- 保持已有数据、钥匙串、审批、停止与网页操作协议兼容。

Codex、Claude 的真实 UI 对话链路已验证。Pi 完整 UI 续聊仍待排查，Cursor 本轮模型验收受账户额度限制，Gemini 真实验收暂缓；本版本不代表所有 CLI 验收全绿。[查看验证矩阵](docs/mainstream-cli-support.md)。

macOS Apple Silicon：

- [DMG 安装包](https://github.com/bitcat-ai/athena/releases/download/v0.9.0/Athena-0.9.0-mac-arm64.dmg)
- [ZIP 归档](https://github.com/bitcat-ai/athena/releases/download/v0.9.0/Athena-0.9.0-mac-arm64.zip)
- [SHA-256 校验文件](https://github.com/bitcat-ai/athena/releases/download/v0.9.0/SHA256SUMS.txt)
- [Release 页面](https://github.com/bitcat-ai/athena/releases/tag/v0.9.0)

## 0.8.0 · 2026-11-04

- 模型选择和推理强度可在同一面板调整。工作台会提示待审批、待回答、需要人工接管的任务，以及 Codex CLI 的可用更新。
- 草稿按工作目录与对话隔离。切换对话或等待发送回执时，后续输入不会被覆盖；后台提问也不会抢走草稿焦点。
- 浏览器从窗口顶部独立分栏，输入框为发送按钮保留空间。改进手机共享检查器的滚动、长任务标题的换行和活动标签的可见性。
- 助手回复支持 Markdown 表格。改进取消任务的状态、用量明细的键盘导航、深色主题和设置分类，并将通用操作图标迁移至 HugeIcons Pro。

macOS Apple Silicon 安装包已完成 Developer ID 正式签名和 Apple 公证，尚无自动更新。

- [DMG 安装包](https://github.com/bitcat-ai/athena/releases/download/v0.8.0/Athena-0.8.0-mac-arm64.dmg)
- [ZIP 归档](https://github.com/bitcat-ai/athena/releases/download/v0.8.0/Athena-0.8.0-mac-arm64.zip)
- [SHA-256 校验文件](https://github.com/bitcat-ai/athena/releases/download/v0.8.0/SHA256SUMS.txt)
- [Release 页面](https://github.com/bitcat-ai/athena/releases/tag/v0.8.0)

## 0.7.0 · 2026-11-02

- 新增沉浸式首次引导：选择与结果保留为连续对话，内容向上推进，顶部渐变模糊；可回看、稍后设置和从设置继续准备。
- 引导接入真实 Codex 检测、官方完整包私有安装、登录与取消、工作目录确认和可选 BrowserOS 准备；旧用户不强制重做，安装与登录结果重新核对后才推进。
- 应用界面采用白底黑灰、柔和表面与统一圆角；首页、侧栏、任务输入、设置、用量、执行记录、页面共享和元素检查器保持一致的视觉语言。
- 首页加入本机用户名与首字母头像、用户菜单、网页上下文菜单，以及浅色、深色和跟随系统外观。
- 新增当前工作区的对话标题与消息搜索，支持 `⌘K`、方向键、Enter 和 Escape；网页获得焦点时不会同时收到搜索快捷键。
- 设置改为独立工作面，保留真实 Codex、BrowserOS neo 和飞书连接状态；保留模型、审批、草稿、停止与用量数据的既有行为。
- 修复空对话与元素编辑之间的切换、深色字段焦点、共享表单焦点与检查器布局细节。
- 精简 README，补充用户指南、AGENTS.md 工程约定和 DESIGN.md 设计规范；保留原有数据目录、钥匙串与工具协议。

直接下载（macOS Apple Silicon）：

- [DMG 安装包](https://github.com/Dylan-Nihilo/athena/releases/download/v0.7.0/Athena-0.7.0-mac-arm64.dmg)
- [ZIP 归档](https://github.com/Dylan-Nihilo/athena/releases/download/v0.7.0/Athena-0.7.0-mac-arm64.zip)
- [SHA-256 校验文件](https://github.com/Dylan-Nihilo/athena/releases/download/v0.7.0/SHA256SUMS.txt)
- [Release 页面](https://github.com/Dylan-Nihilo/athena/releases/tag/v0.7.0)

0.7.0 初版采用 ad-hoc 签名，后续分发包已替换为完成 Developer ID 正式签名和 Apple 公证的版本，版本标签保持不变。尚无自动更新。Codex CLI 和 BrowserOS neo 可在首次引导中按需准备，登录由用户在官方流程中完成；安装包不包含用户登录、聊天或凭据。

## 0.6.1 · 2026-11-01

- 接入独立元素控件库：专用数值滑轨、精确数值输入、颜色编辑、四边内边距、文字对齐和边框样式；保留预览撤销与共享者的独立编辑记录。
- 修复紧凑选择器文字裁切及选中标记与文字重叠，统一展开菜单、键盘选择、焦点和窄容器布局。
- 修复共享检查器在新画面尚未就绪时过早加载详情的问题；只读详情可在新画面确认后恢复，编辑与提交不会自动重放。
- 模型设置改为输入区旁的推理强度滑块，动态读取实际可选模型和推理档位，替代居中模型弹窗。
- Codex 在应用启动、创建和选中对话时提前初始化，模型目录与连续任务复用连接；显示真实的初始化、就绪和失败状态。
- 人工滚动、点击和输入不再取消整轮 AI 任务。页面等待及时让出输入队列，AI 重新观察后继续；中断的写操作仍需核对结果，显式停止继续有效。
- 用量页优先展示 USD 的 API 等价估算，提供费用分项、图表、筛选和费率依据。Token 保留为次级数据，未知或不完整记录不虚构为零；估算不代表订阅实际扣费。
- 网页捕获匹配面板物理像素，减少宽页面的传输和解码开销；保留 Retina 页面布局与坐标映射，修复静态补帧竞争和 URL 同步输入丢字。
- 保留多人共享页面、计划与证据检查点、恢复约束、产物核对和既有用户数据兼容性。

## 0.6.0 · 2026-11-01

- 增加任务计划、工具动作、核对证据、人工处理和产物面板。
- 支持从本机 Codex 目录选择模型和推理强度，并核对真实轮次配置。
- 增加独立用量账本，保留累计去重、缓存用量、缺失数据、取消和重启记录。

## 0.5.0 · 2026-10-31

- 增加复杂网页任务计划、原文证据检查点和未知结果恢复屏障。
- 验证动态表单、iframe/Shadow DOM、分页、多标签及受控上传下载流程。

## 0.4.0 · 2026-10-31

- 增加页面共享邀请、查看/操作权限、控制权交接和双方操作记录。
- 参与者共用同一页面捕获流，慢客户端不阻塞主持人。

## 0.3.2 · 2026-10-31

- 合并连续滚轮增量，修复输入积压。
- 交互期间及时确认画面帧，恢复 Chromium 默认 GPU 加速。

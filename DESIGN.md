# Athena 设计约定

本文件定义当前应用的视觉与交互方向。修改用户可见界面前先读这里，并检查实际组件、状态与数据来源；Figma 是视觉参考，应用能力和真实结果以当前代码与运行验证为准。

## 视觉方向

使用白底、黑灰文字与克制的表面层级。主要操作采用黑色实心按钮；品牌、服务标识和少量状态图标保留颜色，避免把整页染成蓝紫色或用渐变、玻璃效果替代信息层级。

- 主工作区使用 `--surface`，侧栏及次级区域使用 `--background`。
- 卡片用轻柔的 `--surface-shadow` 建立层级；浮层使用 `--overlay-shadow`。不靠连续粗描边分割所有内容。
- 嵌套在卡片里的字段、选项和参数区使用灰色 `--surface-secondary`，不重复叠加阴影。
- 保留必要的分隔线、选中边界、错误和键盘焦点。去掉默认描边不等于去掉可操作性提示。
- 用量、列表和连续内容优先使用自然分组与留白，避免每一行都套卡片。
- 深色模式使用同一套语义 token；不把浅色阴影或白色背景写死在组件内。

当前 token 定义在 [theme.css](src/renderer/theme.css)。通用样式在 [styles.css](src/renderer/styles.css)，各支撑表面有独立样式文件。

| 用途                       | Athena 约定                                    |
| -------------------------- | ---------------------------------------------- |
| 输入框、选择框、灰色参数区 | 12px 圆角；默认无描边；独立字段可用 field 阴影 |
| 按钮                       | 24px 圆角；图标按钮按实际尺寸保持圆形          |
| 卡片、任务请求、共享表面   | 24px 圆角；surface 轻影                        |
| 任务输入框                 | 24px 圆角；工具条始终可见                      |
| 模型与选择浮层             | 22px 圆角；overlay 轻影                        |
| 侧栏导航与选项             | 按上下文使用 12–16px 圆角与灰色选中表面        |

这些是 Athena 在 HeroUI 原生样式上的约定，不代表每个 HeroUI 组件的默认值。不要为了统一圆角覆盖原生焦点、禁用、加载或错误状态。

## 同行控件与点击区域

同一行、同一层级的操作共用一个尺寸档。先使用 HeroUI 的原生 `size`；混排按钮、输入框和选择器时，再由该行统一规定外框高度，移除子项中互相覆盖的旧尺寸。用填色、图标和文字区分主次。验收以实际可交互节点的边界为准：静止时同组高度与垂直中心的偏差均不超过 1 CSS px。仅设置 `align-items: center` 仍可能出现上下边缘不齐。

| 场景                 | 尺寸与行为约定                                                                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 聊天输入工具栏       | 在受支持的桌面窗口，堆叠式 Pro `PromptInput.Action` 和 Send/Stop 为原生 `md`，Agent、模型触发器也用 `md`。四者高 36px；图标按钮为 36×36px，通用 SVG 16px。Agent 触发器优先显示服务原色标识，完整名称放在菜单和辅助描述里；模型触发器保留名称及所选档位。浏览器分栏展开、显示推理档位或切换发送/停止时仍用同一档。 |
| 主工作台与本机浏览器 | 顶栏可点击的连接状态与浏览器开关同高 34px。导航行的后退、前进、刷新为 34×34px，与地址框外壳对齐。浏览器工具行的分段组**外壳**与旁边按钮同高 32px；其内部 28px 选项、地址框内的提交键、标签页内的关闭键是嵌套控件，按各自容器居中。独占一行的操作记录选择器用普通字段高度 34px；底部缩放选择器才用紧凑的 22px。    |
| 共享主持人和访客     | 邀请链接与复制按钮、参与者权限与交接/移除按钮使用 34px。访客地址框与导航按钮共用该行高度：桌面 34px，宽度不超过 700px 时 36px。纯图标导航按钮保持正方形。查看者、等待许可和撤权状态只改变可操作性或可见性。                                                                                                       |
| 主检查器与共享检查器 | 紧凑查找行的选择器、输入框和查找按钮均为 28px；常规参数和底部撤销/源码/预览操作复用 `--ei-height`（34px）。带标题的并列字段还要统一标签行高，保证字段中心对齐。滑轨、拇指和数值输入区分别测量；数字旁的留白、单位以及整行高度都应能把焦点交给数值输入框。                                                         |
| 设置、用量与人工请求 | 模型弹层的刷新/关闭、审批的批准/拒绝、提问的提交/停止分别保持组内 32px。用量筛选器同高 34px，明细标签同高 32px。飞书扫码的打开/取消按钮间隔 8px；凭据折叠入口由 `summary` 自身提供至少 32px 的点击高度。用量的估算说明把留白放进 `Disclosure.Trigger`，点击可见标题行边缘也能展开。                               |

混排字段行的 34px 使用 [theme.css](src/renderer/theme.css) 的 `--control-row-height`。图标按钮的宽、高和命中区域一起验收，不通过横向挤压或拉伸 SVG 补差；状态点、徽标和帮助文字无需与按钮等高。可点击留白使用原生 button、label、summary 或组件原生 trigger 承接，保留 Tab 顺序、焦点和键盘激活。

**窄宽与状态验收。** 在宽桌面及 1060px 最小应用窗口各看一次，并在分栏展开时用长模型名、推理档位和多行草稿复验。浏览器从窗口顶边独占右列，标签、地址和网页工具分三行排列。默认平分两栏，宽窗口中浏览器初始宽度不超过 620px。拖动分隔线时为任务栏保留至少 420px，长模型名优先省略，发送或停止按钮与左侧工具保持同排。相邻控件不得重叠，草稿首行与发送/停止按钮都应可点。共享访客另验 390px 视口。按实际显示行比较中心线，不把合理的换行判为错位。

用实际 renderer 的 `getBoundingClientRect()` 量触发器外框与内部图标，再从边缘内侧点击验证命中；Retina 截图的物理像素和阴影不计入外框。覆盖默认、选中、禁用、聚焦及长内容状态，保留 HeroUI 原生按压动画。聊天与折叠行的回归入口分别见 [首页 UI 检查](tests/homepage-ui.e2e.ts) 和 [用量 UI 检查](tests/usage-currency-ui.e2e.ts)。

工具栏悬停动效由整个 HeroUI 按钮的 hover 状态触发，只变化图标笔画或朝向，保持命中框、文字和焦点环稳定。加号转半圈，前进/后退短暂收回箭杆并回位，刷新图标轻转一次；持续旋转保留给加载状态。触屏、禁用及减少动态效果时跳过悬停动效。Agent 和模型下拉箭头随按钮真实的展开状态转向，关闭后回正；减少动态效果时直接显示最终方向。

## 组件库与版本

交互控件以 HeroUI Pro 为基准。有等价 Pro 控件时直接使用；业务专用控件组合 Pro 的原生 slots 和 HeroUI 基础组件。保留组件自带的按压、键盘、焦点、展开和禁用反馈。以下版本来自当前 [package.json](package.json)，精确安装结果以 `package-lock.json` 为准。

| 依赖                                 | 当前声明        |
| ------------------------------------ | --------------- |
| `@heroui/react`、`@heroui/styles`    | `3.2.7`         |
| `@heroui-pro/react`                  | `1.0.0-beta.10` |
| React、React DOM                     | `^19.3.1`       |
| Tailwind CSS / Vite 插件             | `4.3.3`         |
| React Aria Components                | `1.22.1`        |
| Motion                               | `14.9.0`        |
| `@hugeicons-pro/core-stroke-rounded` | `4.4.0`         |
| `@hugeicons/react`                   | `1.1.10`        |

使用 HeroUI v3 的 compound API，例如 `Card.Header`、`Popover.Content`；交互组件使用 `onPress`。通用选择使用现有 `ChoiceSelect`，工具栏按钮使用 `ActionButton`。保留隐藏的原生表单辅助节点，不用自制点击层破坏键盘操作。

HeroUI Pro 需要有效商业授权。沿用项目安装脚本和授权缓存，不把完整 Pro 包或密钥加入源码；许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 实际组件映射

| 表面                     | 代码入口                                                                                                                                          | 已复用的组件或能力                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 应用壳、侧栏、对话与输入 | [App.tsx](src/renderer/App.tsx)                                                                                                                   | Pro Sidebar、PromptInput、PromptSuggestion、ChatAttachment、ChatMessage 与 ChatMessageActions |
| 本机用户菜单、网页上下文 | [HomeMenus.tsx](src/renderer/HomeMenus.tsx)                                                                                                       | Avatar、Dropdown、Button                                                                      |
| 当前工作区对话搜索       | [ConversationSearch.tsx](src/renderer/ConversationSearch.tsx)                                                                                     | Pro Command；真实标题和消息过滤                                                               |
| 首次配置与继续准备       | [Onboarding.tsx](src/renderer/Onboarding.tsx)                                                                                                     | 连续对话记录、HeroUI 操作与状态表面、真实宿主准备流程                                         |
| 模型与推理强度           | [ModelPicker.tsx](src/renderer/ModelPicker.tsx)                                                                                                   | 单层 Popover、ListBox 与带动态刻度的 Slider                                                   |
| 通用选择与工具按钮       | [ChoiceSelect.tsx](src/renderer/ChoiceSelect.tsx)、[ui.tsx](src/renderer/ui.tsx)                                                                  | Select/ListBox、Button/Tooltip                                                                |
| 执行、计划、核对与产物   | [ExecutionPanel.tsx](src/renderer/ExecutionPanel.tsx)                                                                                             | Pro Timeline、ChatTool；HeroUI Disclosure、Button                                             |
| 审批与结构化回答         | [RequestPanel.tsx](src/renderer/RequestPanel.tsx)                                                                                                 | Pro RadioButtonGroup；HeroUI Card、Chip、Input、TextArea、Button                              |
| 用量与价格依据           | [UsagePanel.tsx](src/renderer/UsagePanel.tsx)                                                                                                     | Card、Tabs、Disclosure、ChoiceSelect                                                          |
| 浏览器画面与工具栏       | [BrowserPane.tsx](src/renderer/BrowserPane.tsx)                                                                                                   | Pro Segment、HeroUI Tabs；现有帧与输入链路                                                    |
| 共享主持人及访客         | [SharePanel.tsx](src/renderer/SharePanel.tsx)、[SharedPage.tsx](src/renderer/SharedPage.tsx)、[SharedSurface.tsx](src/renderer/SharedSurface.tsx) | Modal、Input、ChoiceSelect；真实共享状态与画面                                                |
| 元素检查与调整           | [ElementInspector.tsx](src/renderer/ElementInspector.tsx)、[ElementControls.tsx](src/renderer/ElementControls.tsx)                                | [独立元素控件库](packages/element-inspector/README.md)、受约束的 A2UI 控件                    |

支撑样式分别位于 [agent-experience.css](src/renderer/agent-experience.css)、[model-controls.css](src/renderer/model-controls.css)、[usage-currency.css](src/renderer/usage-currency.css)、[sharing.css](src/renderer/sharing.css) 和 [inspector-surface.css](src/renderer/inspector-surface.css)。

## 品牌与图标

正式应用标识使用 [athena-profile.png](src/renderer/assets/brand/athena-profile.png)，打包图标使用项目既有 resources 资产。不要替换为未选定的 v7 或其他候选素材，也不要引用临时 Figma 图片 URL。

CLI 和服务标识保留上游图形与原色，来源见 [图标说明](src/renderer/assets/agents/README.md)。通用操作图标使用 HugeIcons Pro 的 Stroke Rounded 风格，通过 `HugeiconsIcon` 渲染。语义相同的动作保持一致。

侧栏用户头像来自本机用户名字首字母，名称由本机状态提供；它不是账号登录、云端身份或订阅入口。没有真实账户服务时不添加账户、订阅和计费管理界面。

## 状态与数据

- **首次引导**：使用独立的连续对话流，保留 Athena 的说明、用户点击后的回复和真实操作结果；它不写入项目聊天记录、不调用模型生成开场。开场采用居中的 132px 正式头像与手写式 `hello, Athena.`，动画完成后呈现「开始配置」；首次选择后头像平滑收为 40px，沿用 760px 内容宽度进入对话布局。检测结果使用带服务图标与名称的胶囊选项，选择移动到右侧成为用户回复。说明按完整短句分组呈现，不逐字打字。后续回复采用正常消息字号；检测和连接使用轻量活动提示与同排停止操作，技术详情按需展开，避免大块状态卡与重复的进度文案打断对话。
- **引导滚动与动效**：新内容向上推进；用户回看时不抢滚动，提供回到最新入口。顶部渐变模糊只淡出滚过的历史，不遮当前动作、不拦截点击或键盘。动作由真实事件推进，入场只播放一次；减少动态效果时移除位移、缩放和延迟。
- **准备与恢复**：旧用户不强制重复引导；可从设置重开，未切换目录时退出保留原草稿与会话。项目文件夹可选：未绑定项目时使用 Athena 私有运行目录，界面明确显示「不绑定文件夹」，不把内部路径当作用户项目。选择项目时先选择候选、再确认并核对可访问性；取消不替换旧目录。确认切换项目后，清空未发送草稿与元素源码上下文，防止发送到新项目，已有对话保留。安装、登录和权限不能用定时动画或“我已完成”按钮认定成功，重开时复查已确认条件。浏览器可稍后准备。首次配置完成后，主界面与真实浏览器区域共同进入；浏览器已就绪时显示可交互的 Athena 欢迎页。过渡不修改捕获比例、帧坐标或审批边界。
- **任务输入**：没有文字和图片时不可发送；中文输入法确认不提交；Shift+Enter 换行。粘贴图片使用 Pro ChatAttachment 预览和移除，与当前会话草稿绑定；读取中不可发送，失败保留可移除的附件。发送成功后才清空已提交草稿，失败和停止后保留草稿。
- **上下文**：移除元素引用不自动改写或清空草稿。网页未就绪时，依赖浏览器的操作不可伪装为可用。
- **对话链接与网页**：对话中的 HTTP(S) 链接在右侧 Neo 新标签打开，保留当前页；浏览器未启动时按点击意图启动，失败显示具体原因，不自动跳到系统浏览器。安装、登录和系统服务链接沿用各自入口。
- **页面结构预览**：Agent 可通过现有元素编辑链路创建嵌套 HTML 元素。创建后返回新引用并同步检查器、预览记录和撤销；页面有后续修改或输入时拒绝删除较新的内容。原生网页动作继续使用 Neo 引用，不混用检查器引用。预览不代表源码已保存。
- **任务进行中**：可继续编辑草稿，但不把草稿显示为已加入发送队列；停止按钮停止当前任务。未经实现与验证，不增加自动排队行为。
- **计划与结果**：展示公开计划、真实工具动作、核对证据、人工处理和产物；不编造进度百分比、成功结果或隐藏推理。
- **CLI 与模型**：新对话使用应用默认 CLI，已有会话固定执行器，切换 CLI 创建新对话而非搬运原始会话。模型选项来自当前 CLI 能力，目录、选择和缓存按 CLI 隔离；没有模型目录时沿用本机默认配置，不填入猜测项。用户选择与实际本轮执行模型分别确认，安装检测不等于登录或真实执行已验证。
- **运行时设置**：顶部展示当前查看的对话所使用的 CLI、连接状态、版本、位置和下次任务模型；执行模型来自该对话最近一轮的 CLI 回报，不以默认模型或早前一轮补全未知值。新对话默认配置独立呈现，明确未单独选模型的对话会继承默认模型；完整安装列表按需展开。
- **用量**：保留 **USD API 等价估算为第一主指标、每日 USD 图优先**。Token、输入/输出为次级数据；Figma 的 Token 优先例图是较早快照，不得据此反转当前产品行为。
- **未知值**：缺少费用、费率、模型或 Token 字段时保持未知/部分数据；真实零值和未采集到数据必须区分。API 等价估算不是订阅实际扣费。
- **共享**：角色权限与当前控制权分开表达；仅查看者不能操作。共享结束后显示结束状态，不继续显示可操作或可交接。
- **错误与恢复**：保留具体失败与可行下一步；结果未知时先核对，不能用“重试”暗示可以安全重复提交。
- **App 提醒**：成功、操作错误、连接异常和版本更新统一放在窗口右上角，作为浮层显示，不挤压内容。普通提醒自动消失，悬停或键盘聚焦时保留，相同提醒合并；可手动关闭，显示时不抢焦点。长错误可换行和滚动。
- **提醒与 Agent 交互分开**：任务计划、执行过程、审批、补充信息和人工接管属于对应对话的交互面板，不进入 App 提醒层，也不由提醒消失代替确认。用户主动打开的设置、搜索、共享及删除确认保留各自交互。

产品文案只服务用户任务。需求描述、开发状态、设计理由、技术取舍和审计说明应放在文档或开发工具，不进入按钮、空状态、提示卡片或演示数据。

## 设计参考与实现边界

- [主应用与支撑页面](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB)
- [当前首页交互](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB?node-id=104-1874)
- [首次引导](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB?node-id=126-3379)
- [用量参考](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB?node-id=31-1079)
- [共享桌面与手机参考](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB?node-id=31-1494)
- [Agent 工具执行](https://www.figma.com/design/jIaBK8NMvfZsjuMktNwpfO?node-id=14-1092)
- [Agent 提问与结构化回答](https://www.figma.com/design/jIaBK8NMvfZsjuMktNwpfO?node-id=9-3819)

当前界面已接入首页菜单/搜索、真实 Codex 任务、模型与用量、元素编辑、页面共享及已有飞书配置。设计中的样例人物、任务、金额、文件和网页内容必须替换为应用实际数据。

CLI 支持范围与各自的真实验证边界见 [本机 CLI 适配](docs/mainstream-cli-support.md)。通用 MCP 服务配置与管理、多 Agent 并行调度、账户/订阅服务和桌面 Computer Use 尚未实现。已有内部 Neo MCP 网页工具链不等于通用 MCP 产品能力；Figma 中的未来状态不能作为后端支持证明。

主持人共享沿用现有 Modal 入口；访客页沿用实际共享流。若设计参考中的按钮没有对应权限或协议，先保留准确状态，不放置无法兑现的操作。

## 验证要求

先完成与改动相称的类型、功能和隔离 UI 检查，再看真实渲染。检查焦点、键盘、输入法、草稿、加载、失败、停止、窄窗口和减少动态效果；滚动区内部裁切与非预期溢出要分开判断。

截图必须来自当前真实应用或明确标注的隔离组件测试，不能用 Figma 稿替代实现证据。共享帧和第三方网页保持真实内容与原比例；不要为了视觉对齐改变点击坐标、文档代次或权限验证。

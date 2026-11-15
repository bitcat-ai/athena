# Athena UI V2 · 首页交接

[打开当前首页 Section](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB?node-id=104-1874) · [查看默认首页](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB?node-id=31-229) · [其他界面与控件基线](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB?node-id=44-5286)

前轮推进 [首页 Section](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB?node-id=104-1874)，后续页面逐页处理。首页已有的默认、浏览器展开与选取视图在同页归入该 Section，其他页面未重排。Section 内共 21 个直属 Frame：13 个全屏首页视图（3 个既有、10 个新增）、6 个状态板及导航索引/行为说明各 1 个。状态与能力边界见 [homepage-state-spec.json](homepage-state-spec.json)，本轮证据见 [首页记录](verification/homepage-refinement.json)。

用户菜单、对话搜索与「＋」网页上下文入口是新增设计，尚未进入应用源码；其中设置、用量、工作目录和网页操作沿用现有能力。默认用户头像为 D，不表示已接入账号系统；没有新增登录、订阅、文件上传或任务队列。正式 Athena Logo 与用户头像分别表达产品和本地用户。

首页沿用 **Revision04 表面精修**：白色工作面 `#FFFFFF`、浅灰画布 `#FAFAFA`、黑色主操作 `#171717` 与彩色 logo/icon，以填充和轻阴影组织层级，减少侧栏与属性分组的装饰线。字段圆角 12px，按钮、面板与输入区 24px，选择浮层 22px。

普通字段默认无描边，浅色主字段使用轻影；卡片或浮层内的字段使用次级灰填充，不叠加第二层阴影。深色字段与输入区同样使用次级填充，不套用浅色投影。焦点、错误、选中状态和有意义的数据边界保留。Figma 使用 Inter、Noto Sans SC 与 JetBrains Mono，专用控件继续保留比例样张、精确读数、细滑轨、颜色棋盘、边框预览和四向间距结构。

Input、Button、Card 与 Select 的部分圆角和轻影来自 [HeroUI 原生资料](verification/heroui-native-reference.json)；输入区 24px 加轻影、导航选中表面和较弱的深色浮层内描光属于 Athena 定制，不能描述为所有 HeroUI 组件的统一默认值。网页取色、CSS、diff 和任务样例的内容值保持原样。此前的 recipe 与证据见 [表面精修记录](verification/heroui-surface-refinement.json)。

## 首次引导与原生动效 · 2026-11-02

已在同一主文件新增 [首次引导 Section](https://www.figma.com/design/vEL0JeDlefvuvLjUQQh5SB?node-id=126-3379)，含 **35 个流程画板、3 个适配画板、6 段原生动画、3 块规格和导航索引**。另有 1 个组件容器，Section 共 49 个直属节点。

开场按用户反馈改为头像与「你好，我是 Athena。」横向排列。安装、登录、工作目录与权限、可选浏览器、进入工作台及取消/失败/恢复已串联；关键回复变形和工作台展开接入点击原型。动画已导出逐帧检查，真实系统动作仍待实现。

- [完整交接与动画节奏](onboarding-handoff.md)
- [对话、条件、动作和真实 node ID](onboarding-state-spec.json)
- [本轮结构与逐帧验证](verification/onboarding-final-review.json)
- [进入工作台动画](previews/onboarding/workspace-entry.mp4)

本轮没有修改应用源码或改变真实安装、登录和系统权限；原首页及其他既有页面保持原设计。等待时的原型跳转仅模拟事件回调。

## 交付范围

| 交付 | 主要内容 |
| --- | --- |
| 主界面稿 | 20 张界面与视图变体，含五个元素编辑 tab、浅深色、窄窗口、共享查看者、浏览器与飞书设置 |
| 元素控件 | 85 个控件状态、9 个行为族、27 个可调整属性；另有选取、预览恢复和属性目录 |
| 独立 Agent 稿 | 175 个标准案例、227 个源状态别名、16 个状态族；覆盖回复、QA、审批、Skill、MCP、工具、产物及恢复 |
| 组合场景 | 7 个完整桌面对话场景、3 条恢复流程、8 个富产物与结构化输入样例 |

前轮全局审阅基线为 **101** 张主要画板：主稿 49、Agent 稿 52；Revision04 表面精修复查了 15 张代表画板。本轮首页的 21 个直属 Frame 单列在 manifest 的 `homepageSectionArtifacts`，其中包含 3 个既有画板，不能与旧 101 简单相加。本轮没有重新审阅全部文件。逐项真实 ID 和入口见 [figma-manifest.json](figma-manifest.json)。

2026-11-02 已删除三页 R1 旧稿、两张旧展示板和五个无现行引用的组合组件，主文件仅保留 6 个当前页面。清理后现行画板、组件实例与导航引用均完整。

## 原型与状态说明

本轮首页最终读回 **152 条连接目标记录：150 条 `NAVIGATE`、2 条 `SCROLL_TO`，失效目标为 0**。这是导航动作记录数，并非 152 个不同目的地，也不表示真实业务可运行。状态板中的 `SCROLL_TO` 仅定位静态样例；真实输入/IME、搜索索引、模型保存、系统目录选择、任务执行和录制持久化未模拟。以 [最终结构读回](verification/homepage-final-structure.json) 为准，构建中间记录不作为最终证据。

前轮记录为：主稿 107 条导航，Agent 稿 6 条点击连接和 1 条自动演示转场。主稿更早的写入记录为 109 条，空输入演示修正后为 107 条；这些属于历史阶段，不冒充本轮最终原型数量。

控件行为映射和条件说明单独记录，**不计为可执行原型连线**。悬停、键盘、拖拽和异常状态图也不代表这些行为已全部实现为动态原型。

## 设计与实现边界

这次交付是设计稿与交接规格，未修改应用源码或部署。当前只有 Codex 可执行；其他 CLI 只检测安装状态。浏览器控制已存在，原生桌面 Computer Use 仍属研究范围。

`current` 表示现有状态或数据契约，`mixed` 表示部分能力已有但新面板需扩展，`extension` 表示前瞻设计。通用 MCP 管理、MCP Apps/Tasks、多 Agent、后台调度和队列不能在现有产品中伪装成已可用。详见 [implementation-boundaries.json](implementation-boundaries.json)。

## 交接资料

- [design-tokens.json](design-tokens.json)：浅深色、圆角、描边、轻影、尺寸及原 `--ei-*` 控件 alias 映射。
- [homepage-state-spec.json](homepage-state-spec.json)：首页视图、6 个状态板、11 个输入状态和设计新增边界。
- [agent-state-spec.json](agent-state-spec.json)：状态、用户文案、动作、显式语义 fixture 与别名。
- [inspector-state-spec.json](inspector-state-spec.json)：85 个控件状态、行为转换、五个 tab 和属性边界。
- [research-sources.json](research-sources.json)：原有 43 个官方网页来源、设计判断及新增 HeroUI 原生资料入口。
- [figma-manifest.json](figma-manifest.json)：真实文件、页面、画板、组件与原型连接 ID。
- 本轮首页预览：[默认首页](previews/homepage/home.png) · [用户菜单展开](previews/homepage/user-menu.png)。
- 前轮预览：[首页 · 正式 Logo](previews/homepage-logo.png) · [元素编辑](previews/heroui-surface/element-inspector-light.png) · [Agent 交互](previews/heroui-surface/agent-interaction.png)。

## 验证状态

**本轮首页设计范围已通过：13 张全屏首页视图与 6 张状态板，共 19 张 UI 画板完成静态视觉复查。** 另 2 张索引/行为说明仅做结构检查。未发现重叠或非预期溢出；长草稿保留 160px 高的内部垂直滚动视口。模型弹层按实际内容收为 432×144，头像、默认/悬停/焦点、输入、上下文移除及停止后草稿状态已复查。详见 [首页最终审阅](verification/homepage-final-review.json)。

模型/浏览器状态板从原板 `54:2116` 派生，原板 573 个节点前后比较无差异；首页 Agent 选择覆盖可用、不可用和任务中 3 种状态。全局历史报告保持原样，不继承为本轮首页验收，也不将本轮首页完成解释为所有页面已完成。

前轮表面精修完成 15 张代表画板视觉复查：主稿 10 张、Agent 稿 5 张。深色绑定颜色、重复阴影、白色色样边界及悬停区别的记录见 [主稿复查](verification/heroui-main-surface-refinement.json) 与 [Agent 复查](verification/heroui-agent-surface-refinement.json)。主稿包含深色代表界面，Agent 该轮没有新增深色视觉审计。

[前轮主稿结构回读](verification/heroui-main-geometry.json) 确认当时 49 张画板与 107 个原型目标有效，无非预期溢出；20,000 字的 T05 样例在 448×72 的垂直滚动视口内有意裁切。当时新增 20 个分段 tab 外层容器，原 tab ID 保留。Agent 的 52 张画板和 175 个状态保留，未重做全状态语义审计；两处总览说明另行更新为 Revision04。

前轮 [黑白主题记录](verification/monochrome-retheme.json) 的 84 个颜色值、96 组对比度与 13 张代表视觉结果完整保留，不写成本轮重新测量。更早的 [冰蓝设计验收基线](verification/design-acceptance-summary.json) 同样保留。旧报告和旧截图只证明对应阶段；本轮没有宣称全量 101 张重新截图验收。

这些结果针对可编辑设计、静态状态与明确的配色组合，**不代表运行时交互、真实键盘/读屏/IME、媒体播放、网络授权或完整 WCAG 审计通过**。本轮没有修改或部署应用。

交接资料不含临时 Figma asset 地址、会话 UUID、凭据或实际工具日志。源码引用使用仓库相对路径，网页来源保留官方 HTTP(S) 链接。

首页局部细化：侧栏与欢迎区已使用应用当前的正式人物侧脸 Logo，分别为 34px 与 56px；仅更新首页，记录见 [Logo 接入验证](verification/homepage-logo-integration.json)。

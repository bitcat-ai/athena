# Computer Use 上下文交接

更新日期：2026-11-01。本文件供 Athena 项目中的后续聊天接续工作；完整技术依据见 [Computer Use 调研报告](computer-use-research.md)。

最新整合版本为 **0.6.1**，本机构建 `release/v0.6.1/mac-arm64/Athena.app`。该版本合入 `codex/element-inspector-kit` 的专用控件，包含此前主工作区的浏览器与 Agent 修复，并修正选择器裁切/图标重叠及共享详情加载时序；近期变化见 [更新日志](../CHANGELOG.md)。其他独立功能 worktree 不因本次同步自动合入。

最新浏览器预览修复：[v7 面板像素捕获](v7-capture-size.md)。独立包为 `release/logo-v7-capture-fix/mac-arm64/Athena.app`，已按实际面板物理像素捕获并验证滚动位置帧率、末次滚轮事件后拖尾及坐标回归；不是桌面 Computer Use 的实现。

后续交互版本：[交互体验修正](interaction-refinement.md)，独立包 `release/interaction-refinement/mac-arm64/Athena.app`。包含上述 v7 捕获修复，并增加统一选择菜单、推理滑块、Codex 预热复用、人工操作不中断整轮任务和 USD API 等价估算。

## 已确认的需求与当前阶段

用户最初要求调研在 Athena 中加入 Computer Use，并明确选择：**“两者都要，优先本机 Mac”**，即本机 Mac 应用控制和隔离桌面都要考虑，本机优先。

目前完成的是调研与上下文整理。Cua Driver、Peekaboo 以及阶段顺序属于方案建议，尚未确定最终依赖或开始实施。后续用户明确要求实现时，按其新指令推进，不需要重新询问已经确认过的环境优先级。

本次调研没有安装驱动、修改系统权限、控制桌面或执行额外模型 API 测试；这不代表整台 Mac 没有安装其他自动化工具。项目中尚未实现桌面 Computer Use，兼容性、成功率与任务成本没有实测结果。

## 项目与资料位置

- 当前实际目录：`/Users/dylanthomas/Desktop/projects/athena`。
- Codex 已登记本地项目 `athena`，绑定上述目录。
- 仓库：<https://github.com/Dylan-Nihilo/athena>。
- 交接基线：0.2.4，提交 `083385e7e90c04e04629a202dc1721bb874e7649`；继续前仍须检查当前 HEAD 和未提交改动。
- 迁移保留了 Git 历史、依赖、构建产物和未提交的调研报告。旧目录是兼容链接；同级 `browseros-runtime` 链接指向原有 BrowserOS 运行时，不需要重复下载。
- 本次交接没有发布新的版本、推送调研文件或改变当前运行中的应用。

## 调研建议，尚未实施

1. **先复用现有 CodexSession。** 动态工具注册、调用分发、文字和图片返回链路已经存在。第一阶段不必重写模型接入层。
2. **本机执行器优先验证 Cua Driver，Peekaboo 作为备选。** 调研时 Cua Driver 0.38.0 的原生发行标为 Pre-release；Peekaboo 4.9.7 是正式发行。采用前重新核验版本、接口及许可，不将这些快照当作长期最新状态。
3. **保留 BrowserOS/CDP。** 网页继续使用已有精确 DOM 操作，桌面控制补足原生应用和没有结构化接口的场景。
4. **隔离桌面放在后续阶段。** 可先接 Linux 环境验证通用接口；需要 Mac 原生软件时再评估 Lume/macOS guest。驱动运行在 guest 内，环境创建、销毁、共享目录和费用由单独的环境管理层负责。

推荐分层是：模型适配器 → Athena 的授权与任务控制 → BrowserRuntime 或 ComputerRuntime → 本机/隔离环境中的驱动。任务 UI 和记录格式可以复用，但不同环境不能共享一次无限制授权。

Cua 官方提供 TypeScript 与 Electron 嵌入路径，原生 helper 需要放在 ASAR 外并由权限所属进程启动。SDK/native executable 的实际组合、Electron 45.1.0、签名及 TCC 归属仍需验证。Driver 的 MIT 许可不能推广成整个 Cua 平台均为 MIT；Spaces 等组件与可选模型存在不同许可，macOS 虚拟化还需单独核对 Apple 条款。详见报告中的官方链接。

## 可以复用的代码入口

| 入口                                        | 当前用途                                                 | 后续注意点                                                                              |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/main/agents.ts`                        | `CodexSession`、动态工具、`item/tool/call`、`inputImage` | 新增工具按现有 fingerprint 机制更新执行会话；不要假装旧会话已经获得新工具               |
| `src/main/main.ts`                          | 工具路由、任务状态、审批分发、飞书入口                   | 桌面动作需独立的宿主授权路由；不能把桌面请求直接当成 Codex command/file 请求回复        |
| `src/main/browser.ts`                       | 页面引用、输入、控制权撤销、截图、录制                   | 复用设计经验，不把浏览器 CSS 坐标直接套到多屏桌面                                       |
| `src/renderer/RequestPanel.tsx`             | 用户允许、拒绝和回答界面                                 | 可复用界面；桌面授权的数据和生命周期另行处理                                            |
| `src/renderer/BrowserPane.tsx`              | 帧展示、缩放及解码后的输入校验                           | 桌面要另处理原生窗口边界、Retina、多屏原点和失效截图                                    |
| `src/shared/types.ts` / `src/main/store.ts` | 当前步骤结构与持久化                                     | 现有录制偏 URL/tab/frame，聊天和记录为普通 JSON，不能默认存入完整桌面截图和敏感 AX 内容 |

## 必须保留的边界

- **CLI 只读沙箱不约束宿主自定义工具。** `callTool` 在 Athena 主进程执行，因此桌面操作必须由 Athena 校验任务、环境、应用和窗口范围。
- **飞书配对不等于整机授权。** 不能把已有远端消息入口自动升级为本机桌面控制；本机与隔离环境、浏览器与通用键鼠分别授权。
- **先观察，再操作，再验证。** 动作绑定观察引用及明确窗口；旧截图、窗口变化和过期引用需重新观察。结果未知时先检查状态，不盲目重放。
- **有真实的停止与接管。** 验证用户键鼠操作、窗口变化、弹窗、锁屏及停止时的行为；不能只取消模型输出而继续发送排队输入。
- **后台操作有边界。** 某些窗口和手势需要前台或会拒绝执行，不能承诺任意应用完全不打扰用户。
- **截图流向要明确。** 本机执行不代表数据不出机；交给云模型的截图与 AX 文字会进入相应推理服务。

## 已有兼容标识

产品、界面和仓库名称为 Athena / athena，但以下标识为兼容旧数据、钥匙串和会话而保留：

- Electron bundle ID：`app.agent.workbench`。
- 内部 `app.setName('Agent Workbench')`；窗口、菜单和 About 对外显示 Athena。
- 默认数据目录：`~/Library/Application Support/Agent Workbench/`；`WORKBENCH_USER_DATA_DIR` 覆盖仍有效。
- 现有 `WORKBENCH_*` 环境变量、`workbench:*` IPC、`workbench_browser_*` 工具 ID 和 CLI client ID。

桌面 helper 的权限归属应绑定真实 bundle ID，不能因品牌叫 Athena 就直接改成新的 ID。若后续确需身份或数据迁移，应作为明确的迁移事项处理，而不是批量替换字符串。

## 建议的下一步验证

当用户要求开始 POC 后，按以下顺序执行并记录实际结果：

1. 验证驱动版本、构件许可、打包、签名和权限所属进程。
2. 指定一个测试窗口，只读取得截图与 AX 信息，验证权限拒绝/撤回、窗口关闭、锁屏和多屏坐标。
3. Calculator 计算并读回；TextEdit 中文输入并保存到测试目录；Finder 选择测试文件。
4. 验证停止、人工接管、过期截图、窗口切换、重复动作及未知结果恢复。
5. 再扩展到 Excel 测试表格、飞书草稿和隔离环境；创建与借用资源分开，默认不挂载个人目录或继承全部账号。

验收必须来自实际应用状态或文件内容。已有浏览器测试、上游演示及模型的“已完成”消息，都不能代替 Athena 桌面 POC 的成功证据。独立 API 认证、模型费用、VM 费用与真实任务成功率仍需后续实测。


## 2026-10-31：多人共享浏览器页面（任务 1）

0.4.0 的 Share 实现已加入当前工作树，详见 [共享工作区页面](shared-workspace.md)。共享的是当前权威 BrowserOS 标签页；B 的独立浏览器接收同一捕获流并通过页面白名单操作。没有实现或验证 Mac 桌面远控。A 的明确加入确认、参与者凭据、控制权代次、画面/文档代次、预览作者和断线取消共同限制输入范围；Agent 在共享期间不接管页面。

入口：`src/main/sharing.ts`（HTTPS/WSS 会话与权限），`src/main/browser-actions.ts`（共享与原 IPC 复用的页面命令），`src/renderer/SharePanel.tsx` / `SharedPage.tsx`（双方界面）。BrowserRuntime 仍是唯一页面所有者；保持 0.3.2 滚动合并和全部兼容标识。新增记录的参与者字段和共享分段字段均可选，不迁移旧数据或钥匙串。

独立的 0.4.0 应用已通过 loopback 和局域网接口的双进程客户端验收：共享滚动约 58fps，慢客户端不阻塞主持人；未共享时的 0.3.2 宽页滚动回归也通过。开发态 Electron 曾等待系统入站确认，独立包实测可达；本次未改防火墙规则。物理另一台设备、VPN 和公网链路未验证，未部署外部中继。源码未提交/推送，构建仅在 `release/sharing/mac-arm64/Athena.app`。任务 1 正式完成和下一项启动以 `.runtime/feature-goals-20261031/state.json`、最终交接和 goal 状态为准。

## 2026-10-31：复杂 Agent 网页任务（任务 2）

0.5.0 继续复用 CodexSession 与 Neo 原生 act/run/read/wait。`src/main/web-execution.ts` 提供公开计划、原文证据检查点和任务内恢复屏障；`web-runtime.ts`（当时名为 `neo-browser.ts`）串行校验/派发，拒绝未知结果重放并记录下载文件证据。`agents.ts` 拒绝重复 callId，接收公开 plan 通知并记录工具耗时。主进程持久化 `ChatMessage.plan/execution`，未核对的结果不能以成功完成；重启不自动重放。

真实 CLI 的正常和回执异常多步骤工作流已完成本地页面、服务端唯一订单与 CSV 文件回读。原生测试另覆盖旧引用、条件等待失败、人工帮助、接管取消、晚到确认和有界脚本。详细证据与复现见 [复杂网页任务执行](complex-web-tasks.md) 和 `test-results/complex-agent/verification.json`。模型选择、usage、费用与新增交互面板仍由任务 3 处理。

共享期间先停止共享才能启动 Agent；任务 1 的参与者、控制权、帧/页面代次、预览作者和清理边界保留。下载默认目录属于 Athena 自有浏览器 profile，原有共享下载 deny 继续生效。没有外部站点、真实登录/验证码、支付或桌面控制验收，没有提交、推送或公网部署。独立构建在 `release/complex-agent/mac-arm64/Athena.app`，不替换 `release/sharing` 或既有预览。正式完成状态仍以队列 state.json、最终交接和 goal 状态为准。


## 2026-11-01：Agent 交互、模型选择与用量（任务 3）

0.6.0 已完成公开计划/动作/证据/人工处理/产物面板、真实 CLI 模型选择与独立用量页，详见 [Agent 交互与用量](agent-experience.md)。模型目录取自 model/list；turn/start 传递真实选项，按本线程、本轮 turn_context 核对实际配置，处理 model/rerouted，不把上一轮或模型自述当作当前执行证明。已结束轮次在读取模型记录期间也拒绝晚到工具和审批；用量事件仍按原 thread/turn 归档。

usage.json 是独立本机账本，使用真实累计基线和最新快照更新，重复事件不相加；继续会话、错误、取消和重启均已验。输入/输出/缓存读取/缓存写入缺失时保留未知或部分数据；旧任务没有可信记录时不估造。日期按任务开始日和本机时区分组。费用不可得，不使用 API 估算冒充订阅账单；当前仍仅接通 Codex。

全量单元测试 165 通过、13 环境跳过，最终原生专项 23 通过；CLI 3 轮与独立应用 4 轮真实模型验收、重启、键盘、减少动态效果、窄窗口、产物宿主验证和共享拒绝均通过。既有 fit-width 帧等待曾间歇超时，最终整套重跑通过；未改浏览器实现或原断言，原因未证实，原失败日志保留。错误提示的 HeroUI 类名冲突已通过受控事件复现并修复。

独立构建 `release/agent-experience/mac-arm64/Athena.app`，ad-hoc 深度签名校验通过，未公证。0.3.2/0.4.0/0.5.0 未提交成果、原构建、旧滚动预览和无关品牌图片均保留；没有提交、推送或公网部署。证据为 `test-results/agent-experience/verification.json`。桌面控制、外部登录/验证码/支付/OAuth 弹窗仍未验证。任务 3 是队列最后一项；不得据本交接创建第 4 项。

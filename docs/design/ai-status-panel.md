# Athena AI 状态交互面板 · 重新定义

状态：已实现（未提交） · 2026-11-10。落地时的调整见 5、6 节。

组件面板（全部状态的可交互预览）：[ai-status-panel.html](./ai-status-panel.html)

## 1. 现状诊断

同一件事在三个地方出现，而真正的回复被挤到最下面：

| 现有组件                                         | 位置                                                                                    | 问题                                                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkbenchNotices` 横幅「任务等待审批 / 去回答」 | 顶栏下方                                                                                | 和下面两处重复；占一整行；跨会话提醒却用了全局横幅                                                                                         |
| `ExecutionPanel`（每条 assistant 消息内的卡片）  | 对话流内                                                                                | 一张卡里塞了 9 个区块：标题态、模型、目标、计划、注意事项、工具（最近 4 条）、核对结果、产物、失败原因。运行结束后不收起，回复文本在它下面 |
| `RequestPanel` 审批 / 提问卡                     | 输入框上方                                                                              | 出现时把 composer 压到 72px，布局跳动；和横幅、ExecutionPanel 的「处理请求」按钮三选一                                                     |
| 其它                                             | 顶栏 Agent pill、侧栏 spinner、浏览器页脚 `.browser-agent-status`、toast、composer hint | 各自读不同的状态源                                                                                                                         |

状态源本身也是问题：renderer 只拿到一个全局字符串 `statusLabel`，靠「是否包含“停止”」之类的字符串判断来决定图标。QA 只是 checkpoint 列表 + 一个「继续核对」按钮，按钮的作用是把一段固定话术填进输入框。

## 2. 设计原则

1. **一个状态机，一个真相。** host 发显式 `phase`，renderer 不再解析文案。
2. **过程、请求、结果三层分离，各占一个固定位置。** 同一时刻每层最多一个 surface。
3. **回复优先。** 过程默认折叠成一行，结束后变成一行摘要；用户想看才展开。
4. **请求出现在手边。** 需要你操作的东西出现在输入框的位置（而不是输入框上面再叠一张卡），因为那是你的注意力和光标所在。
5. **跨会话只做提示，不做抢占。** 其它会话的请求用侧栏徽标 + 顶栏小点表示，不弹横幅。

## 3. 状态机（host → renderer）

```ts
type TurnPhase =
  | { kind: 'preparing' } // 连接 Agent / 启动 Neo
  | { kind: 'thinking' } // 模型推理，无工具
  | { kind: 'acting'; tool: string; target?: string } // 执行工具
  | { kind: 'verifying'; checkpoint: string } // 正在核对结果（checkpoint）
  | { kind: 'waiting'; request: 'approval' | 'input' | 'handoff'; requestId: string }
  | { kind: 'stopping' }
  | { kind: 'ended'; outcome: 'succeeded' | 'blocked' | 'failed' | 'cancelled' };
```

- `AgentEvent{type:'status'}` 携带 `phase`（旧 `status/label` 字段保留一个版本用于兼容 Feishu 等消费者）。
- `ChatMessage.phase` 持久化最后一个 phase，这样历史消息和重启后也能渲染正确的结果头。
- `ended.blocked` 是一个**正式结束态**（结果未核对 / 需要接手后未完成），不再伪装成 `error`。

中文词表（唯一来源，放在 `src/shared/phase.ts`）：

| phase                              | 文案                                     | 动效（`PhaseGlyph`，16px）                       |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| preparing                          | 正在连接                                 | `connect`：两个端点之间的连线反复接通            |
| thinking                           | 思考中                                   | `think`：星芒呼吸，小星点交替明暗；标题带微光    |
| acting · read                      | 读取 {文件}                              | `read`：文档里的三行自上而下点亮                 |
| acting · edit                      | 修改 {文件}                              | `edit`：笔尖轻摆，写出一道笔画                   |
| acting · run                       | 运行 {命令}                              | `run`：提示符后的光标闪烁                        |
| acting · web                       | 打开 {页面}                              | `web`：经线收窄再展开                            |
| acting · click                     | 点击 / 填写 {元素}                       | `click`：指针尖端扩散涟漪                        |
| verifying                          | 核对：{checkpoint}                       | `verify`：扫描线在取景框里上下扫                 |
| waiting.approval / input / handoff | 等待你的批准 / 回答 / 等你在页面完成操作 | `wait`：圆点外扩散光环（侧栏与输入框提示里静止） |
| stopping                           | 正在停止                                 | `stopping`：方块收缩再回弹                       |
| ended.succeeded                    | 已完成                                   | `done`：对勾一笔画出，只播一次                   |
| ended.blocked                      | 结果待核对                               | ⚠ 静止                                           |
| ended.failed                       | 未完成                                   | ✕ 静止                                           |
| ended.cancelled                    | 已停止                                   | ■ 静止                                           |

动效规则：

- 不再有通用转圈。转圈只保留在按钮「提交中」这一处。
- 每个动效一个循环 1–2 秒，只动图标里的一个部件，颜色跟随文字色。只有 `wait` 带提醒意味。
- 未知工具回退到 `think`。时间线里正在进行的那一步显示同一个动效。
- `prefers-reduced-motion` 下全部静止，图标本身仍能区分状态。
- 计时文本原地更新，不能重渲染整行，否则动效会被反复重置。

## 4. 三层 surface

### 4.1 过程层 · `ActivityRow`（对话流内，assistant 消息头部）

运行中：一行。

```
◐ 正在读取 src/renderer/App.tsx · 第 6 步 · 12s          [展开 ▾]
```

结束后：一行摘要，默认折叠。

```
✓ 已完成 · 7 步 · 核对 2 处 · 1 个文件                      [展开 ▾]
```

展开后是 `ActivityTimeline`：计划步骤 + 工具调用 + checkpoint 按时间顺序合并成一条时间线（现在是三个独立 Disclosure）。每项可展开看参数 / 输出 / 证据。模型名放在时间线顶部一行小字，不再做 chip。

- 替代：`ExecutionPanel` 的标题态、模型、目标、计划、工具、核对结果、产物 7 个区块。
- 键盘：沿用现在的 ↑↓ Home End。

### 4.2 请求层 · `RequestCard`（对话流内，出现在它发生的那一刻）

审批 / 提问 / 接手请求**就在对话里**，作为 Athena 消息时间线的一个节点出现，而不是另开一张卡或改造输入框。它出现时对话自动滚到它，焦点落在卡片本身（提问卡落在第一个输入项）；用户正在输入框里打字时不抢焦点。

```
Athena
◐ 正在构建 · 第 4 步 · 9s
┌─────────────────────────────────────────────────────┐
│ ✋ 允许执行此命令？                                    │
│ │ npm run build                                     │
│                                  [拒绝]  [允许这次 ⌘↩] │
└─────────────────────────────────────────────────────┘
```

处理完后不消失，折叠成一行留在历史里，和工具步骤并列：

```
✓ 已允许 · npm run build
💬 已回答 · 使用隔离测试页面，不提交数据
```

- 提问（user-input）同样是卡内选项 / 自由填写；`handoff` 显示「去页面完成 ↗」「已完成，继续」。
- 卡聚焦时 ⌘↩ = 主动作（允许 / 提交 / 已完成，继续）；Esc 只在审批卡上表示拒绝，提问卡和接手卡不响应 Esc，停止任务必须点按钮；输入框照常可用。
- 输入框只在底部多一行小字「Athena 在等你处理上面的请求」，尺寸不变。
- 替代：`RequestPanel`、`ExecutionPanel` 的注意事项块及「处理请求」按钮、`WorkbenchNotices` 的三种请求横幅。顶部不再有任何任务提示。

### 4.3 结果层 · 结果行 + `OutcomeCard`

结束时 ActivityRow 变成结果行（见 4.1 第二例），回复正文紧跟其后。需要你跟进的两种结束态（`blocked`、`failed`）在回复**之后**再跟一张卡，外壳与 `RequestCard` 完全相同：标题行、说明、右对齐的按钮行。规则是「凡是需要你动手的，都是一张卡」。

```
⚠ 结果待核对 · 7 步 · 核对 1 处 · 31s                    [展开 ▾]
源码已修改并构建成功，但我没能在页面上确认结果。
┌─────────────────────────────────────────────────────┐
│ ⚠ 1 处未能核对                                        │
│ 要核对的是「标题显示为欢迎回来」。页面上没有读到这处改动。  │
│                [标记为已完成]  [查看网页 ↗]  [再核对一次] │
└─────────────────────────────────────────────────────┘
```

- 「再核对一次」直接发一条隐藏上下文的续轮（不是把话术塞进输入框让用户按发送）。
- 「标记为已完成」把 `ended.blocked` 改成 `ended.succeeded`，记录为用户确认。
- `failed` 的卡：标题「第 N 步失败」、右侧命令与退出码、错误输出、`[查看完整输出] [修复并重试]`。
- 消息操作（复制回答、查看网页执行过程）紧跟在它作用的文字下方：有回复时在回复之后；只有失败原因、没有回复正文的一轮，在卡片之后，复制的是卡片里显示的失败原因。
- QA 的定义：每个 checkpoint = 断言 + 证据引用 + 结论（verified / not_applied / unknown）。`unknown` 不再把整轮标成 error，而是导向 `blocked`。

版式约束（适用于所有卡片与状态行）：

- 按钮行、标题行、状态行永不换行。按钮行只放按钮和一条快捷键提示，空间不足时先隐藏提示。
- 说明性文字放在卡片正文里，不放进按钮行。
- 卡片与上方回复之间留 14px，卡内各块之间 8–10px，按钮顺序固定为「弱动作 → 次要动作 → 主动作」。

### 4.4 外围提示

| 位置             | 新行为                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| 侧栏会话行       | 行首是当前 phase 的 glyph，行尾一个短标签：运行中 / 等你批准 · 等你回答 · 等你操作 / 待核对（仅此一处跨会话提示） |
| 顶栏             | 不放任何任务状态；Agent pill 只表示连接                                                                           |
| 浏览器页脚状态   | 读同一个 phase 文案（保留，因为它在另一个 pane）                                                                  |
| WorkbenchNotices | 只剩 Codex 更新通知                                                                                               |
| Toast            | 只用于 host 级错误，任务失败由结果行表达                                                                          |
| Composer         | 尺寸不变；等待请求时底部加一行提示                                                                                |

## 5. 实现

**phase 只在 host 推导一次。** `main.ts` 在每个 agent 事件之后重算 `assistant.phase`，`status` / `complete` / `error` 事件带上它；各 CLI 会话（`agents.ts` 等）不各自发 phase。renderer 只读，不再从 `status` + `tools` + `execution` 拼状态。

| 文件                                           | 职责                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/phase.ts`                          | `TurnPhase` 类型、推导（`runningPhase` / `phaseOfMessage` / `displayPhase`）、词表（`phaseText` / `phaseGlyph`）、`requestKey` |
| `src/shared/activity.ts`                       | 把 tools / plan / execution / 已处理请求合并成一条时间线                                                                       |
| `src/renderer/PhaseGlyph.tsx` + `activity.css` | 每个 phase 和工具类型各自的小动画                                                                                              |
| `ActivityRow.tsx` / `ActivityTimeline.tsx`     | 过程层：一行状态 + 可展开时间线                                                                                                |
| `RequestCard.tsx`                              | 请求层：审批 / 提问 / 接手                                                                                                     |
| `OutcomeCard.tsx`                              | 结果层：`blocked` / `failed` 之后的下一步                                                                                      |
| `AssistantTurn.tsx`                            | 按阅读顺序组合：状态行 → 请求卡 → 回复 → 结果卡                                                                                |

**host 动作**

- `conversation:confirm-outcome`：`blocked` → `succeeded`，记 `confirmed: 'user'`。
- `conversation:follow-up`：只对最新一轮生效。`blocked` 直接开新一轮「再核对一次」；`failed` 带上失败步骤重试。不经过输入框草稿。

**规则**

- 未处理的请求说了算：只要这一轮还有 pending request，就显示 `waiting`，即使消息上的 phase 已过期；只有 `stopping` 压过它。
- 同一时间只跑一个任务，所以其他会话在运行时，结果卡的主按钮（再核对一次 / 修复并重试）禁用。
- 卡片标题行：标题保持完整，旁边的说明先被截断；失败说明把退出码放在命令前面，截断时退出码不丢。
- 没有工具、计划、请求的普通回答结束后不显示状态行。

**已删** `ExecutionPanel.tsx`、`RequestPanel.tsx`、`WorkbenchNotices` 的三种请求横幅。

**测试** 新增 `tests/phase.test.ts`（状态机单测）、`tests/activity-states.e2e.ts`（全部状态的渲染、键盘、窄宽度不换行）；更新 `attention`、`selection-feedback`、`homepage-ui`、`electron`、`agent-experience`、`mainstream-cli-ui`、`cli-live-ui`、`task-panel-checks`、`app-notice-checks`。

## 6. 决定记录

- 2026-11-10 Dylan：一切嵌入对话流，inline；不要顶部横幅或徽标。
- 过程层结束后默认折叠为一行（可展开）。
- 2026-11-10 Dylan：运行态不能全是转圈，每个 phase 和工具类型要有可区分的小动画。
- 2026-11-10 Dylan：控件行不能出现换行；「结果待核对」原先的行内说明加三个按钮过于拥挤，改为回复之后的卡片。
- 实现时的两处安全性调整（偏离原稿）：请求卡出现时焦点落在卡片而不是主按钮，避免误按 Enter / 空格就批准；Esc 只拒绝审批，不会停止整个任务。
- 选中的元素只通过输入框里的 `[eleN]` 随消息发送；没有 token 的消息不带元素快照。

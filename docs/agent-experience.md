# Agent 交互、模型选择与独立用量

当前多 CLI 适配与真实验证边界见 [本机 CLI 适配](mainstream-cli-support.md)；本文下列“仅接通 Codex”描述保留为 0.6.0 的历史记录。

后续交互已于 2026-11-01 更新：非原生选择菜单、锚定推理滑块、Codex 预热复用、人工协作及 USD 估算详见 [交互体验修正](interaction-refinement.md)。下文保留 0.6.0 首版的实现与历史验收记录；其中 NativeSelect、居中模型弹窗和费用不可得的描述已被后续实现替代。

0.6.0 在 0.5.0 的真实执行事件上加入任务面板、CLI 模型选择和独立用量页。沿用现有 Codex 登录、Neo 浏览器与 HeroUI Pro beta.10；没有新增依赖或接通其他 CLI。

## 使用

聊天输入栏的模型按钮打开模型选择。列表和推理强度来自当前本机 Codex 的 `model/list`，选择后立即保存，下一次发送任务时生效。运行期间不可切换；尚未选择时沿用 CLI 当前配置。Claude Code、OpenCode、Gemini CLI 仍仅检测安装情况，不显示成可执行的适配器。

任务面板按实际事件展示：

- 公开任务计划及逐步状态，当前执行目标；不展示隐藏推理，不估算完成百分比。
- 真实工具动作、结果、错误和耗时。动作列表使用 HeroUI Pro `ListView`，支持键盘导航及 Enter 展开详情；较早动作可折叠。
- 等待用户处理时可查看网页、定位审批或回答控件。人工交还后仍由原有 Neo 检查点核对结果。
- 有原文证据的核对结果、恢复屏障及产物。产物定位前再次检查文件大小与 SHA-256；文件被删除、移动或修改时明确报错。
- 对话一轮结束与计划全部完成分别显示。计划仍有未完成步骤时，不自动把它们改成完成。结果未知时的“继续核对”只准备草稿，仍需用户发送，不直接重放失败动作。

侧栏“用量”是独立视图，不在聊天消息或聊天维度展示用量。可选择最近 7 天、30 天或全部记录，按助手、模型筛选，按模型、助手或日期汇总。每日柱形与表格来自同一批记录，按任务开始日期汇总，使用本机时区；这不是按账单时间拆分的费用报表。界面保留冷色主题，使用既有 HeroUI Pro `NativeSelect`、`ListView` 以及 HeroUI 的 Modal、Disclosure、Card、Tabs 等组件。新视图和详情仅使用短暂淡入；减少动态效果时禁用，图表不做数字滚动动画。

## 模型确认

`CodexSession.listModels()` 只连接 stdio 协议，不创建空执行会话。分页读取并过滤隐藏/无效项；不硬编码模型名称或把目录默认值当成账户的实际执行配置。

新建或恢复会话时读取 CLI 回应的模型配置；每次 `turn/start` 显式传递所选 `model` 和 `effort`。实测 CLI 0.163.0 对**已载入**线程再次调用 `thread/resume` 不应用新的模型覆盖，因此不能用 resume 的回应证明切换成功。

本轮执行结束前，仅从该 CLI 回应的本线程 rollout 路径读取同一 thread ID、同一 turn ID 的 `turn_context`，提取模型和推理强度。上一轮的模型证据不会冒充本轮确认。服务端发出 `model/rerouted` 时保留实际切换信息。执行记录无法读取时保留“待确认”，不靠模型自述证明使用了哪个模型。

`Thread.path` 是版本相关的本机协议字段；不扫描其他 CLI 历史，不导入全部 Codex 使用量，也不向界面输出原始上下文、系统提示或 reasoning 事件。这里的执行记录证明 CLI 使用的轮次配置，不提供模型服务端独立审计或账单证明。

协议依据：[OpenAI Codex App Server](https://developers.openai.com/codex/app-server)，以及本机 0.163.0 生成的 `ModelListParams`、`Model`、`TurnStartParams`、`ThreadTokenUsageUpdatedNotification`、`TokenUsageBreakdown`、`ModelReroutedNotification`、`Thread` 类型。生成类型保留在 `.runtime/complex-agent-protocol/`，升级 CLI 时需要重跑验收。

## 用量口径与持久化

用量单独保存在应用 `userData/usage.json`，不塞入聊天文本。文件以原子替换和顺序写入保存，权限 0600。模型选择仍保存到既有 `workspace.json`；数据目录、bundle ID、钥匙串和所有 `WORKBENCH_*` / `workbench:*` 兼容标识保持不变。

记录依据是 `thread/tokenUsage/updated`，按真实 thread/turn 对应到本次任务。每轮开始前读取本线程可信的累计基线，随后以“最新累计 − 本轮基线”更新记录；不会把一系列累计通知相加。重复通知不增加统计，晚到通知只更新其原轮次。重启后保留去重依据；新一轮不会重新计入历史累计量。

| 情况 | 处理 |
| --- | --- |
| 新执行线程 | 从零基线开始，只记录实际返回的量 |
| 继续或重启会话 | 从本线程真实累计记录建立基线 |
| 起始累计缺失 | 仅计当前已观察样本及之后增量，明确标记部分数据 |
| 缺少或非法字段 | 显示未知；已有可信部分保留并标记不完整 |
| 取消、错误、中断 | 保留已返回用量，不推断未返回量；没有事件时显示缺失 |
| 本轮模型重路由 | 总量保留，模型维度归为混合且未拆分，不随意分配 Token |
| 旧聊天没有统计 | 只记录缺失覆盖情况，不按文本长度估造历史 Token |

输入包括缓存读取；缓存读取/写入是输入明细，不重复加入总 Token。输出包含推理输出。界面显示输入、输出、缓存读取、缓存写入及总 Token；字段真实为 0 才显示 0。总量、分组和筛选均显示缺失或不完整情况。它统计的是本机 Athena 捕获的任务使用量，不是账户的全渠道使用量。

**费用显示“不可得”。** 当前 CLI 事件没有可靠的订阅实际扣费金额。本版没有套用 API 单价、没有示例金额、没有把未知费用显示为零，也未宣称 Token 总量等于实际账单。

## 验收与复现

```bash
npm run typecheck
npx tsx --test --test-concurrency=1 tests/*.test.ts

# 需要本机 Chrome 与固定版本的 agent-browser；全部为隔离本地页面
ATHENA_TEST_CHROME="/Applications/Google Chrome.app" ATHENA_TEST_AGENT_BROWSER=1 \
  npx tsx --test --test-concurrency=1 tests/browser.test.ts tests/web-runtime.test.ts \
  tests/sharing-browser.test.ts tests/complex-native.test.ts

# 下面两个脚本使用现有 Codex 登录，会消耗真实模型配额
npm run test:models
npm run build
npx electron-builder --mac dir -c.directories.output=release/agent-experience --publish never
npm run test:agent-experience
```

`tests/usage.test.ts` 覆盖累计去重、未知字段、部分数据、继续会话、取消/错误、重启、重路由、日历边界和精确模型记录身份。`tests/agents.test.ts` 覆盖模型分页、无空线程副作用、真实 turn 参数、外来事件拒绝和协议映射。模型确认等待期间也立即封闭已结束轮次的工具/审批入口，晚到用量只更新原轮次。

`tests/model-usage.e2e.ts` 验证两个模型的实际轮次配置和重启续接，保留原始公开 usage/model 事件及独立账本汇总。`tests/agent-experience.e2e.ts` 在独立应用中通过真实模型触发计划、原文核对、人工处理、下载、失败和停止，再验证模型选择、用量页面、键盘、窄窗口、减少动态效果、重启和共享拒绝。产物内容在文件系统独立核对；Finder 调用在测试中截获验证宿主分派，不打开覆盖用户工作的 Finder 窗口。

最终验收：类型检查、构建、深度签名校验通过；全量单元测试 165 通过、13 项按环境跳过，原生专项 23 通过。直接 CLI 的 3 轮模型切换/续接，以及独立应用的 4 轮真实模型任务均通过；独立应用另验证了共享拒绝这一未启动模型的任务。renderer 无运行错误，持久化模型、计划和统计重启一致。

最终结果与构建哈希以 `test-results/agent-experience/verification.json` 为准。运行时证据、截图和失败尝试分别保留在该目录。`ui/` 的冒烟截图是已记录真实事件的隔离重放，`packaged/` 是独立应用的本次真实模型流程；二者不混为同一种证据。

此前验收夹具曾要求仅能使用 Neo 的模型读取下载文件表头，模型正确保留未核实步骤，没有虚报完成；已把测试任务改为下载，由宿主独立验证 CSV 内容。验收脚本还修正了重复按钮名称、已展开浏览器的保留状态，以及 JSON 持久化会省略 undefined 属性的对比方式；这些尝试的日志和现场均保留。浏览器尺寸帧等待曾两次超时，单项、单文件及最终完整 23 项回归通过；未证实间歇超时根因，没有放宽原断言或修改浏览器实现。

错误提示的可视检查另外发现既有 `.toast` 类与 HeroUI 的折叠通知样式冲突：文字 opacity 为 0、容器仅 20px 高。已改用应用专用类名；`tests/agent-experience-ui.e2e.ts` 用受控提示事件验证文字可见、46px 高且可关闭，不调用模型。相关红绿结果保留在 `toast-before.log`、`toast-after.log` 和独立包验收日志中。

## 范围

仅使用隔离本机页面、文件和应用数据。没有验证真实外部登录、验证码、支付、OAuth 弹窗或桌面控制；没有新增 CLI 登录、API 密钥或权限。现有审批、停止、帧/引用校验、结果未知屏障和“共享期间不允许 Agent 接管”继续生效。

本地独立构建位于 `release/agent-experience/mac-arm64/Athena.app`，采用 ad-hoc 签名，未公证。它不覆盖 `release/sharing`、`release/complex-agent` 或已有滚动预览；源码与此前工作仍未提交、推送或部署公网。

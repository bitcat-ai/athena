# 复杂网页任务执行

下文是 0.5.0 的实现与验收记录，当时的执行器为 BrowserOS neo。计划、检查点、恢复屏障和执行记录沿用至今；执行器已于 2026-11-12 改为 agent-browser，见 [网页执行器](web-executor.md)。文中的原生 0.0.90 行为、耗时和通过数未在新执行器上逐项重测。

0.5.0 在现有 CodexSession → Athena 宿主 → BrowserOS Neo 原生链路上增加任务计划、证据检查点、失败恢复屏障和结构化执行记录。它保留 0.4.0 的共享控制、0.3.2 的输入与帧性能改进，未新增桌面控制或替换浏览器执行器。

## 实际能力与执行边界

- `neo_act.fields` 跨原生可观察的 iframe、开放 Shadow DOM 批量填写表单；动态分支后重新观察，原生 eN 引用继续由 Neo 校验。宿主元素预览 ref 与 eN 不互换。
- `neo_read/grep` 核对页面结果，`neo_wait` 等待文本/选择器；不把一次点击或超时当成业务成功。原生 0.0.90 的等待超时实际返回 `isError:false` 和 `timed out after …` 文本，适配器现在将其识别为失败并进入核对状态。
- 正常标签页保持原生页面编号与 Athena targetId 对应；新建标签会显示到浏览器面板。原生 strict window 范围不含 OAuth 或 `window.open` 的弹出式窗口，遇到这些路径需人工处理，不能扩大范围来伪装成功。
- `neo_run` 复用原生 SDK 组合有界步骤、读取和条件分支，保留每次脚本确认和原生 30 秒上限；不以脚本代替普通表单工具来绕开审批。上传保留逐次确认，确认后再次核对页面 URL/target。
- 下载落到 Athena 自有浏览器数据目录中的 `downloads/`，由浏览器处理重名，宿主再次核对普通文件、目录、大小和 SHA-256。不会自动执行或打开下载内容。原生下载会重设 CDP 为 default，因此配置的是自有 profile 的下载默认值，而不是临时 CDP 路径覆盖。
- 原生下载的最长执行时间是 60 秒；MCP 下载等待改为 65 秒，避免旧的统一 35 秒 HTTP 超时先截断它。人工帮助不设传输截止，取消/关闭会中止请求；普通 run 仍受原生限制。

## 计划、检查点与恢复

复杂任务先用 `neo_plan` 发布简短步骤，再根据真实结果更新状态。CLI 的 `turn/plan/updated` 也可接收；本次真实模型没有主动发出该通知，因此不能仅依赖此通知证明计划功能可用。实际验收使用了注册给模型的 `neo_plan`。

成功的 snapshot/read/grep 带有本次 `observationId`。`neo_checkpoint` 要求短说明、原文证据和 `verified` / `not_applied` / `unknown` 判断；宿主校验观察来自当前任务、仍属当前动作代次、证据确实存在。一次新的页面操作会使此前观察不能再作为新检查点。检查点是 Agent 对页面证据的判断，不能代替网站的事务语义或服务端独立核验。

已派发动作失败、等待条件未匹配或人工帮助返回后，宿主阻止后续变更，直到重新读取实际状态并核对。未知保持阻塞；确认未发生后才可重新规划；确认已发生后不能重放同一失败动作。后续等待失败不会抹去原始未知动作。恢复期间可以新建独立回执标签检查；跨标签检查点必须明确填写原失败页的 `recoveryPage`。

验证与派发在同一任务队列串行执行，排队动作也会看到前一个失败。CLI 重复发送同一 `callId` 时不会重复派发。停止和人工接管撤销浏览器控制并取消原生任务，已排队动作或晚到的确认不能恢复控制。共享期间仍需先停止共享才能启动 Agent；启动被拒绝也会清理任务状态。

取消不承诺撤销网站已经提交的事务或已经开始的浏览器下载。连接中断、网站自发重试等场景需要核对实际回执；宿主不提供跨站点的“恰好一次”事务保证。登录、验证码、一次性代码及高影响操作继续由用户处理或明确授权。

## 供后续交互面板使用的数据

`ChatMessage.plan`、`ChatMessage.execution` 和工具的可选时间字段均向后兼容，不迁移已有聊天、钥匙串或兼容 ID。

| 记录 | 来源与含义 |
| --- | --- |
| `plan` | Agent 显式报告的公开步骤；不是隐藏推理或推测进度 |
| `operation` | 宿主开始/结束/失败，包含 operationId、工具、页面、耗时 |
| `observation` | 实际观察的引用；不等于业务成功 |
| `checkpoint` | 引用原文的 Agent 核对结论 |
| `recovery` / `human-help` | 实际阻塞、人工交还及核对状态 |
| `artifact` | 已存在文件的绝对路径、大小、SHA-256 |
| `cancelled` / `finished` | 会话生命周期；最终业务结论仍看检查点和实际结果 |

每条执行事件有唯一 id、taskId、at。新字段持久化到既有 workspace.json，IPC 和 renderer state 同步保存；不新增独立交互面板。存在未核对结果时，宿主不能把模型的完成消息记为成功。重启后原 streaming 消息和运行中的工具记为中断/结果未知，不自动重放；历史计划、检查点和产物仍可回读。

## 可重放验收

固定数据站点在 `tests/fixtures/complex-workflow/index.html`，独立 HTTP 状态在 `tests/complex-workflow-fixture.ts`。每次运行建立自己的 profile、文件和 loopback 端口，结束后只清理本次数据，不访问生产站点或接管已有窗口。

场景要求筛选待处理、翻页定位 Ada Studio、从另一标签读取国际规则、切换区域并触发动态税号、先验证缺失字段、跨 iframe/Shadow DOM 批量填写、审批上传、异步校验、提交、读回唯一订单、下载并核对 CSV。异常模式在服务端保存后返回 503 且不给提交回执，必须查已有订单，不能重提。

```bash
npm run typecheck
npm test
ATHENA_TEST_CHROME="/Applications/Google Chrome.app" ATHENA_TEST_AGENT_BROWSER=1 \
  npx tsx --test --test-concurrency=1 tests/browser.test.ts tests/web-runtime.test.ts \
  tests/sharing-browser.test.ts tests/complex-native.test.ts
# 以下使用本机已登录 Codex，产生真实模型调用，不在 npm test 中自动运行。
npm run test:complex-agent
npm run test:complex-agent -- --lost-reply
npx tsx tests/complex-app.e2e.ts
```

证据位于 `test-results/complex-agent/`，最终汇总以 `verification.json` 为准。独立应用已验证共享拒绝后的任务清理、公开事件持久化、未知结果不标成功和重启回读；renderer 无错误。完整单元套件 154 通过、13 按环境跳过，原生专项串行套件 23 通过。临时测试数据按运行清理，两个 CSV 副本保留在 live-normal/receipt.csv 与 live-lost-reply/receipt.csv。正常路径已实测 42 轮工具、114101ms、0 个失败工具、1 次服务端提交；回执异常路径 41 轮、90003ms、1 个检查点工具错误后重新读取核对，服务端仍只有 1 次提交。工具轮数包括计划/检查点；耗时包含真实模型延迟，不代表外部网站性能或成功率。

协议测试、真实原生浏览器测试、真实模型测试、独立应用测试分开记录。真实模型的代表性流程使用 granular Neo 工具；有界 run 脚本通过真实 Neo/页面测试，未声称模型自行编写脚本的普遍成功率。测试中先后修正了审批夹具对 `file`/`files` 的误判、缺少真实计划事件、macOS `/var` 实路径断言和接管测试过晚查询目标的问题。首次用断开 socket 模拟响应丢失时，单次工具提交对应两次 HTTP 请求，推断与浏览器在连接中断后的网络重试有关；改为保存后返回 503 来隔离检验 Agent 的恢复行为，没有删掉宿主安全边界。原有动画的 100ms 计时断言曾在并发回归中失败，单项与串行完整回归均通过，保留原失败日志。

## 本次没有验证的范围

外部站点、真实账户登录/验证码、真实支付/删除/发布、OAuth 弹出式窗口、关闭 Shadow DOM、物理多机及桌面控制没有验证。本项不新增 CLI 模型选择或 usage/费用统计，这些属于第 3 项。依赖于原生工具版本的文本返回适配需要在升级 Neo 时重跑基准。

原生工具 schema 由运行中的 0.0.90 服务读出并保存在 `native-tools.json`；下载行为同时核对了 [BrowserOS 官方 file_transfers 实现](https://github.com/browseros-ai/BrowserOS/blob/main/packages/browseros-agent/crates/browseros-core/src/file_transfers/mod.rs)。未升级或修改原生二进制。

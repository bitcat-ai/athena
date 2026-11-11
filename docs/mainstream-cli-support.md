# 本机 CLI 适配

## 使用与范围

- 当前包括 Codex、Claude Code、Gemini CLI、Pi、Cursor Agent、OpenCode 1.x，使用用户已有安装、登录与 Provider 配置。不会自动安装、登录或切换到其他 CLI。
- 设置中的默认 CLI 只用于新对话；输入栏可为新对话改选 CLI。已有消息或原生执行会话的对话不能重绑，切换时创建新对话。旧档案缺少 `agent` 的对话仍为 Codex，不随应用默认值改变。
- 对话保存原始 CLI session ID，只能由对应适配器恢复；恢复失败不自动换新 ID，也不用拼接可见历史假装恢复。模型选择与目录缓存按 CLI 隔离。手动刷新会使空闲连接重新读取本机配置；任务进行中则延后到任务结束，不只凭路径、版本或登录方式相同就复用旧账户配置。
- 模型目录来自 CLI。未提供可靠目录的 CLI 沿用本机默认配置，不编造选项。实际本轮模型另取 CLI 消息元数据，不把初始化配置或模型自述当作执行证据。
- 当前源码向 Codex、Claude、Pi、OpenCode 开放同一套 Neo 浏览器和元素预览工具；Gemini、Cursor 尚未接入该授权链路。Claude 通过每轮私有 MCP 配置接入，Pi 通过显式加载的 Athena 扩展注册宿主工具，不导入任意第三方 MCP。

## 能力与验证矩阵

下表中的远端真实模型验收记录来自 2026-11-05；本轮新增的本地原生联调见下方「Neo 原生联动」。**全部 CLI 的远端模型验收尚未完成；0.9.0 发布不代表源码新增能力已随安装包发布。**

| CLI          | 当前执行模式                              | 最近验收结果                                                                                                                                                                  |
| ------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex        | app-server、本地审批和 Neo 网页工具       | 真实 Electron 的回复、重启续聊、停止、草稿保留、停止后续聊通过；另完成真实 Neo 本地表单填写与保存核对                                                                         |
| Claude Code  | stream-json 文字/图片与宿主 Neo；内置工具关闭 | 适配器的真实回复、流式、原生续聊、停止通过；真实 Electron 四轮对话和重启/停止后续聊通过，取得消息模型和用量证据                                                               |
| Pi           | RPC 与宿主 Neo；本地工具逐项审批     | Pi 1.0.2 适配器通过独立 API 的真实 write/read、审批、流式、原生续聊、用量/模型证据和停止。此前远端 UI 检查遇到续聊发送禁用；2026-11-11 本地原生 Electron + Neo 连续两轮通过，未复现该现象，远端完整 UI 脚本尚未重验 |
| Cursor Agent | Ask 只读；启动前逐次确认工作目录          | 2026.11.05-86047df 登录完成；真实服务返回周额度上限，回复/续聊/停止尚未验收。实际 Electron 的目录审批拒绝、等待审批时停止通过，未启动模型会话                                 |
| Gemini CLI   | stream-json；admin deny 策略禁用原生工具  | 0.67.0 原生目录、经目录确认后的本地 API 回复、续聊与流式停止通过；Google 个人版登录此前被服务端拒绝，远端模型验收仍未完成                                                        |
| OpenCode 1.x | ACP、原生文件/命令逐项审批与宿主 Neo | 1.18.15 已通过真实 CLI + 本地模型替身的文件读写、原生续聊、停止、图片输入、宿主 MCP；真实 Electron + Neo 完成页面创建/修改/填写/核对与连续两轮对话。未做远端模型验收 |

Pi 的真实 API 验收使用独立测试配置，复用用户授权的现有 API；未修改原有 Pi Provider 配置。Cursor 与 Gemini 的隔离安装没有覆盖已有 Grok 的 `agent` 命令。测试配置、凭据、原生会话和私有 API 地址均不进入 Git。

Codex、Claude、Gemini、Pi、Cursor、OpenCode 的品牌图标均已接入；浅/深色主题图片加载检查通过。Pi/Cursor 使用官方 SVG，来源见 `src/renderer/assets/agents/README.md`。

## 实现边界

### 模型目录验证（2026-11-11）

Codex 的 `model/list` 与 Pi 的 `get_available_models` 路径保持原实现。Claude、Cursor、Gemini 已从空实现改为原生模型发现：

| CLI | 原生来源 | 本机目录验证 |
| --- | --- | --- |
| Claude Code 2.1.283 | stream-json `initialize` 控制响应 | 7 个选项；模型标识与推理档位来自 CLI |
| Cursor Agent 2026.11.05-86047df | `--list-models` | 276 个账号目录选项；原生变体 ID 不拆改 |
| Gemini CLI 0.67.0 | `--list-models --output-format json` | 4 个 CLI 选项；未报告推理档位或默认值时保持未知 |

数量是此次检查的快照，不写死在应用。`tests/cli-models-ui.e2e.ts` 使用真实 CLI、真实 Electron IPC、独立数据目录和禁止显示/激活的测试窗口，验证目录显示、会话范围内的模型选择、Claude 推理档位、保存与磁盘回读。未发送任何模型任务；此检查不能替代远端推理、账号额度或原生工具验收。Gemini 使用既有隔离安装，通过测试进程 PATH 接入，没有全局安装。

证据：`test-results/cli-models-ui/verification.json` 与三个实际 Electron 截图。单元回归入口：`npx tsx --test tests/cli-models.test.ts`。

OpenCode 1.18.15 的 ACP 配置目录也通过上述 Electron 检查，当前本机配置返回 1 个模型。该数量与具体账号、Provider 配置有关。

### 公共边界

- `src/main/agent-session.ts`：宿主公共接口；各适配器自行拥有协议、会话、停止与事件转换，不能拥有宿主授权。
- `src/main/agent-discovery.ts`：检查 PATH、常见本机目录、nvm/fnm；realpath 去重，损坏 shim 不遮住其他可用安装。不执行 shell 启动文件，不把 Cursor 编辑器命令当 Agent，不把 `agent` 别名算成第二个提供商。Codex 现有私有安装回退保持兼容。
- `src/shared/agents.ts`：旧对话执行器归属、模型选择隔离与浏览器能力边界。
- 保留 `codex:state`、`CodexConnectionState` 与 snapshot 的 `codexConnection` 兼容标识；它们承载当前所选会话的连接状态，不据此声称所有执行器均为 Codex。
- CLI/session/conversation 标识仅用于归属，执行工具与审批仍绑定当前任务；未知费用和用量字段保持未知，USD API 等价估算的优先级不变。

### Pi

`src/main/pi-session.ts` 按请求 ID 关联 JSONL 响应，仅按 LF 分帧，以 `agent_settled` 判断最终完成，而非 `prompt` 响应或 `agent_end`。不展示 thinking、原始 stderr 或凭据诊断。工具参数超过可完整审阅的审批长度时直接阻止，不允许只看截断命令就批准执行。

启动前核对 CLI 支持的隔离参数。旧版使用 `--no-mcp`；Pi 1.x 在 help 明确说明 `--no-extensions` 禁用内置扩展时，通过该选项关闭内置 MCP。无法确认隔离方式时拒绝启动。只加载 Athena 的 `resources/cli/pi-permissions.mjs` 授权扩展，关闭扩展/MCP/技能/模板的自动加载，不改写用户配置；保留 CLI 原生 Provider、模型与登录配置。依赖额外 Pi 扩展注册的 Provider 不在当前受限加载模式的支持范围。启动时没有授权扩展握手则拒绝执行。打包后的扩展由宿主复制到应用私有 runtime 目录，外部 Pi 进程不直接读取 Electron asar。

恢复使用原始 Pi session ID。停止先清除队列再 abort；无法确认停止时终止当前进程组，即使 leader 先退出仍清理后代。没有通过给模型发送“请停止”来模拟停止。

### Claude / Gemini / Cursor

协议依据、参数限制、事件与安全模式见 [CLI 协议依据](cli-protocol-evidence.md)。Gemini 和 Cursor 启动模型任务前均通过宿主逐次确认工作目录；只有批准后传入 Gemini 的 `--skip-trust` 或 Cursor 的 `--trust`。拒绝与等待时停止均不启动 CLI，迟到确认无效。Gemini 原生文件与命令仍由 admin deny 策略禁用。

这些适配器不是通用 MCP 接入，不是 OS 沙箱，也不提供未实现的原生审批或人工提问桥接。收到无法处理的原生工具审批请求会报错并停止。Cursor 的工作目录信任单独由宿主确认：只在用户批准本次任务后加 `--trust`，保持 `--mode ask`，不启用 `--force`、`--yolo` 或自动批准 MCP。拒绝或等待时停止均不启动 CLI，迟到审批失效。额度/认证错误仅显示固定分类，不转发原始 stderr。

### OpenCode

`src/main/opencode-session.ts` 使用 OpenCode 1.x 原生 ACP，通过 `session/new` / `session/load` 保留原生会话 ID；恢复失败直接报错，不拼接历史伪装恢复。未建立会话时用 `models --pure` 只读查询目录，不创建空原生会话；已有连接从 ACP `configOptions` 或旧版 `models` 读取，设置使用原生配置请求；执行模型未由协议回报时保持未确认。

每个适配进程先读取本机默认 Agent 的有效权限，再加载临时、唯一命名的 Athena mode。保留原有拒绝规则与匹配顺序；原本允许的 read/edit/bash/glob/grep/list 和外部目录访问收紧为逐次宿主批准，其他原生工具默认拒绝。只接入已有 Athena MCP 工具清单；原生工具事件与宿主工具回执分开处理，宿主动作不重复记账。`--pure` 禁用第三方插件；现有 Provider 和认证继续由 CLI 管理，不写入用户配置。目录里的本机配置仍需可信，这不是 OS 沙箱。

`session/request_permission` 按原生 toolCallId 合并可审阅的工具参数，只使用 allow_once / reject_once；参数缺失或过长拒绝并停止。停止撤销待决审批和 MCP，终止进程组；结果返回后拒绝迟到操作。图片通过 ACP image 内容传给 CLI，选定模型仍需支持图像。

协议依据：[OpenCode 1.18.15 ACP](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/acp/service.ts)、[原生审批桥接](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/acp/permission.ts)、[图片内容转换](https://github.com/anomalyco/opencode/blob/v1.18.15/packages/opencode/src/acp/content.ts)。

### Neo 原生联动

`AgentMcpServer` 只绑定回环地址，使用随机凭据和固定工具清单，所有操作回到当前 `AgentSession` → `NeoBrowserRuntime` → `BrowserRuntime`。敏感操作仍由宿主审批；停止、会话切换、共享控制权和未知结果恢复不会由 CLI 绕过。

- Claude：浏览器未就绪时保持原文本模式；加载 Neo 时使用 `--restricted --tools ""`，只允许临时配置中的 Athena MCP 工具，并核对原生 init 实际加载的工具清单。`alwaysLoad` 和关闭延迟工具搜索保证首轮可见。受限模式不加载用户/项目 settings 文件；认证及 Provider 依赖 CLI 身份和进程环境，应用明确选择的模型继续通过参数传入。不要假定用户 settings 中的额外配置仍然生效。
- Pi：只通过已有的授权扩展注册这些精确工具名。Neo 操作交给宿主权限链；本地文件和命令仍逐次请求批准。授权扩展和浏览器工具均需握手就绪。
- 对话链接在右侧新标签打开。元素编辑的 `insert` 支持受约束的嵌套 HTML、继续修改和撤销；新引用、页面观察与检查点同属当前任务。

已通过真实 Electron、已安装的 Claude/Pi/OpenCode、真实 Neo、**本地模型响应替身**的端到端联调，覆盖链接打开、节点创建、再次修改、原生填写、页面检查点及结果回传。最终联调在禁止显示和激活的测试窗口中完成，避免抢占桌面焦点；它不等于远端模型自主规划已验证。详情见 [Neo 原生联动说明](native-browser-interop.md)。

## 验证入口

图片粘贴通过原生协议接入 Codex（`turn/start` image）、Claude（stream-json image content）、Pi（prompt images）与 OpenCode（ACP image content）。Gemini 和 Cursor 的现有适配器会在启动任务前拒绝图片，不将其降级为文字或文件路径。Claude 使用官方[流式图片输入结构](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)；Pi 与 Codex 的结构按本机 CLI 的类型定义和生成协议核对。选定模型本身仍需支持视觉输入。

- `npx tsx tests/image-paste.e2e.ts`：隔离 Electron 的系统剪贴板、草稿、IPC、模拟 Codex 图片输入与重启回读；不调用模型。
- `ATHENA_LIVE_IMAGE_TEST=1 npx tsx tests/image-paste.e2e.ts`：经授权后以隔离配置的 `gpt-6.1-sol / low` 执行一次真实 Codex 图片识别（不改变用户默认模型），临时图片编号不出现在提示词中，且要求不使用工具。会消耗模型额度，不能把默认模拟测试替代这项证据。

- `tests/cli-models-ui.e2e.ts`：隐藏 Electron 中的原生模型目录、选择、推理档位与保存回读，不发送模型任务。
- `tests/opencode-native.e2e.ts`：已安装 OpenCode 对接本地模型替身，验证原生读写审批、保留原有 deny、续聊、停止、图片与宿主 MCP；不调用远端模型。
- `tests/gemini-native.e2e.ts`：已安装 Gemini 对接本地 API 替身，验证协议回复/续聊/停止，并在隐藏 Electron 中验证目录拒绝不发请求、批准后执行、停止保留草稿。
- `npm test`：协议、权限、用量、引导与状态回归；条件性跳过的浏览器/Neo 检查不算已验证，以对应提交的实际输出为准。
- `npm run typecheck`、`npm run build`：类型与构建检查。
- 首页、控件、引导及 USD 用量四组隔离 renderer 检查通过。测试可使用已安装的 BrowserOS、Chrome 或 Playwright Chromium，也可显式设置 `WORKBENCH_TEST_BROWSER_EXECUTABLE`；这不验证 Neo 或桌面控制能力。
- `tests/mainstream-cli-ui.e2e.ts`：真实 Electron，独立应用数据/临时项目，使用用户已安装的 Pi。目标是通过界面逐次批准指定文件 write/read，核对文件、CLI 消息模型证据及用量；重启后以同一原生 ID 续聊并回忆前轮随机标记；真实停止流式任务并保留下一段草稿。此次新增本地连续对话通过，但尚未重跑该远端完整脚本。验证默认值仅影响新对话、旧无 agent 档案仍属 Codex、已执行对话切换 CLI 创建新会话。Claude 在此脚本仅被选择，不产生其模型调用；浏览器保持稍后准备。
- `tests/cli-live-ui.e2e.ts`：Codex/Claude/Gemini/Cursor 的实际 Electron 文本会话检查；Cursor `permissions` 模式只验证目录审批，`icons` 模式只验证图标，二者不产生模型回合，也不能替代真实对话验收。
- 真实 UI 证据写入忽略提交的 `test-results/mainstream-cli-ui/`；隔离 UI 截图不是实机网页操作证据，不替换 README 的正式截图。
- 控件检查曾偶发一次保存后的键盘焦点断言失败；加入连续 Home/End 切换后连续三次通过，但未锁定根因，不能声称已修复此偶发问题。保留焦点变化与失败现场诊断。
- 预热关闭夹具改为握手明确挂起后关闭，移除 1 秒完成窗口的竞争；人工请求布局按稳定后的相同尺寸阈值检查，不降低停止、焦点或布局断言。

```bash
npx tsx --test tests/pi-session.test.ts tests/pi-permissions.test.ts tests/stream-cli-session.test.ts tests/cli-selection.test.ts

# 真实模型调用，需要明确授权；可能计费。
WORKBENCH_LIVE_PI=1 WORKBENCH_PI_PATH="$(command -v pi)" npm run test:live-pi
WORKBENCH_LIVE_CLI=claude WORKBENCH_CLI_PATH="$(command -v claude)" npm run test:live-cli
# 真实 Electron UI，同样可能计费；先 build，必要时运行 node node_modules/electron/install.js 恢复开发运行时。
WORKBENCH_LIVE_PI=1 npx tsx tests/mainstream-cli-ui.e2e.ts
# 真实 Electron 会话检查（会产生模型请求）：
WORKBENCH_LIVE_CLI=codex npx tsx tests/cli-live-ui.e2e.ts
WORKBENCH_LIVE_CLI=claude npx tsx tests/cli-live-ui.e2e.ts
# 以下仅验证宿主目录确认，不产生模型回合：
WORKBENCH_LIVE_CLI=cursor WORKBENCH_CLI_UI_CHECK=permissions npx tsx tests/cli-live-ui.e2e.ts
# Cursor/Gemini 的真实对话还需要有效的账户额度和服务配置。
```

Pi 真实测试只自动批准隔离目录 evidence.txt 的指定 read/write，不批准任意命令；Claude/Cursor 真实脚本仅请求文本，不请求文件、shell 或外部消息。临时项目删除后，CLI 自身正常保存的原生会话仍遵循各自的本机存储规则，不提交到 Git。

旧测试夹具把 Node 路径直接放进 shebang，在带空格的 fnm 路径下会 ENOENT；现通过 `tests/node-script.ts` 的可执行 JS 头修复夹具，并覆盖带空格、单引号的 Node 路径及参数透传，不改变生产执行器或放宽断言。

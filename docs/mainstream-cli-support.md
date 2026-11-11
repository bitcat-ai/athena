# 本机 CLI 适配

## 使用与范围

- 首批包括 Codex、Claude Code、Gemini CLI、Pi、Cursor Agent，使用用户已有安装、登录与 Provider 配置。不会自动安装、登录或切换到其他 CLI。
- 设置中的默认 CLI 只用于新对话；输入栏可为新对话改选 CLI。已有消息或原生执行会话的对话不能重绑，切换时创建新对话。旧档案缺少 `agent` 的对话仍为 Codex，不随应用默认值改变。
- 对话保存原始 CLI session ID，只能由对应适配器恢复；恢复失败不自动换新 ID，也不用拼接可见历史假装恢复。模型选择与目录缓存按 CLI 隔离。手动刷新会使空闲连接重新读取本机配置；任务进行中则延后到任务结束，不只凭路径、版本或登录方式相同就复用旧账户配置。
- 模型目录来自 CLI。未提供可靠目录的 CLI 沿用本机默认配置，不编造选项。实际本轮模型另取 CLI 消息元数据，不把初始化配置或模型自述当作执行证据。
- 浏览器工具和元素调整目前仅向 Codex 开放。其他 CLI 没有宿主 Neo 授权桥接，不自动接管网页。未完成的审批能力不以自动批准代替。

## 能力与验证矩阵

最近一次真实验收在 2026-11-05 进行，以下状态于 2026-11-06 推送代码前整理。**全部 CLI 跑通的目标尚未完成；0.9.0 发布不代表此矩阵全部通过。**

| CLI          | 当前执行模式                              | 最近验收结果                                                                                                                                                                  |
| ------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex        | app-server、本地审批和 Neo 网页工具       | 真实 Electron 的回复、重启续聊、停止、草稿保留、停止后续聊通过；另完成真实 Neo 本地表单填写与保存核对                                                                         |
| Claude Code  | stream-json；原生 Skill 与只读 Read/Glob/Grep，MCP 关闭 | 适配器的真实回复、流式、原生续聊、停止通过；真实 Electron 四轮对话和重启/停止后续聊通过，取得消息模型和用量证据。新增 Skill 发现、原生 slash 分发、Read 成功/失败仅通过模拟 CLI 测试，尚未进行真实模型或跨 main/UI 的 Claude Skill 验收 |
| Pi           | RPC；每次本地工具调用交给 Athena 审批     | Pi 1.0.2 适配器通过独立 API 的真实 write/read、审批、流式、原生续聊、用量/模型证据和停止。Electron 脚本已走到文件核对与续聊阶段，但续聊发送按钮保持禁用，完整 UI 脚本尚未通过 |
| Cursor Agent | Ask 只读；启动前逐次确认工作目录          | 2026.11.05-86047df 登录完成；真实服务返回周额度上限，回复/续聊/停止尚未验收。实际 Electron 的目录审批拒绝、等待审批时停止通过，未启动模型会话                                 |
| Gemini CLI   | stream-json；admin deny 策略禁用原生工具  | 0.67.0 已在隔离目录安装并检查参数。Google 个人版登录被服务端拒绝；尚无可用兼容服务，用户已决定暂缓，未完成真实模型验收                                                        |
| OpenCode     | 仅保留安装检测                            | 不可选为执行器，不计入已支持执行的 CLI                                                                                                                                        |

Pi 的真实 API 验收使用独立测试配置，复用用户授权的现有 API；未修改原有 Pi Provider 配置。Cursor 与 Gemini 的隔离安装没有覆盖已有 Grok 的 `agent` 命令。测试配置、凭据、原生会话和私有 API 地址均不进入 Git。

Codex、Claude、Gemini、Pi、Cursor、OpenCode 的品牌图标均已接入；浅/深色主题图片加载检查通过。Pi/Cursor 使用官方 SVG，来源见 `src/renderer/assets/agents/README.md`。

## 实现边界

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

协议依据、参数限制、事件与安全模式见 [CLI 协议依据](cli-protocol-evidence.md)。这些适配器不是通用 MCP 接入，不是 OS 沙箱，也不提供未实现的原生审批或人工提问桥接。收到无法处理的原生工具审批请求会报错并停止。Claude 仅开放原生只读文件/Skill 工具，强制关闭 hooks、Skill 内联 shell 和 MCP；启动工具集限定为只读白名单，并显式拒绝写入、shell、子任务和网络工具。`Skill.allowed-tools` 与用户/管理员策略的实际交集尚未完成独立 CLI 验证，不能仅凭模拟 argv 断言宣称整个安全边界已验收。发现阶段只静态读取插件 Skill 元数据；真实启动后插件执行副作用仍需独立确认，不能把发现阶段不执行代码当作运行期隔离证明。Cursor 的工作目录信任单独由宿主确认：只在用户批准本次任务后加 `--trust`，保持 `--mode ask`，不启用 `--force`、`--yolo` 或自动批准 MCP。拒绝或等待时停止均不启动 CLI，迟到审批失效。额度/认证错误仅显示固定分类，不转发原始 stderr。

## 验证入口

- `npm test`：协议、权限、用量、引导与状态回归；条件性跳过的浏览器/Neo 检查不算已验证，以对应提交的实际输出为准。
- `npm run typecheck`、`npm run build`：类型与构建检查。
- 首页、控件、引导及 USD 用量四组隔离 renderer 检查通过。测试可使用已安装的 BrowserOS、Chrome 或 Playwright Chromium，也可显式设置 `WORKBENCH_TEST_BROWSER_EXECUTABLE`；这不验证 Neo 或桌面控制能力。
- `tests/mainstream-cli-ui.e2e.ts`：真实 Electron，独立应用数据/临时项目，使用用户已安装的 Pi。目标是通过界面逐次批准指定文件 write/read，核对文件、CLI 消息模型证据及用量；重启后以同一原生 ID 续聊并回忆前轮随机标记；真实停止流式任务并保留下一段草稿。本次完整结果仍受上表所列续聊问题阻塞。验证默认值仅影响新对话、旧无 agent 档案仍属 Codex、已执行对话切换 CLI 创建新会话。Claude 在此脚本仅被选择，不产生其模型调用；浏览器保持稍后准备。
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

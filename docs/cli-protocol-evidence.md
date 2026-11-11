# Claude Code / Gemini CLI / Cursor Agent 协议依据

本文记录隔离适配阶段的协议依据。当前源码新增了 Claude 的宿主 Neo MCP 接入，纯文本模式和 Gemini/Cursor 仍保留原限制。宿主集成与验证层级见 [本机 CLI 适配](mainstream-cli-support.md)；不能把协议或模拟结果当作全部远端模型实测通过。

## 范围与验证层级

实现：`src/main/stream-cli-session.ts`，统一导出 `StreamCliSession`，构造参数为 `AgentSessionOptions & { cli: 'claude' | 'gemini' | 'cursor' }`。
模拟测试：`tests/stream-cli-session.test.ts`。下文最初记录隔离适配阶段；后续真实测试、安装及宿主集成状态以上述验收矩阵为准。

本机只执行无模型费用的 `--help` / `--version`：

- Claude Code：`2.1.314`，`~/.local/bin/claude`。
- Cursor Agent：`2026.01.23-916f423`，`~/.local/bin/cursor-agent`；另存在 `agent`。不使用编辑器命令 `cursor`。
- Gemini：不在 PATH，**没有本机 help、登录、真实执行或续聊验证**。参数/协议来自官方源码；安装版本必须支持下列参数，不支持即失败，不降级权限策略。

## 一手资料

### Claude Code

- [官方 headless 文档](https://code.claude.com/docs/en/headless)：`--print --output-format stream-json --verbose --include-partial-messages`；`stream_event.event.delta.type=text_delta` 的 `text`；最终 `result`；通过 `--resume <session-id>` 恢复明确会话。文档明确要求检查退出码，失败可能在 stdout result 中报告。
- [官方 CLI 参数](https://code.claude.com/docs/en/cli-reference) 与本机 `claude 2.1.311 --help`：`--tools` 指定可用内置工具，`--allowedTools` 仅配置 permission allow 规则，二者重复但职责不同；当前均设 `Read,Glob,Grep,Skill`。`--disallowedTools` 显式拒绝 `Write,Edit,Bash,Task,WebFetch,WebSearch`；`--permission-mode dontAsk --permission-prompts none` 使其它需要审批的调用拒绝而不等待。`--strict-mcp-config --mcp-config '{"mcpServers":{}}'` 不载入用户 MCP。`--settings` 仅对该次进程设 `disableAllHooks` 和 `disableSkillShellExecution`，分别关闭配置/插件 hooks 与 Skill/custom command 的内联 shell；保留 slash Skill 原生分发。未使用 `--safe-mode`（该模式禁用 Skills），也未设置未经 CLI 支持承诺的环境变量。
- 本机 help / headless 文档：`--permission-mode dontAsk --permission-prompts none`，无人审批时拒绝请求而非等待；保留 `--no-chrome`。Skill 正文中的 `allowed-tools` 不能视为用户或宿主授权；与启动工具白名单、既有 deny 的实际交集仍需独立 CLI 验证，模拟测试不能证明此边界。
- [本机 headless 事件](https://code.claude.com/docs/en/headless) / 本机 help：使用原生 `assistant.message.content[].type=tool_use` 和后续 `user.message.content[].type=tool_result` 记录工具生命周期。仅接受 `Read,Glob,Grep,Skill` 的调用且校验对应结果完成；工具返回错误或结果缺失时任务失败。工具结果正文与 thinking 不进入用户可见事件。
- Neo 通过每轮私有 MCP 配置接入，严格限定为 Athena 工具；`alwaysLoad` 与 `ENABLE_TOOL_SEARCH=false` 保证首轮可见，配置与连接在回合结束后关闭。只读内置工具与 Neo 工具分别记录，完整工具许可同时覆盖两者。

只对当前 assistant 消息内的模型字段发 `cli-message` 模型证据；初始化配置不算运行模型证明。usage 使用最终 result 的本轮累计数据；input 为明确给出的 uncached + cache-read + cache-write 之和，任一缺失则 input 未知；没有明确 total_tokens 时总 token 未知。不把 reasoning 或未报告 cache 字段填零。

### Gemini CLI

引用官方仓库快照：[`89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31`](https://github.com/google-gemini/gemini-cli/tree/89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31)（检查时 main）：

- [`docs/cli/headless.md`](https://github.com/google-gemini/gemini-cli/blob/89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31/docs/cli/headless.md) / [`cli-reference.md`](https://github.com/google-gemini/gemini-cli/blob/89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31/docs/cli/cli-reference.md)：非 TTY stdin 触发 headless；`--output-format stream-json`；`--resume <session-id>`；`--approval-mode plan`。
- [`packages/core/src/output/types.ts`](https://github.com/google-gemini/gemini-cli/blob/89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31/packages/core/src/output/types.ts)：`init.session_id`；`message.role=assistant/content/delta`；`result.status` 与 `stats`。`error.severity=warning` 不等于失败，但不把警告原文展示给用户。
- [`stream-json-formatter.ts`](https://github.com/google-gemini/gemini-cli/blob/89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31/packages/core/src/output/stream-json-formatter.ts)：stats.input_tokens/output_tokens/cached/total_tokens，及 models 的执行用量分解。init.model 可能是 router/auto 别名，**不作为运行模型证据**；只发有实际 token 记录的 stats.models 名称。
- [`packages/cli/src/config/config.ts`](https://github.com/google-gemini/gemini-cli/blob/89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31/packages/cli/src/config/config.ts)：支持 `--admin-policy`；用户关闭 plan 功能时，plan **会退回 default**。所以仅添加 plan 参数不足以保护工具权限。
- [`docs/reference/policy-engine.md`](https://github.com/google-gemini/gemini-cli/blob/89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31/docs/reference/policy-engine.md) / [`packages/core/src/policy/config.ts`](https://github.com/google-gemini/gemini-cli/blob/89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31/packages/core/src/policy/config.ts)：临时 TOML `toolName="*", decision="deny", priority=999` 通过 `--admin-policy` 载入，禁止所有原生及 MCP 工具，不自动批准；不写入 ~/.gemini。官方若发现标准系统策略目录有 TOML 会**忽略补充 admin-policy**，适配器先检查并拒绝此环境；不可读取目录也拒绝。目录来自官方 `Storage.getSystemPoliciesDir()`（macOS `/Library/Application Support/GeminiCli/policies`、Linux `/etc/gemini-cli/policies`、Windows `C:\ProgramData\gemini-cli\policies`）。临时策略按回合清理。
- [`extensionEnablement.ts`](https://github.com/google-gemini/gemini-cli/blob/89e9d25d67e7dc7cb0deb84ad2c3474b7a392d31/packages/cli/src/config/extensions/extensionEnablement.ts)：`--extensions none` 明确禁用扩展。

这里是**无原生工具能力**，并非已经接通 Gemini 原生审批，也不是可写的规划执行器。保留本机 Provider/登录；未重写 hooks、用户或企业配置，不宣称这是隔离恶意本机配置的 OS 安全沙箱。系统策略预检与 CLI 自身加载之间仍有外部配置变更窗口，真实验收必须在可信、稳定配置下进行。

### Cursor Agent

- [官方参数](https://cursor.com/docs/cli/reference/parameters) 与本机 help：`--print --output-format stream-json --stream-partial-output --mode ask`；`--resume <chatId>`。本机 help 明确 ask 只读。
- [官方使用说明](https://cursor.com/docs/cli/using)：Ask 用于探索代码，不编辑文件；默认 print 模式有写权限，**不能仅依赖 print 模式作为限制**。保留用户现有配置，未使用 `--force` / `--approve-mcps`。
- [官方输出格式](https://cursor.com/docs/cli/reference/output-format)：init 原生 session_id；assistant.message.content text；result.subtype=success / is_error=false / result / session_id；失败以非零退出、stderr 报告，可能没有最终 result。
- 官方 partial 去重规则：仅追加有 `timestamp_ms` 且**没有** `model_call_id` 的 assistant 事件；有 model_call_id 的 pre-tool flush 与没有 timestamp 的 final flush 都是重复。最终 result 为全部文本，可补齐未收到的尾部；不同前缀则报协议错误，不拼接伪造输出。
- 官方工具事件：tool_call.started/completed，以 call_id 关联；readToolCall.args 与 result.success。适配器只接收已知读取/搜索类工具名，公开 input/status，不转发原始工具输出；错误、未完成或非只读工具事件会失败并终止进程组。此检查不能替代启动时 ask 权限模式。

Cursor 文档只提供 init 的模型显示名称，没有当前 assistant 的运行模型证明或正式 token 用量字段，因此两者保持未知；不套用 Claude 的 usage 协议。ask 的 CLI 级只读不等于 OS 沙箱；现有 MCP/hooks 配置的可信性仍由本机环境负责。未接通原生工具审批，不把接收到的 tool.started 当作宿主批准。

## 宿主集成注意

- 父任务负责 main/UI/store/discovery/onboarding；本文件不改这些入口。按对话固定 CLI，只有同 CLI 的原生 session ID 可以恢复；不能从 Codex/Pi/其他 CLI ID 或拼接历史创建“恢复”。
- `prepare()` 只校验配置，不启动模型；`isReady` 不代表已登录或恢复成功。模型发现由 `src/main/cli-models.ts` 分协议读取，不发送用户 prompt。Claude 使用 `initialize` 控制响应中的 `models`，Cursor 使用 `--list-models`，Gemini 使用 `--list-models --output-format json`。不识别的响应、启动失败和超时均报错，不用空目录掩盖失败。
- Claude 的模型标识与 `supportedEffortLevels` 来自原生响应，参考 [官方 SDK 的初始化结果与 ModelInfo](https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolinitializeresponse)。Cursor 的原生模型变体保持完整 ID，不从名称推测独立推理档位，参考[官方 CLI 参数](https://cursor.com/docs/cli/reference/parameters)。Gemini 的 JSON 格式按本机 `0.67.0` 包中 `packages/cli/src/commands/models/list.ts` 核对；它提供 CLI 可选项，不证明该账号能完成付费推理。
- 模型发现进程不保存 Claude 会话、不传入浏览器工具，最多运行 20 秒并限制输出大小。关闭/刷新失效时撤销读取并终止进程组；只返回模型字段，丢弃账户信息和原始诊断。旧版 CLI 不支持查询 flag 时显式失败，不把命令文本降级为模型 prompt。
- 首次 `send()` 等待原生 init 才发 run-started；恢复 ID 不同立即失败，缺失 session 不重试建新。失败/停止后 adapter 关闭，宿主可显式新建 adapter 并使用已保存的原生 ID 再恢复，不自动重放消息。
- Claude 可接收宿主浏览器工具和精确元素上下文，工具经私有 MCP 回到宿主校验；Gemini/Cursor 仍要求 `tools: []` 并拒绝元素上下文。Gemini 与 Cursor 的目录信任仍需逐次批准；未桥接的原生审批/提问会停止，不自动批准。目录信任不等于任意命令或文件写入授权。
- prompt/context 走 stdin 并 EOF，不经过 shell，不修改凭据。stderr 排空但不展示；协议错误使用固定错误文案。stdout 仅解析已知公开文本/元数据，不发 thinking 或完整协议记录。
- 每回合都必须具备匹配的 init、成功原生 result、正常退出码，才发 complete。只见 delta、只见退出码 0、权限拒绝、错误 result、无 result、中止和非零退出都不会成功。
- POSIX detached 进程组 TERM 后 1.5 秒 KILL；即使 leader 先退出也保留组清理。停止不以杀进程假装模型已完成。Claude/Gemini 初始化超时为 30 秒，Cursor 为 60 秒；目录确认等待及整回合各有 15 分钟上限；不无限等待原生交互。Windows 没有 POSIX 进程组能力，仅直接终止子进程，进程树停止能力**未验证**。

## 验证命令

```bash
node_modules/.bin/tsx --test tests/stream-cli-session.test.ts
node_modules/.bin/tsc --noEmit --ignoreConfig --target ES2023 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node src/main/stream-cli-session.ts tests/stream-cli-session.test.ts
```

模拟覆盖：三个协议的 UTF-8 分帧、partial/完整文本去重、无 LF 尾记录、原生续聊与重建 adapter 后恢复、恢复失败不换新会话、unknown usage/model、错误/权限拒绝/协议破损不假成功、未桥接审批拒绝、工具事件、并发保护、关闭、强制停止及 leader 先退出的后代清理。它们证明适配器的协议处理，不证明真实服务、真实账号、模型路由、真实原生工具行为或 UI 集成。真实逐项验收仍由父任务执行，尤其 Gemini 在安装并检查本机 help 前不得宣称可用。

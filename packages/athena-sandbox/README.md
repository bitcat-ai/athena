# athena-sandbox

Athena 远程沙箱协议（ASP v1）在 workspace 内的实现，POC 版本 0.1.0。协议见 [docs/sandbox/protocol.md](../../docs/sandbox/protocol.md)。

单个 Node 文件，零依赖，需要 Node 18 或更高版本、`git`，以及（执行任务时）Codex CLI。

## 安装

Athena 在第一次使用某个 Coder 沙箱时自动安装：通过 SSH 把这个文件写到工作区的 `~/.athena-sandbox/athena-sandbox.mjs`，之后用 `node` 运行它，不需要 sudo。文件内容有变化时会替换，并先停止旧版本的守护进程。连接方式见 [沙箱实例与回收](../../docs/sandboxes.md)。

也可以手动安装（已执行过 `coder config-ssh`）：

```bash
ssh coder.<workspace> 'mkdir -p ~/.athena-sandbox && cat > ~/.athena-sandbox/athena-sandbox.mjs' \
  < packages/athena-sandbox/athena-sandbox.mjs
```

文件要保留 `.mjs` 扩展名。请确认主目录在持久卷上，否则工作区重启后会重新安装。

## 命令

下表中的 `athena-sandbox` 指 `node ~/.athena-sandbox/athena-sandbox.mjs`。

| 命令 | 说明 |
|---|---|
| `athena-sandbox attach --protocol 1` | Athena 通过 ssh 调用。守护进程未运行时自动启动 |
| `athena-sandbox daemon` | 前台运行守护进程（调试用） |
| `athena-sandbox status` | 查看守护进程、仓库、Agent 和服务状态 |
| `athena-sandbox stop` | 停止守护进程及其启动的服务 |
| `athena-sandbox version` | 版本 |

## 行为

- 状态保存在 `~/.athena-sandbox/`：`state.json`、`events.jsonl`（事件日志，至少保留 10,000 条或 24 小时）、`daemon.log`、`sandboxd.sock`（权限 0600）。
- 仓库：默认使用 `$HOME` 下两层以内的 git 仓库，第一个作为工作目录；可用 `ATHENA_SANDBOX_REPOS` 指定（冒号分隔）。diff 的基准是守护进程第一次看到的提交。
- Agent：每个守护进程一个 `codex app-server` 进程和会话，首次执行任务时启动。默认 `sandbox=workspace-write`、`approvalPolicy=untrusted`，审批全部交给 Athena，不会自动批准。可用 `ATHENA_SANDBOX_CODEX_SANDBOX`、`ATHENA_SANDBOX_CODEX_APPROVAL` 调整。
- 服务：来自 `service.start` 或仓库的 `.athena/sandbox.json`。通过 `PORT` 环境变量告知端口，在 `127.0.0.1` 上做 HTTP 或 TCP 健康检查，保留最近 1000 行日志（已脱敏）。
- 守护进程重启后，未结束的任务标记为 `unknown`，不会重新执行；事件序号继续递增。

## 已知限制

- POC：没有资源配额与多用户隔离，假定每个 workspace 一个用户。
- Codex 需要能访问模型服务。在不能出网的 workspace 中，任务会以明确的错误结束。
- 服务进程由守护进程管理；守护进程停止时服务一并停止。

## 测试

`tests/athena-sandbox.test.ts` 用 Athena 自己的客户端驱动这个程序（Codex 用测试替身），并逐条校验输出符合协议 schema。

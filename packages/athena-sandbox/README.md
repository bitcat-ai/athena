# athena-sandbox

Athena 远程沙箱协议（ASP v1）在 workspace 内的实现，POC 版本 0.1.0。协议见 [docs/sandbox/protocol.md](../../docs/sandbox/protocol.md)。

单个 Node 文件，零依赖，需要 Node 18 或更高版本、`git`，以及（执行任务时）Codex CLI。

## 安装

在 Mac 上（已执行过 `coder config-ssh`）：

```bash
ssh coder.<workspace> 'mkdir -p ~/.local/bin && cat > ~/.local/bin/athena-sandbox && chmod 755 ~/.local/bin/athena-sandbox' \
  < packages/athena-sandbox/athena-sandbox.mjs
```

或者在模板中把这个文件放到 PATH 中的任意目录。Athena 连接时会把 `~/.local/bin` 加入 PATH，所以装在用户目录即可，不需要 sudo。请确认该目录在持久卷上。

## 命令

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

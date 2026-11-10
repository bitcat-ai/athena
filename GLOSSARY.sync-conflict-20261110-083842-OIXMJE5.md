# 领域术语表

## Agent

能够理解用户任务并产出回复或执行动作的智能执行者。在 Athena 中，Agent 由底层 CLI 提供，Athena 负责会话、任务状态和用户界面。

## CLI Agent

通过本机命令行程序提供 Agent 能力的执行器，例如 Codex、Claude Code、Gemini CLI、Pi 和 Cursor Agent。

## Skill

一组可复用的任务指导。Skill 以目录为边界，以 `SKILL.md` 作为说明入口，并可包含脚本、参考资料和其他资源。

## Skill 包

一个完整的 Skill 目录及其内容。Skill 包具有名称、描述、来源和内容版本等可识别信息。

## Skill 来源

Skill 包所在的目录范围。项目来源属于当前工作区，用户来源属于个人配置；来源用于解决同名 Skill 的优先级和展示。

## Skill 选择

用户为当前任务指定要使用的 Skill 集合。选择只影响当前任务，不改变其他任务或已有会话。

## Skill 注入

把已选择的 Skill 信息提供给 Agent，使 Agent 能在任务中按需读取和使用该 Skill。注入不等同于执行 Skill 中的脚本。

## 能力降级

当某个 CLI Agent 不支持 Skill 的全部能力时，仍使用其支持的部分，并明确记录未生效的能力。

## 任务

用户提交的一次独立工作请求及其执行过程。任务拥有自己的 Agent、Skill 选择、状态和结果记录。

## MCP

一种让 Agent 与工具、资源或应用能力交换信息的协议边界。MCP 与 Skill 是不同概念：Skill 提供任务指导，MCP 提供可调用的能力或资源接口。

## Athena MCP Endpoint

由 Athena 提供的 MCP 服务入口。外部 Agent 通过 HTTP 和受控授权访问 Athena 暴露的状态或线程能力；它不是第三方 MCP Server，也不等同于 Athena 连接外部工具服务。

## 外部 MCP Server

由 Athena 以 MCP Client 身份连接的第三方工具或资源服务。本阶段的 Athena MCP Endpoint 需求不等同于外部 MCP Server 接入。

## 外部 Agent

不是由 Athena 本机 AgentSession 启动，但通过 Athena MCP Endpoint 访问 Athena 状态或线程的 Agent。外部 Agent 必须经过身份识别、访问范围审批和可撤销授权。

## 访问模式

外部 Agent 访问 Athena 能力的权限等级。本项目采用只读、监督式和完全访问三档；访问模式限制外部 Agent 能执行的动作，不取消 Athena 对浏览器、桌面和敏感操作的本机审批边界。

## 线程

可独立启动、发送消息、停止并读取状态的一次 Agent 执行单元。忙碌线程收到的新消息进入后续轮次，不打断当前轮次。

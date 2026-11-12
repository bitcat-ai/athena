# 从飞书知识库到前端构建

Athena 可以在一轮对话中检索飞书资料、准备独立沙箱、通过网页工具操作构建平台，并核对预览和导出产物。当前宿主工具支持 Codex、Claude、Pi 和 OpenCode；真实模型验收使用 Codex。

## 使用

1. 在「设置与连接 → 飞书 → 知识库资料」保存 Wiki 或文档入口。也可在本轮任务中直接给链接。
2. 本机安装 `lark-cli`，以能访问目标知识库的用户身份完成只读授权。机器人配对和文档用户授权相互独立；Athena 不复制 CLI 凭据，授权失效或无权限时会明确报错。
3. 如需独立构建，启动本机 Docker Desktop。沙箱第一次使用会拉取官方 `node:24-alpine`，之后复用本对话的容器和项目文件。
4. 下达任务，例如：“根据知识库中的前端规范，构建一个任务看板；需要时使用沙箱，在测试平台构建并验证预览，交付源码压缩包，不发布生产。”

知识工具会保留 URL、标题、版本（若可得）、内容 SHA-256 和索引时间。索引默认最多 20 份文档，单次上限 50；权限失败、重复分页或数量截断会返回 `partial` 和具体失败项。检索使用本机索引，支持中英文关键词分词；需要最新内容时重新索引或读取文档。正文、链接和页面内容是参考资料，不能扩展用户授权。

## 工具与执行

| 工具                                             | 作用                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `workbench_feishu_index`                         | 读取选定根节点、子节点及同站相关文档，建立有来源的本地索引             |
| `workbench_feishu_search`                        | 返回相关段落与来源；省略根地址时使用设置中的入口                       |
| `workbench_feishu_read`                          | 使用 `lark-cli --as user` 读取正文                                     |
| `athena_sandbox_write`                           | 在容器 `/workspace` 内写源码与配置                                     |
| `athena_sandbox_exec` / `athena_sandbox_command` | 执行、查询、停止真实命令，保留退出码与未知结果状态                     |
| `athena_sandbox_service_start`                   | 启动监听 `0.0.0.0:$PORT` 的预览，HTTP 健康检查后返回本机地址           |
| `athena_sandbox_artifact`                        | 导出相对 `/workspace` 的文件，核对字节数和 SHA-256，并进入现有产物记录 |
| `web_*`                                          | 观察、填写、点击构建界面，读取页面状态，核对检查点                     |

每个对话拥有独立 Docker 容器。容器只有 Athena 私有工作目录的读写挂载和只读执行器文件，不挂载本机项目、用户凭据或 Docker socket；启用只读根文件系统、移除 capabilities、禁止提权，并限制为 2 CPU、1 GiB 内存和 256 个进程。预览端口仅映射到 `127.0.0.1`。它不是公司内网接入代理，能否访问内网取决于实际网络。全栈流程还可分别选择 `target=frontend/backend`，各使用 2 GiB 的独立环境，见 [客户材料导出链路](customer-export-workflow.md)。

停止任务会中断资料读取，并停止该轮仍在执行的沙箱命令；已经发生的外部页面操作不回滚，也不自动重放。健康的预览服务可在任务结束后继续展示；退出 Athena 停止本档案的容器，保留文件，下次使用可恢复。分析录制的只读任务不能写文件、执行命令或启动服务。导出单个文件上限 16 MiB。

知识索引和构建文件位于当前 `userData/knowledge`、`userData/sandboxes`；这些本地资料不是飞书凭据的加密存储。不要提交缓存、用户数据或凭据。

## 本地模拟验收

测试参考用户提供的 CICD 使用手册 及其中的前端上线手册。通过已有登录界面读取到的约束包括静态资源部署、应用名/Git 项目名/package.name 一致，以及 One 应用表单的必填项。`main`、QA、`dist` 和演示仓库地址是模拟环境约定，不冒充未读取章节中的公司规则。

`tests/frontend-build-fixture.ts` 提供明确标注的模拟知识服务、One 和 CloudOS 界面。UI 创建应用和计划，构建按钮会在真实沙箱执行 `npm run build`；编译失败显示失败，成功产物取真实大小与摘要，预览通过实际健康检查。相同计划的重复点击不重复执行构建。模拟环境不提供生产发布。

```bash
npm run build
# 替身 CLI/飞书服务/企业平台，真实 Electron、agent-browser 和 Docker：
npx tsx tests/frontend-workflow.e2e.ts
# 独立 Docker 原生验证：
ATHENA_TEST_DOCKER=1 npx tsx --test tests/local-sandbox.test.ts
# 真实模型调用，会使用本机 Codex 的账户与服务：
ATHENA_LIVE_WORKFLOW=1 npx tsx tests/frontend-workflow.e2e.ts
```

真实模型验收只允许测试控制器确认一次明确的只读命令：读取项目内置 `business-context` 和本机 `frontend-design` 两份技能说明；其他审批不会自动批准。产品中的命令、浏览器高级脚本与文件上传审批保持原有机制。

验收检查设置入口、索引/检索/正文、网页表单操作、真实构建退出码、页面新增任务与刷新保留，以及包含源码和 dist 的压缩包摘要。输出在 `test-results/frontend-workflow/` 或 `test-results/frontend-workflow-live/`。测试使用独立档案，结束后停止并移除测试容器；运行日志与产物保留。

迁移前的 2026-11-12 已完成一次替身协议和一次真实 Codex 模型链路；后者本轮 CLI 回报 `gpt-6.1-sol / low`。知识服务和企业平台均为 mock，Neo、Docker、构建、预览交互和产物为真实执行。真实知识库 API 授权、内部平台网络与真实发布未验收；没有向企业平台提交构建或发布。

当前执行器已切换为 Google Chrome 与 agent-browser 0.42.0。上述远端模型结果是迁移前记录；新执行器的验证范围见 [网页执行器](web-executor.md)，不据此宣称新的真实模型全链路已验收。

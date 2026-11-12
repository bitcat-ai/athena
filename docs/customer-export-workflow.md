# 客户材料导出：全栈沙箱与元素需求链路

这份说明对应独立的 Meridian 客户工作台演示，不连接企业生产数据。客户、材料和飞书知识服务为明确标注的示例；模型调用、网页操作、Git 仓库、Java API、依赖安装、构建与下载文件使用实际执行结果。

## 两个入口

1. 业务任务：观察客户网站 → 检索客户操作手册 → 仓库 MCP 定位前后端 → 两个沙箱实现 → 测试分支提交 → 从远端重新拉取 → 网页下载验收。
2. 元素任务：点击「选取元素」，在网页选中「查看资料」按钮，输入「旁边添加导出材料按钮」及功能描述 → 真实网页出现可撤销预览 → 保存 PRD → 进入相同的源码实现与验收链路。

元素需求可以分多轮推进：先预览、再调整、补充功能、查看 PRD，最后确认实现。会话保留待确认预览，下一轮使用前重新核对元素；已保存的 PRD 可从执行记录中「查看 PRD」打开。每个沙箱拥有独立的磨砂小窗，显示真实连接、命令输出和应用预览，可分别拖动、关闭后重新打开。Skill 与仓库 MCP 的实际调用及返回知识在对话中直接显示；PRD 通过独立文档卡片打开，提供目录与折叠的页面证据。

PRD 由 `workbench_prd_save` 保存到当前档案的 `requirements/`，并以带字节数和 SHA-256 的产物显示。文件保留用户原始要求、网页地址、元素身份、实际预览、功能范围、资料来源和验收条件。保存前重新检查预览元素；导航、元素替换或文字变化导致不匹配时拒绝保存。成功预览后，仓库操作和沙箱实现须先经过 PRD 记录。仅请求临时外观预览时，不自动扩大到源码实现。

预览按钮表示位置和样式，不能据此认定下载功能已实现。源码完成后，需要用新的运行实例重新验证，不能拿 DOM 预览作为最终结果。

## 示例仓库与业务规则

真实私有仓库：[Dylan-Nihilo/athena-customer-materials-demo](https://github.com/Dylan-Nihilo/athena-customer-materials-demo)。`main` 保留没有导出功能的基线，源码目录为 `frontend/` 和 `backend/`，业务手册为 `docs/customer-handbook.md`。

基线提供 15 个虚构客户、搜索、合作状态筛选、每页 6 条、客户详情和单份材料查看。新增导出由 Java 生成 ZIP：只包含当前客户的 `customer.json` 与营业资质、服务协议、结算说明。内部跟进备注和其他客户材料不能进入压缩包。验收下载 C1001 与 C1008，解包核对内容、归属、路径和摘要。

## 独立执行环境

沙箱工具接受 `target`：

| 目标                | 环境                      | 用途                       |
| ------------------- | ------------------------- | -------------------------- |
| `default`（省略时） | Node 24                   | 兼容已有前端流程           |
| `frontend`          | Node 24、npm、Git         | 前端克隆、安装、构建和预览 |
| `backend`           | Java 21、Maven、Node、Git | 后端克隆、测试、打包和 API |

前后端各有独立容器和私有工作目录，不共享项目可写挂载，不挂载用户凭据或 Docker socket。组件沙箱为 2 CPU、2 GiB、256 PID，根文件系统只读，禁止提权；默认沙箱仍为 1 GiB。网络可用于安装依赖。服务监听 `0.0.0.0:$PORT`，映射只绑定宿主 `127.0.0.1`；Java 健康路径为 `/api/health`。第一次 Maven 安装可能较慢，构建命令应使用足够的 `timeout_seconds` 并查询最终退出码。

## 仓库映射 MCP

当前提供的是显式配置的本机仓库服务入口，不是通用第三方 MCP 管理界面。宿主通过 `ATHENA_REPOSITORY_MCP_URL` 与 `ATHENA_REPOSITORY_MCP_TOKEN` 连接已授权服务；仅接受有凭据的回环 HTTP 地址，不跟随重定向，凭据不传入 CLI 子进程。

演示服务执行真实 MCP initialize、工具发现与调用。`workbench_repository_resolve` 按网站 origin 和 `customers` 模块返回仓库、基线提交和两个代码目录；沙箱通过短期传输地址获取 Git bundle，origin 保留真实仓库 URL，GitHub 凭据留在宿主。两个沙箱分别提交并上传 bundle 后，`workbench_repository_publish` 验证基线祖先和组件目录范围，拒绝跨目录修改、符号链接或子模块，合并到新的测试分支并推送，随后读取远端 SHA 核对。不会合并 `main` 或发布生产。

取消传输不会被解释为成功；已开始的 Git push 结果仍须通过远端 SHA 核对，不能凭模型文字判断是否提交。

## 验证与录制

测试源码：`tests/customer-export-video.e2e.ts`。它使用独立 Athena 档案和实际模型账户，完整录制真实 Electron 画面。环境准备需已安装 Docker Desktop、Google Chrome、相应 CLI，并有该私有测试仓库的 Git 权限。

```bash
# 在新的测试目录准备 main 基线，不覆盖已有工作目录
gh repo clone Dylan-Nihilo/athena-customer-materials-demo .runtime/customer-export-demo/repo
npm run setup:agent-browser
npm run build

# 真实 Codex 业务任务链路
npx tsx tests/customer-export-video.e2e.ts

# 真实 Claude：选中元素 → 页面预览 → PRD → 双沙箱改造
ATHENA_CUSTOMER_FLOW=element npx tsx tests/customer-export-video.e2e.ts
```

输出在 `test-results/customer-export/run-*/`，包括原始视频、实际截图、模型工具记录、仓库 MCP 审计、远端提交、重新拉取后的构建记录和浏览器下载的 ZIP。失败录制会保留失败状态，不改写成成功；继续已有沙箱使用 `ATHENA_CUSTOMER_RESUME=<该运行目录>`，不能把尚在执行的实例当作失败重启。

当前执行器为 Chrome 与 agent-browser 0.42.0，使用 `web_*` 工具，见 [网页执行器](web-executor.md)。以下录制和远端模型验收均为迁移前的历史结果，不能代替新执行器的真实模型验收。旧版 Neo 的空闲 MCP 404 恢复逻辑已随执行器移除。

2026-11-12 两条真实模型路线均完成远端提交与全新容器复建后的 Neo 下载复测。Codex 路线提交为 `99ab25ae3c28aae891e55d31c97c071879df154e`；Claude 元素预览/PRD 路线为 `749ad9e1ff60de21c5e2c48a944ebcb4ec1b574c`。CLI 分别回报 `gpt-6.1-sol / medium` 和 `claude-sonnet-5`。两个客户的实际 ZIP 均经摘要与内容隔离校验。录像包含真实恢复过程，不宣称一次无中断执行；详见本机 [交付报告](../output/customer-export-demo-20261112/README.md)。

后续按用户要求重新录制为一条完整交互流程：8 轮短对话，展示真实用户选取、Athena 光标、检查器、PRD、小窗及状态，再提交和复测。新验收提交为 `e04c5a20475d0023c1f426b178d73b9a9b4192d3`；请以 [重新录制的交互演示](../output/athena-interactive-demo-20261112/README.md) 为主。此前两份录像保留为工程验收资料。

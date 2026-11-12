# 贡献指南

感谢你帮助改进 Athena！欢迎提交问题反馈、文档修正、测试和代码改进。开始之前请阅读本指南及 [工程约定](AGENTS.md)。

> 本仓库公开可见，但项目代码仍为 **UNLICENSED**，尚未授予开源许可证。本指南不授予额外的使用、修改或分发许可；涉及授权或贡献权利的问题，请先与维护者确认。第三方组件遵循其各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 问题反馈与功能建议

提交前请搜索已有 Issue 和 Pull Request，避免重复。一个 Issue 聚焦一个问题，并提供：

- **问题描述**：预期行为、实际行为和影响范围。
- **复现步骤**：尽可能提供最小示例，以及出现频率。
- **环境信息**：Athena 版本或提交、macOS 版本与芯片架构；源码开发时附 Node.js、npm 及相关 CLI 版本。
- **补充证据**：脱敏后的日志、错误信息、截图或录屏。

功能建议请说明用户场景、期望结果和考虑过的替代方案。大型功能、协议变更或新增依赖请先在 Issue 中讨论范围，再开始实现。

不要在公开 Issue 或 PR 中暴露凭据、个人对话、浏览器配置、内部网址或其他敏感信息。安全漏洞请勿公开可利用细节；如仓库启用了 GitHub 私密漏洞报告，请使用该入口，否则先通过维护者已公开的私密联系方式沟通。不要为验证漏洞而访问他人数据或操作真实账户。

## 开发准备

当前桌面应用以 macOS 为主要开发环境，公开安装包面向 Apple Silicon。需要：

- Node.js **22.12+** 和 npm。
- CollectUI 分发的 HugeIcons Pro npm key，以及 HeroUI Pro 构建授权或有效的本机授权缓存。
- 进行真实 Agent 测试时，相关 CLI 已在本机安装并登录；仅检测到安装不等于执行能力已验证。
- 开发网页功能时，本机需已安装 Google Chrome；网页执行器使用项目固定版本的 agent-browser。

先 fork 或克隆仓库，在自己的开发分支工作：

```bash
git clone https://github.com/<your-account>/athena.git
cd athena
git switch -c docs/describe-your-change
```

分支名建议使用 `feat/`、`fix/`、`docs/` 或 `chore/` 前缀。已有工作区请先检查 `git status`，不要覆盖或回滚无关改动。

按照 [开发环境与验证](docs/user-guide.md#开发环境与验证) 配置依赖授权后运行：

```bash
npm ci
npm run setup:agent-browser
npm run dev
```

- HugeIcons Pro 鉴权只放在用户级 `~/.npmrc` 或 CI 临时用户配置中，不提交到仓库。
- `npm ci` 的 postinstall 会执行 `heroui:setup`；没有可用授权缓存时，通过私密环境配置提供 `HEROUI_KEY`。安装脚本不会自动读取 `.env`。
- 不提交密钥、授权缓存、完整 Pro 包或绕过授权的实现。
- `setup:agent-browser` 把固定版本的官方 agent-browser 下载到 `.runtime/` 并校验 SHA-256，不启动任何进程。

## 代码与设计约定

### 项目结构

| 路径 | 职责 |
| --- | --- |
| `src/main/` | Electron 主进程与本机能力 |
| `src/renderer/` | React 界面、交互与样式 |
| `src/shared/` | 跨进程共享类型与协议 |
| `packages/element-inspector/` | 网页元素检查器 |
| `tests/` | 单元测试与集成、端到端检查 |
| `scripts/` | 开发、构建和打包脚本 |
| `docs/` | 用户、设计与工程文档 |

### 实现原则

- 使用 TypeScript，保持类型清晰；复用现有组件、依赖和调用链，避免无关重构。
- 遵循邻近代码风格及 [.prettierrc.json](.prettierrc.json)：单引号、分号、100 列打印宽度、尾随逗号。不对无关文件批量格式化。
- 修改依赖时同步提交 `package.json` 与 `package-lock.json`，说明新增依赖的必要性及许可影响。
- 用户可见界面改动前先读 [DESIGN.md](DESIGN.md)。复用 `ChoiceSelect`、`ActionButton` 与现有主题 token；HeroUI 使用 v3 compound API 和 `onPress`。
- 保留键盘操作、ARIA 名称、焦点、输入法合成、错误、禁用和停止状态；检查窄窗口与深色主题。
- 不以假数据、样例成功结果或模型自述替代真实执行证据；未知费用与用量保持未知。
- 保持 `app.agent.workbench`、`Agent Workbench` 数据目录、`WORKBENCH_*`、`workbench:*` IPC 与 `workbench_browser_*` 工具标识兼容，不擅自修改钥匙串身份。
- 涉及网页操作、共享、审批或本机执行时，保留权限、人工接管和真实停止边界。Computer Use 相关工作先读 [交接说明](docs/computer-use-handoff.md)。

## 测试与验证

功能改动应补充对应测试；修复缺陷时尽量增加能够复现问题的回归测试。在仓库根目录运行基础检查：

```bash
npm run typecheck
npm test
npm run build
```

根据改动范围补充验证：

- **纯文档**：检查命令、相对链接、描述与实际实现是否一致，通常不需要运行应用测试。
- **界面与交互**：阅读对应 `tests/*.e2e.ts` 的前提，运行相关隔离 UI 检查，并提供实际应用或明确标注的隔离测试截图。
- **Electron 联调**：先构建，再按脚本前提运行 `npm run test:e2e` 或相关专项检查。
- **真实 CLI、模型与外部服务**：先确认授权、账户、费用和数据范围。`test:live-agent` 等真实模型测试可能产生费用；不得无授权发送真实飞书消息或执行外部写入。
- **打包相关**：按需运行 `npm run package`，它生成本机 ad-hoc 签名应用目录，不等同于正式分发。正式签名、公证与发布验证见 [macOS 签名与公证](docs/apple-signing.md)。

模拟 CLI/IPC、真实模型执行、构建、签名、公证、上传和可下载性是不同的验证层级。PR 中应明确实际验证了什么、哪些未验证及其原因，不要将其中一项成功外推为完整闭环通过。

## 提交与 Pull Request

1. 保持一个 PR 聚焦一个目的，将无关重构或格式整理拆开。
2. 提交信息使用简短的祈使句，说明改动内容；可按需使用 `fix:`、`feat:`、`docs:` 等前缀，例如 `docs: add contribution guide`。
3. 推送前检查 diff，确认没有凭据、用户数据、测试录制或生成产物。不要提交 `node_modules/`、`dist/` 或本机打包产物。
4. 提交 PR 时关联相关 Issue，并写明动机、实现概要、兼容性影响及验证结果。行为变化应同步更新相关文档；版本号和发布操作先与维护者确认。
5. 根据评审反馈更新代码，保持讨论尊重、具体且围绕问题本身。

可在 PR 描述中使用以下清单：

```markdown
## 变更说明
- 解决的问题与实现概要：
- 相关 Issue：

## 验证结果
- [ ] 已检查本次 diff，无无关修改、敏感数据或授权组件泄露
- [ ] 已补充或更新相关测试（不适用时说明原因）
- [ ] 已运行与改动相称的类型、测试和构建检查，并列出命令及结果
- [ ] 界面改动附实际截图及交互验证说明（如适用）
- [ ] 已同步相关文档并说明兼容性影响

未验证项、原因与已知限制：
```

感谢每一份认真、可复现、尊重用户数据与授权边界的贡献。

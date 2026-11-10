# Athena

Computer Use 相关工作先读 [交接说明](docs/computer-use-handoff.md)，需要方案、许可和官方出处时再读 [调研报告](docs/computer-use-research.md)。

- 交接说明区分用户已确认的需求、调研建议和未验证项；以用户后续明确指令更新工作范围。
- 当前浏览器功能已经实现，桌面 Computer Use 尚处调研阶段。不要把浏览器验收或文档示例当成桌面能力已验证。
- 保持现有数据、钥匙串和工具协议的兼容标识；相关说明见交接文件和 README。

## 开始工作

- 修改前检查实际分支、工作区和调用链，保护未提交内容；不回滚无关修改。
- 用户可见界面改动必须先读 [DESIGN.md](DESIGN.md)，再检查当前组件、token 和实际状态。使用说明见 [用户指南](docs/user-guide.md)。
- 复用现有组件、标准库与依赖；不因静态设计样例引入新后端、假数据或未经请求的抽象。
- 设计参考不能覆盖用户已确认的业务行为。用量继续以 USD API 等价估算与每日 USD 图优先；Figma 的 Token 优先示例属于较早快照。

## 当前技术栈

版本声明见 [package.json](package.json)，精确安装以锁文件为准：

- Electron `^45.1.0`、React/React DOM `^19.3.1`、TypeScript `^7.0.2`、Vite `^8.3.5`。
- HeroUI React/Styles `3.2.7`、HeroUI Pro `1.0.0-beta.10`、Tailwind CSS `4.3.3`。
- React Aria Components `1.22.1`、Motion `14.9.0`。通用图标使用 `@hugeicons-pro/core-stroke-rounded` 与 `@hugeicons/react`。
- 元素调整复用 [packages/element-inspector](packages/element-inspector/README.md) 与现有受约束的 A2UI 控件，不并行创建第二套检查器。

HeroUI 使用 v3 compound API 与 `onPress`。通用选择复用 `ChoiceSelect`，工具栏按钮复用 `ActionButton`。Pro 构件通过既有 `heroui:setup` 恢复授权缓存或使用私下配置的 `HEROUI_KEY`；不能提交密钥、完整 Pro 包或绕过授权。

## 常用命令

在仓库根目录运行：

```bash
npm ci
npm run setup:browseros
npm run dev
npm run typecheck
npm test
npm run build
npm start
npm run package
```

- HugeIcons Pro 的 CollectUI 鉴权配置在用户级 `~/.npmrc` 或 CI 临时用户配置中；仓库 `.npmrc` 只保留 registry，不放 Token 或仓库级鉴权占位。
- `npm ci` 的 postinstall 会执行 `heroui:setup`。安装脚本不自动读取 `.env`，密钥通过环境配置。
- `setup:browseros` 获取并校验官方固定版本，不启动浏览器或覆盖已有不同安装。
- `package` 生成本机应用目录；当前项目使用 ad-hoc 签名，未配置 Developer ID 分发签名、公证或自动更新。不要把项目配置写成“系统找不到证书”。
- 首页、选择与用量的隔离 UI 检查：`npx tsx tests/homepage-ui.e2e.ts`、`npx tsx tests/interaction-controls.e2e.ts`、`npx tsx tests/usage-currency-ui.e2e.ts`。
- 测试前读脚本前提。真实模型检查（如 `npm run test:live-agent`）与模拟 CLI/IPC 检查必须区分；已有授权覆盖的动作可继续，未授权时不产生模型费用或发真实消息。

## 界面与交互

- 视觉方向、圆角、阴影、组件映射和 Figma 链接以 [DESIGN.md](DESIGN.md) 为准：白底黑灰、少描边、柔和 surface，品牌和服务图标保留颜色。
- 正式标识使用 `src/renderer/assets/brand/athena-profile.png`；不要自动启用 v7 等候选素材。用户头像是本机名字首字母，不是账户服务。
- 产品页面、组件、原型和 mock 的可见文字必须服务真实用户任务。需求、实现理由、开发提示、审计结论与“尚待开发”占位说明不得伪装成产品文案。
- 保留 ARIA 名称、键盘焦点、输入法合成、草稿、错误、禁用和停止状态；适配窄窗口、减少动态效果与独立滚动区。
- 真实用户数据优先于设计示例。模型只显示 CLI 支持项；未知费用/用量保持未知或部分数据，不填零、假金额或样例成功结果。
- 任务 UI 使用公开计划、动作、证据、恢复、人工处理和产物；不显示隐藏推理或虚构进度。
- 去掉外层默认描边时保留焦点和必要的选中边界；灰色嵌套字段不重复叠加阴影。
- 新增外观 token 应进入 `theme.css`，兼容 `.dark` 与 `data-theme="dark"`；不在单个页面硬编码浅色背景。
- 首次引导记录独立于真实任务会话。保留历史与用户回看位置；顶部渐变模糊仅作用于历史层。旧档案没有引导标记不等于新用户，也不等于已验证所有依赖。
- 安装、登录、目录确认和浏览器准备必须由宿主结果推进。取消和重启后复查，不恢复待决操作为成功、不自动重放安装或登录；不通过模型调用生成引导文案。

## 执行与共享边界

- CLI 能力与验收层级见 [本机 CLI 适配](docs/mainstream-cli-support.md)。默认 CLI 只影响新对话，旧对话缺少 agent 字段时按 Codex 处理，不迁移原始会话或静默切换。安装检测不等于登录或真实执行已验证；浏览器工具目前仅向 Codex 开放。通用 MCP 管理、多 Agent 调度和账户/订阅服务尚未实现。
- 内部 Neo MCP 网页工具链不等于任意第三方 MCP 接入，也不代表 Mac 桌面控制能力。
- 模型选择与实际本轮配置分别验证；不能用上一轮记录或模型自述证明当前模型。
- 网页操作遵循观察、执行、读取结果、核对；失败或结果未知时先重新观察和核对，不能盲目重放。
- 页面预览与源码修改是独立链路；任意网站不会自动映射到本地项目。预览必须可撤销并绑定有效元素引用。
- 共享的是当前网页；参与者操作权限、当前控制权、页面/帧代次与预览作者不能合并或省略。共享期间 Agent 不接管页面。
- 保留真实停止、人工接管与审批边界。不要通过 CSS 或界面改造改变捕获比例、点击坐标或授权校验。
- 飞书配置与本地模拟测试不能表述为外部任务触发和最终回传已完成；桌面 Computer Use、敏感登录/验证码/支付等仍需各自验证。

## 数据、验证与交付

- 保持 `app.agent.workbench`、`Agent Workbench` 数据目录、`WORKBENCH_*` 环境变量、`workbench:*` IPC 与 `workbench_browser_*` 工具标识兼容。
- 不改写既有钥匙串身份，不把聊天、录制、profile、inbox 或凭据提交到 Git。普通工作区数据不等于加密数据。
- 完成与改动相称的类型、功能和 UI 检查。通过后只因新改动、失败或未解决疑点扩验或重跑。
- 截图来自实际应用或明确标注的隔离测试；不以 Figma 截图冒充实现。README 使用 `docs/screenshots/workspace.png` 的实机画面。
- 区分源码检查、构建成功、签名、安装包生成、Release 上传与可下载性；未核实的发布阶段不得宣称完成。
- Athena 自身保持 UNLICENSED；第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## Agent skills

### Issue tracker

Issues are tracked in GitHub repository `bitcat-ai/athena` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

This repository uses the default five triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.

<claude-mem-context>
# Memory Context

# [athena] recent context, 2026-11-02 2:47pm GMT+8

No previous sessions found.
</claude-mem-context>

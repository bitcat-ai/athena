# 网页执行器

本说明对应当前源码，不代表公开的 0.9.0 安装包已经包含这些改动。0.9.0 及更早版本使用 BrowserOS neo 与其 claw-server；当前源码改为本机 Google Chrome 加固定版本的 [agent-browser](https://github.com/vercel-labs/agent-browser/tree/v0.42.0)，不再包含 BrowserOS 的下载、启动或回退路径。

## 组成

| 部分       | 来源与边界                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器     | 用户已安装的 Google Chrome（或 Chromium）。Athena 不下载、不安装；以独立进程和 `userData/browser/agent-browser-profile` 启动，不读取日常浏览器的登录和数据                                               |
| 网页执行器 | agent-browser 0.42.0 官方发布的未修改二进制。按 `ATHENA_AGENT_BROWSER_PATH`、随包资源、开发副本、应用数据缓存的顺序查找，缺少时从官方发布下载                                                            |
| 完整性     | 开发副本、缓存和下载结果都按源码中固定的 SHA-256 校验；校验不通过不运行，版本不符也不运行                                                                                                                |
| 连接       | 执行器只连接 Athena 启动的 Chrome 的本机回环调试端口；每个执行器进程有独立的私有目录和 socket，环境只保留 PATH 与临时目录，不带入模型服务密钥和个人的 agent-browser 配置，并关闭自动处理对话框和更新检查 |
| 页面脚本   | `run` 的脚本在独立进程中运行：macOS Seatbelt 限制文件、网络和子进程，Node 权限模型和禁用代码生成的 vm 上下文作为第二层。脚本只能通过宿主逐项转发的页面方法操作                                           |
| 进程回收   | 正常停止时宿主结束执行器并删除其私有目录。宿主被强制结束或崩溃时，随执行器启动的一个守护 shell 在宿主消失后结束该执行器并清理目录；Athena 启动的 Chrome 沿用原有的浏览器进程处理方式，不在此列           |
| 任务记录   | `userData/agent-browser/ab-<id>.json`。输入值记为 `[hidden]`，网址的查询参数和片段不落盘                                                                                                                 |

源码入口：`src/main/agent-browser-server.ts`（二进制、进程与任务记录）、`agent-browser-session.ts`（页面与引用）、`agent-browser-tools.ts`（工具到执行器命令的转换）、`agent-browser-diff.ts`、`web-script.ts`（脚本隔离）。授权、恢复屏障和人工接管仍在宿主的网页运行时与 `web-execution.ts`。

## 保持不变的行为

- 基础操作直接执行：点击、填写、选择使用 `web_act`；元素文字、字体、颜色、字号、间距、布局和动画使用 `workbench_browser_edit`，无需额外审批，修改可撤销。字体通过 `font-family` 修改；整页换风格先查询页面和区块，再逐项编辑，样式核对使用 `workbench_browser_inspect`，不需要页面脚本。
- 工具清单、参数和审批：只读任务仍拒绝修改；`run` 与 `evaluate_in_page` 逐次确认脚本；上传逐次确认文件；人工协助使用原有请求与交还流程。
- 观察、执行、核对：失败的修改或未命中的等待进入恢复屏障，重新观察并提交检查点后才能继续；未知结果不重放。
- 人工操作使旧观察和排队动作失效，在途调用被取消，下一次观察建立新的执行器会话；显式停止结束整轮任务。
- 录制、共享、元素检查器、页面预览与撤销沿用原有链路，不经过执行器。
- 每轮任务的上下文除当前页面信息外，还带一份页面结构概览（`web_page_outline`，由页面桥接在 800 ms 内生成，约 6000 字符以内，属于不可信的页面数据）。外观与文案的预览走 `workbench_browser_restyle`：一次调用、无需确认、可撤销；校验不通过时以 `applied: false` 和原因作答，不算失败的修改，因此不会进入恢复屏障。

## 与此前的差别

- 网页工具的名称前缀由 `neo_` 改为 `web_`（如 `web_snapshot`、`web_act`），宿主入口为 `src/main/web-runtime.ts`。此前对话中以 `neo_` 记录的工具调用仍能正常显示。
- 元素引用的形式为 `ab<8 位十六进制>:eN`，绑定到产生它的执行器会话；执行器重建后旧引用被拒绝，需要重新观察。
- 链接或 `window.open` 打开的页面（包括登录弹窗）作为新标签出现，可通过标签列表找到。
- `run` 的脚本接口覆盖页面观察、动作、等待、截图、PDF、下载、上传和标签页；不提供原始 CDP、历史记录、窗口与 profile 管理。脚本上传的文件必须以完整路径出现在获批的脚本文本中。
- 不再有浏览器安装计划。未找到 Chrome 时引导与设置提供官网入口，安装后重新检查。
- 浏览器数据换为新的 profile：此前在 BrowserOS profile 中的网站登录不会迁移，需要重新登录。旧的网页任务记录（`userData/neo`）留在磁盘上，但不再在应用内显示。

## 迁移依据

迁移前用同一份确定性复杂流程脚本对两个执行器做了对照（筛选、翻页、跨标签读取、动态表单、iframe 与 Shadow DOM 批量填写、提交、回执丢失后的核对），没有模型调用，等待条件、检查点和服务端单次保存断言完全相同：

| 动作（中位数） | BrowserOS neo | agent-browser |
| -------------- | ------------- | ------------- |
| 点击           | 282 ms        | 17.5 ms       |
| 填写           | 955.5 ms      | 18 ms         |
| 选择           | 139 ms        | 3.5 ms        |
| 快照           | 15.5 ms       | 5 ms          |
| 读取           | 11.5 ms       | 2 ms          |
| 正常流程合计   | 5.3–6.2 s     | 0.43–0.49 s   |

独立重跑的方向一致（正常流程 5.6–8.1 s 对 0.47–1.6 s）。重跑的三轮中两个执行器各有一轮未通过：neo 一次动作超时，agent-browser 的调研原型一次没有读到 iframe 内的字段。这说明对照的结论是“单步更快”，不是“更可靠”；可靠性由下面的回归覆盖，调研原型没有的能力（脚本、上传、下载、PDF、对话框、差异、标签组）在正式实现中补齐。

真实任务的耗时主要来自模型，以上差距对应每个页面动作约 0.1–1 秒的节省，不代表任务整体提速同样的倍数。

## 验证

```bash
npm run setup:agent-browser
npm run typecheck
npm test

# 真实执行器与 Athena 自有 Chrome profile；隔离的本机页面，不调用模型
ATHENA_TEST_AGENT_BROWSER=1 npx tsx --test --test-concurrency=1 \
  tests/web-runtime.test.ts tests/web-capabilities.test.ts tests/web-lifecycle.test.ts

# 真实 Chrome 的页面桥接、捕获、共享与复杂流程
ATHENA_TEST_CHROME="/Applications/Google Chrome.app" \
  npx tsx --test --test-concurrency=1 tests/browser.test.ts tests/browser-capture-race.test.ts \
  tests/browser-viewport-continuity.test.ts tests/sharing-browser.test.ts \
  tests/element-controls.test.ts tests/complex-native.test.ts
```

未设置上述环境变量时，这些用例按环境跳过，不能算作已验证。脚本隔离（`tests/web-script.test.ts`）、二进制校验（`tests/agent-browser-binary.test.ts`）和差异计算随 `npm test` 运行。

尚未验证：远端模型自主规划的完整任务、外部网站与真实账户、多设备共享、签名公证后的安装包内下载执行器，以及 Intel Mac。2026-11-12 之前各文档中的网页性能与验收数字是在 BrowserOS neo 上取得的历史记录，没有在新执行器上逐项重测。

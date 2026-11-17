# CLI 认证配置

Athena 沿用本机 CLI 的环境变量和 Provider 配置，不要求先完成订阅登录，也不收集或显示 Token。

- Codex 的 `model_providers.<名称>.env_key` 可引用自定义环境变量；`CODEX_API_KEY`、`CODEX_ACCESS_TOKEN` 仅在对应 CLI 或 Provider 配置使用这些名称时生效。保留 `CODEX_HOME` 中用户已有的 Provider 配置。
- Claude Code、Cursor Agent、Pi 继续使用各自 CLI 支持的 API Key、Token 和 Provider 配置；Athena 不替它们转换认证协议或证明凭据有效。
- 环境变量须在启动 Athena 时可见。终端启动可先设置变量，再运行 `npm run dev`；从 Dock 打开的应用不会自动读取终端临时变量。配置文件改动后，在空闲时刷新 CLI 连接。
- 发现本机安装不产生模型请求。认证与额度由实际服务响应核验；不能用“检测到 CLI”或模型目录加载成功代替真实请求成功。

参考：[Codex 配置](https://developers.openai.com/codex/config-reference/)。独立回归测试仅使用虚构 Token，不读取或提交本机凭据。

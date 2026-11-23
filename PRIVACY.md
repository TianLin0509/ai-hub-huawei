# 数据与账号边界

发行文件只包含程序、静态资源、通用文档和测试脚本，不包含任何人的 home 目录、Hub 数据、浏览器 profile、账号、聊天记录或私人 Git 历史。上游的私人模块与私人服务（例如个人投研、学习陪伴、公司内部中转、私人网关）在导出时整体删除，不是在界面上隐藏。

## 运行时的数据在哪里

- 会话、草稿、日志、配置：`%USERPROFILE%\.ai-hub-community`（可用 `CLAUDE_HUB_DATA_DIR` 另指）。
- CLI 凭据由你自己的 Claude / Codex / Gemini / Kimi CLI 管理。账号中心只读取必要的登录状态，并对身份做脱敏显示。
- 网页账号登录使用 Hub 数据目录下的专用浏览器目录。
- API 网关 Key 用 Electron safeStorage（Windows 下绑定当前 Windows 账户）加密后存在数据目录的 `api-gateway/gateway.json`，界面不回显完整 Key；请求模型时仍需把必要凭据交给所配置的服务。
- 「自有接口」Key 同样用 Electron safeStorage（Windows 下为 DPAPI，绑定当前 Windows 账户）加密，保存在 `config.json`、`config.json.bak` 和 `cli-api-profiles/<工具>/<账号>/<修订>/connection.json` 连接快照中。旧配置和备份在加密与保存成功后清除明文字段；旧快照按读取迁移，未读取的历史快照保留原状。系统加密不可用或保存失败时，原文件保留，不降级为明文保存。
- 切换到内网共享池前的接口备份位于 `lan-pool/settings.json`，其中的自有接口 Key 同样加密，断开共享时恢复。旧明文快照迁移写回失败时保留原文件，继续恢复原会话，下次读取再迁移；新建快照必须加密保存成功，否则停止启动并提示。
- 连接快照 `connection.json` 由 Hub 读取，不需要明文交给 CLI。Codex CLI 必须读取的 `auth.json` 仍存明文 Key，位于 `cli-api-profiles/codex/<账号>/<修订>` 或 `codex-api-profile` 目录。Claude Code、DSH 通过启动进程的环境变量接收 Key；CLI 自己保存的登录态仍由各自工具管理。
- 换机、换 Windows 账户或密文损坏导致 Key 无法解密时，界面会提示在对应账号补 Key，并提供「保存并继续」。整个数据目录都不是可以公开分享的备份包，不要提交到 Git 或发给别人；请求模型时仍需把必要凭据交给所配置的服务。
- 本地历史搜索与记忆文件库按你的操作读取本机的对话与文件。调用模型时，你选中的消息和文件会发给对应的 AI 提供方。

## Hub 写入 CLI 配置的内容

为了让卡片准确显示「运行中 / 已完成」，Hub 会在 CLI 的配置里登记状态回报（hook）：

- `~/.claude/settings.json`：追加 Hub 自己的 hook 条目，已有条目原样保留；只有在你没有设置状态栏时才补一个静默状态栏（需要本机有 Node）。**不修改全局 `permissionMode`**。
- `~/.codex/hooks.json` 与 `~/.codex/config.toml`：追加 Hub 的 hook 条目，并写入与之对应的 `trusted_hash`（等于你在 Codex `/hooks` 里点了一次「信任」），只针对 Hub 自己的条目，不替你信任别的 hook；`[tui]` 里没有 `status_line` 时补一行，用于读取上下文余量。
- hook 转发脚本复制到 `~/.claude/scripts/` 与 `~/.codex/hub-scripts/`。

hook 由系统自带的 Windows PowerShell 执行：没有 `CLAUDE_HUB_SESSION_ID` 的会话（也就是你在终端里单独跑的 CLI）会立即退出，不做任何事。有这个变量时，它只把 CLI 交给 hook 的原始事件转发到本机回环地址 `127.0.0.1` 上的 Hub，不连接任何外部地址。

## 自动执行

Hub 启动的会话默认免确认：Claude / CodeAgent 会话带 `--permission-mode bypassPermissions`，Codex 会话带 Codex 的免确认参数，AI 可以直接改动工作目录里的文件并运行命令。Claude Code、CodeAgent 与 Codex 可在启动中心改成需要确认的权限模式（Hub 按工具记住上次的选择，恢复和重启沿用）；组队、群聊等后台会话始终免确认。这只作用于 Hub 启动的会话。请只在愿意交给 AI 的目录里使用，不要把 hook 端口或调试端口暴露到公网。

## 发布前检查

`scripts/audit-public.js` 检查公开文件中的账号文件、真实用户目录路径、邮箱和常见密钥格式。它是发布前的一道检查，不能证明所有未知格式的秘密都不存在。

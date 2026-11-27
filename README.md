# AI HUB-Huawei · 内测先锋版（CodeAgent）

> **⚠️ 下载与更新只在公司内源：** 最新版本仅发布于公司内源平台（OpenX，搜索 **AI Hub**（项目名 AI HUB-Huawei））。GitHub 页面不再推送新版本，仅作历史版本留档（停在 v5.6.107）。请前往公司内源下载安装，之后在应用内一键更新。

把公司内网的 **Code Agent CLI** 放进一个 Windows 桌面工作台：单独会话、多 AI 群聊、卡片视图、休眠恢复、历史检索、自动命名。这是 AI Hub 的公司版（产品名 AI HUB-Huawei，内测先锋版），当前 **v5.6.139**，同步自上游 **1.6.738**（具体提交见 `community-edition.json`）。

与公开社区版是同一套代码，区别只在默认行为面向公司内网：

- **装了 Code Agent 就默认用它**：新建会话默认选中 CodeAgent 并排第一位，新建群聊默认两名 CodeAgent 成员（GLM-5.2-WX-Auto 与 MiniMax-M2.7）。
- **新文件夹默认信任、默认免确认执行**：启动时带 `--skip-safe-check` 并预先写入信任；权限模式默认 `bypassPermissions`（免确认），可在启动中心按工具改成「自动改文件 / 每步确认 / 只讨论不改」，CodeAgent 另有「自动判断」，Codex 可选「每步确认」（只读沙箱 + 按需批准）；带 `--disable-update`，不会被升级提示挡住。
- **模型跟着本机 CodeAgent 走**：模型列表读本机 CodeAgent 配置（GLM、MiniMax、DeepSeek 等，按各人权限）；会话里点输入框下方的模型即可切换，Hub 会用新模型接着原会话重开 CodeAgent，对话记录保留。界面按回答实际用的模型显示，头像和侧栏图标也随模型变化。
- **PowerShell 终端**：启动中心里除了 CodeAgent，还能直接新建一个 PowerShell 终端会话。
- **恢复任意目录的历史会话**：启动中心 →「恢复会话」→ CodeAgent，列出所有目录的 CodeAgent 历史（CodeAgent 自带的 `/resume` 只列当前目录），点一条就在它原来的目录里接着聊。
- **不需要任何外部 API Key**：会话和群聊的自动命名用 Code Agent 自己的单次问答模式完成。
- 浅色主题下，CodeAgent 终端整体为深色，与 CLI 自身的黑底一致。
- 账号页不会自动读取本机已登录的其他 CLI 账号，需要时自己点「检查 / 登录」。

## 安装：从公司内源下载（推荐）

1. 电脑连着公司网络（公司内网或 VPN），打开公司内源平台 OpenX，搜索 **AI Hub**（项目名 AI HUB-Huawei），进入项目的版本列表，选最新版本。
2. 下载名字带「完整安装包」的条目：`AIHubHuawei-Setup-<版本>.exe` 是安装版，双击安装；`AIHubHuawei-<版本>-win-x64.zip` 是免安装版，双击安装包没反应时用它。只写版本号的条目是自动更新包，不用手动下。
3. 装好后从桌面快捷方式「AI HUB-Huawei」打开，以后在应用内一键更新（见下文），不用再回来下载。

也可以把下面这段话发给你的 CodeAgent，让它代装（先按第 1–2 步把免安装版 zip 下载到「下载」文件夹）：

> 请帮我安装 AI HUB-Huawei：「下载」文件夹里有从公司内源下载的 `AIHubHuawei-<版本>-win-x64.zip`，请解压到 `%LOCALAPPDATA%\Programs\AIHubCommunity\<版本>`，在桌面创建名为「AI HUB-Huawei」、指向其中 `AI Hub Community.exe` 的快捷方式（目标末尾加 ` --disable-gpu --disable-gpu-compositing`，避免部分电脑窗口全黑），然后打开它。不要修改其他文件；出错时把原因翻译成中文告诉我。

<details>
<summary>历史说明：GitHub 一键命令（只能装到 v5.6.107，已不再更新）</summary>

早期 README 推荐的 GitHub 一键安装命令现在只指向 GitHub 留档的最后一版 v5.6.107，**不是最新版**。新同事请不要再用它安装；万一已经用它装上了，连上公司网络后在应用内「检查更新」即可升级到内源上的最新版。

</details>

## 安装（离线包）

由同事转来的离线包里取这三个文件：`install-release.ps1`、`AIHubHuawei-5.6.139-win-x64.zip`、`SHA256SUMS.txt`，放在同一个文件夹里，在 PowerShell 中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-release.ps1 -Version v5.6.139 `
  -PackagePath .\AIHubHuawei-5.6.139-win-x64.zip -ChecksumPath .\SHA256SUMS.txt -DisableGpu
```

- 安装到 `%LOCALAPPDATA%\Programs\AIHubCommunity\v5.6.139`，**不需要管理员权限**，旧版本和用户数据都保留。
- `-DisableGpu` 是兼容渲染：部分电脑用显卡渲染时窗口会全黑。加上它之后，桌面快捷方式自带兼容参数，并在 `%USERPROFILE%\.ai-hub-community\gpu-disabled.json` 留一个标记（删掉这个文件即恢复显卡渲染）。
- 装好后从桌面快捷方式「AI HUB-Huawei」打开。窗口标题会显示版本号，报告问题时请带上这一行。

前提：命令行里能运行 `codeagent --version`，并且 `codeagent auth status --json` 显示已登录。

## 一键更新（v1.0.1 起）

装好 v1.0.1 之后，以后的版本不用再下载整包：

- 启动约 20 秒后在后台查一次新版本（之后每 6 小时一次）。同一个新版本只自动弹窗提醒一次；关掉后左下角「设置」上留一个红点，从设置菜单点开「有新版本」后红点消失。也可以随时在设置菜单里点「检查更新」。只改末位的小版本（例如 5.5.15 → 5.5.16）不弹窗：后台自动下载校验，下好后「设置」挂小点、会话栏底部一行「新版本已就绪，重启生效」，可以点「立即重启」，也可以不管——关闭 Hub 时自动换上，下次打开就是新版。自己点了「下载更新」但没重启的，关 Hub 时同样换上。更新窗里可以关掉「自动更新」。装在受保护目录（安装时选了「所有用户」）或免安装版遇到要换运行库的版本时，更新窗会说明原因并给「下载完整安装包（公司内源）」按钮；更新没成时的提示里也有这个按钮。更新后右下角列出这次的改动（设置菜单「更新日志」能看全部）。
- 更新弹窗里能看到当前版本 → 新版本、发布说明、更新包大小。下载时显示当前用的下载源、进度、速度和剩余时间。
- 更新包只从公司内源下载（不再用 GitHub、阿里云）。下完核对大小和校验值；连不上内源、内源上暂时没有这个包、校验不一致，都会写明原因和下一步（例如确认连着公司网络后重试）。需要整包时，到公司内源手动下载安装包。
- 一般只下载约 14 MB 的程序文件（整包约 100 MB）。点「立即重启」后约 5 秒完成替换并自动重新打开；替换失败会自动恢复原来的版本，并在重新打开后告诉你原因。底层运行时变化的版本会改为下载完整安装包。
- 从 v1.0.0 升级到 v1.0.1 需要装一次完整包（v1.0.0 还没有这个功能）。

## 让 Agent 代装与验收

把这段话发给你的 Code Agent：

> 请按 AI Hub 公司版 v5.6.139 的 README 用离线包安装（带 -DisableGpu），然后读 docs/COMPANY-CODE-AGENT.md 的「现场验收」，逐项验证 CodeAgent 会话：新建、卡片显示回答、休眠后恢复、Hub 关闭重开后恢复、两名 CodeAgent 成员的群聊。只发极短的测试消息，不修改项目文件，报告每项通过或不通过并附原始证据。

源码包里另有自动验收脚本 `tests/acceptance-codeagent-real.js`（14 项，用真实 Code Agent 跑），用法见脚本开头注释。

## 和同事电脑上其他工具共存

Hub 会把自己的状态回报合并进 `~/.cac/settings.json`。它只增改自己的条目（带 `session-hub-hook` 标记），不删除、不改写其他工具的条目；它的回报脚本只在 Hub 启动的会话里生效，其余会话直接退出。

## 文档

- [Code Agent 适配说明与现场验收](docs/COMPANY-CODE-AGENT.md)
- [在 Hub 中选择、添加和使用 CodeAgent 技能](docs/SKILLS.md)
- [安装、登录与排障](INSTALL.md) · [Agent 安装手册](docs/AGENT-QUICKSTART.md) · [架构与复用地图](docs/ARCHITECTURE.md) · [数据边界](PRIVACY.md)

MIT 开源。AI 服务的账号、订阅与用量由使用者自己提供。

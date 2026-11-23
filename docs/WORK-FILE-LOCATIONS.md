# Hub 工作文件位置（rsi-b6）

未设置 `work_files.root` 时，所有旧路径保持不变。设置位于「设置 → 高级 → Hub 工作文件根目录」；保存前实际创建独占写入探针并删除，检查目标卷至少剩余 256 MB。保存后重启生效，不在正在运行的任务中途换路径，不复制、删除或覆盖旧内容。256 MB 是启动门槛，不代表足够保存长时间录屏。

## 自动工作目录清单

下表 `H` 是用户主目录，`D` 是 Hub 数据目录（默认 `H/.ai-hub-community`，隔离实例用 `CLAUDE_HUB_DATA_DIR`），`A` 是助理当前数据目录（默认 `D/company-assistant`，已有助理数据目录设置仍生效），`R` 是本次新增的工作文件根目录。均按需创建，不会为了显示列表预建所有目录。

| 功能 / 用户可见文件 | 原位置 / 未配置时的位置 | 配置 R 后的新自动目录 | 创建入口 |
|---|---|---|---|
| 普通新会话默认工作区 | `H/Workspaces`；隔离实例 `D/workspaces/user` | `R/workspaces` | `core/workspace-service.js` |
| 临时会话工作区 | 默认工作区下 `_scratch/inbox-*` | `R/workspaces/_scratch/inbox-*` | 同上 |
| 无指定目录的群聊成员工作区 | 隔离实例 `D/workspaces/<群聊 ID>`；普通实例沿用主目录 | `R/group-workspaces/<群聊 ID>` | `core/data-dir.js`、`main/ipc/meeting-create-handlers.js` |
| 助理问答、简报输入、数据快照与输出 | `A/workspace`，其中 `data/` 为输入快照 | `R/assistant-workspace` | `core/company-assistant/service.js` |
| 会议录音、录屏、截图、转写与纪要 | `A/workspace/meetings/<会议 ID>` | `R/assistant-workspace/meetings/<会议 ID>` | `core/company-assistant/meeting.js` |
| PPT 整理、搜索和做页的任务文件 | `A/ppt-workspace` | `R/ppt/ppt-workspace`；也可在 PPT「素材库设置」单独指定根目录 | `core/company-assistant/service.js`、`core/company-assistant/ppt-work-dir.js` |
| 会议室助手的工作文件与运行结果 | `A/meeting-room` | `R/meeting-room` | `core/company-assistant/rooms.js` |
| 论坛整理工作区 | `D/company-forum/workspace` | `R/forum-workspace` | `core/company-forum/service.js` |
| 手机分享文件 | `AI_HUB_WORKSPACE_ROOT` 或 `C:/Work` 下 `<日期>-手机分享` | `R/phone-inbox/<日期>-手机分享` | `main/ipc/phone-handlers.js`、`core/hub-phone/channel.js` |
| 拍图助理自动工作区 | `AI_HUB_WORKSPACE_ROOT` 或 `D:/AIWork` 下 `<日期>-拍图助理` | `R/photo-assistant/<日期>-拍图助理` | `core/hub-assistant/photo-assistant.js` |
| 跨项目产物、循环报告 | `AI_HUB_ARTIFACTS_ROOT` 或 `H/AI-Artifacts` | 未单独指定环境变量时为 `R/artifacts` | `core/storage-roots.js`、`core/loop-report-file.js` |
| 桌面整理的归档批次与撤销记录 | 产物根下 `Desktop-Archive/<批次>` | `R/artifacts/Desktop-Archive/<批次>` | `core/desktop-organizer.js` |
| 「问问 Hub」的隔离工作区 | `D/help-ask/cwd` | `R/help-workspace` | `core/help-ask/engine.js` |
分析临时会话工作区：原为 `D/assistant-runtime/<任务键>`，配置后新会话使用 `R/analysis-workspaces/<任务键>`；入口为 `core/company-assistant/service.js`。

## 明确指定的位置与已有内容

用户在会话中手工选的项目目录、已有会话保存的 cwd、旧的「新建会话默认工作目录」、会话的 `AI_HUB_WORKSPACE_ROOT`、会议室已有 `home`、拍图助理请求里的 cwd 和 `AI_HUB_ARTIFACTS_ROOT` 继续优先，避免覆盖已有明确选择。新根目录只统一原来由 Hub 自动决定的位置。

已有内容留在原处，可手动移动。设置旁的下拉框列出原工作区、助理工作区、PPT、会议室、论坛、群聊、手机分享和产物根，可点击「打开原目录」。目录不存在时就地提示，不创建空目录。切换过的根写入 `work_files.history`；旧会议继续从原目录列出和读取，旧会话保留原 cwd，旧工作根继续识别，历史产物仍可访问。其他旧工作文件可通过「打开原目录」访问，不自动合并或搬迁。

## 用户可打开或看到、但属于应用数据的目录

以下目录保存会话引用、索引、账号隔离状态或运行组件，本次不混入可手动移动的工作文件根；路径仍由 Hub 数据目录或原功能设置管理。

| 类别 | 目录 |
|---|---|
| 聊天粘贴图片、会话导出索引 | `D/images`、`D/transcripts`（文件路径被已有消息引用） |
| 群聊任务约定、文件工作流与恢复控制文件 | `D/task-docs`、`D/meetings`、`D/orchestration` |
| 数字分身记忆和学习数据 | `D/avatar/<账号哈希>/agents/<分身 ID>/work` |
| 助理长期档案与本地原始数据 | `A/archive`、`A/*.json`、`A/*.jsonl`；论坛 `D/company-forum/*.json` |
| 诊断、反馈与资源回收报告 | `D/logs`、`D/diagnostics`、`D/reclaim`、`A/diag`，以及用户另存的位置 |
| 文件传输与更新中间文件 | `D/file-transfers`、更新组件自己的 `downloads/new` 等暂存目录 |
| PPT 缓存、索引、素材包和运行组件 | `A/ppt-preview-cache`、`A/ppt-runtime`、`A/ppt-index`、`A/ppt-team-materials`、`A/tools`；配置后跟随 PPT 工作目录 | `A` 下的 PPT Doctor 程序目录不迁移 |
| 会议语音模型与会议室运行组件 | `A/meeting-speech`、各组件安装目录 |
| 浏览器账号、CLI 账号配置与会话原始记录 | 原来的账号专用 profile、`H/.cac`、`H/.claude`、`H/.codex` 等；不纳入工作文件根 |
| 用户自行另存、用户项目内的交付文件 | 继续使用用户选定目录；Hub 不擅自改写 |


## 根因、兼容性与验证

根因是多个功能各自将 `workspace`、`ppt-workspace`、`meeting-room` 等拼在自己的数据目录，旧的默认会话目录设置只影响普通会话。本次增加 `core/company-assistant/ppt-work-dir.js`：PPT 单独设置优先，其次跟随 Hub 工作文件根、v5.6.79 的新建会话默认工作根，最后保持原位置。新任务与缓存写新目录，旧任务、旧索引和旧素材包留在原处并继续读取，不自动搬迁；PPT Doctor 的程序安装目录始终独立保留。

回归测试 `tests/unit-work-file-root.test.js` 覆盖默认路径逐字不变、真实功能入口接线、旧会议原地读取、旧文件内容不变、切根历史、真实写入探针、模拟无写权限和低磁盘空间。修复前先运行新增测试，普通会话未重定向与设置未保存两项失败，日志为外部交付目录 `before.log`。界面验收脚本 `tests/e2e-work-file-root-cdp.js` 使用 `tests/helpers/hub-launcher.js` 隐藏启动隔离 Hub，以鼠标键盘保存设置并重启，截图宽 1440；不调用模型、不操作生产 Hub。

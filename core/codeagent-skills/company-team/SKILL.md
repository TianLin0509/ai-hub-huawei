---
name: company-team
description: 用户说组队、开几个会话并行做、分给几个人做或当负责人时，在公司版 AI Hub 用 hub-team propose 创建显式侧栏成员；当前 CodeAgent 会话当负责人，从 accounts 选账号和模型，默认自动批准。支持一句话拆分、自动 worktree、任务派发、交付验收和接力。单人很快能做完的任务不组队。
---

# 公司版组队（CodeAgent 多会话协作）

v0.6.0 · 随 AI Hub 安装。修正调用、模型选择与批准口径，相同计划 10 分钟去重。

## 一句话起显式侧栏团队（用户点名组队时照做）

用户说「组个队 / 找几个人 / 并行做」加上一句任务描述时：

1. 用户要组队或并行拆活时，用 `hub-team propose` 创建成员，让用户在左侧栏看到、点开和追问。你自带的 `Task`、`subagent`（子任务）工具只用于你自己做事，不算用户要的侧栏团队。按独立模块定 2–4 人，用户指定人数就按指定；能安全假设的细节先做并说明，不再劝用户单干。
2. 跑一次 `status` 确认组队可用，再跑 `accounts`；未点名模型时可省略 `account / model`，有选型要求按第 2 节从账号清单选择。
   首屏即可复制运行（PowerShell）：
   ```powershell
   $hubData = $env:CLAUDE_HUB_DATA_DIR
   if ([string]::IsNullOrWhiteSpace($hubData)) { $hubData = Join-Path $env:USERPROFILE '.ai-hub-community' }
   $teamCommand = Join-Path $hubData 'team/hub-team.cmd'
   & $teamCommand status
   & $teamCommand accounts
   ```
   Git Bash/cmd 调用方式见第 0 节。
3. 写计划文件、`propose`（第 2 节）。每人的 `task` 写清边界、交付物和验收标准；任务长就先写任务书文件，`task` 里给路径。
4. 看 `propose` 的返回：`approved` 表示已自动批准、正在建成员；`pending` 才请用户点侧栏「待批准」；`duplicate` 表示相同计划已存在，先看 `status`，不要重招；混合结果的 `duplicates` 列出复用项。
5. 回复用户一小段：招了谁、各做什么、在侧栏本会话下面能看到成员行，点开就是成员会话。之后成员自己干，负责人等回执、验收、合入。

一句话：**负责人管目标、接口和验收，成员各自交付一个完整模块。** 会话之间用 Hub 的组队命令通信。所有状态都写进文件，会话压缩、换号或重启后，从进展卡和 `status` 接着做。先用好已有会话和工具，再考虑加人。

成员需要额外人手时向负责人说明，由负责人提交计划。侧栏团队是独立会话，群聊小队是在同一个群里轮流发言。

## 0. 先确认组队可用

- 个人账号中自行编写或修改的本技能，会同步到新号池账号和仍由 Hub 管理的号池副本；号池里自行修改过的内容保留。
- 命令位置：Hub 数据目录下的 `team\hub-team.cmd`。先读 `CLAUDE_HUB_DATA_DIR`；未设置或为空时使用 `%USERPROFILE%\.ai-hub-community`。成员开工任务若给出确切路径，优先使用该路径。
- 在 PowerShell 中先设置本次命令路径，再执行动作；后文每个动作都接在 `& $teamCommand` 后：
  ```powershell
  $hubData = $env:CLAUDE_HUB_DATA_DIR
  if ([string]::IsNullOrWhiteSpace($hubData)) {
    $hubData = Join-Path $env:USERPROFILE '.ai-hub-community'
  }
  $teamCommand = Join-Path $hubData 'team\hub-team.cmd'
  & $teamCommand status
  ```
- Git Bash 通过 PowerShell 调用，文件参数用环境变量传递，避开 MSYS2 对 cmd 引号的二次转义：
  ```bash
  teamData="${CLAUDE_HUB_DATA_DIR:-$USERPROFILE/.ai-hub-community}"
  export HUB_TEAM_COMMAND="$(cygpath -w "$teamData/team/hub-team.cmd")"
  powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[Text.Encoding]::UTF8; & $env:HUB_TEAM_COMMAND status'
  export HUB_TEAM_PLAN_FILE="$(cygpath -w "$PWD/调研 计划.json")"
  powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[Text.Encoding]::UTF8; & $env:HUB_TEAM_COMMAND propose --plan-file $env:HUB_TEAM_PLAN_FILE'
  export HUB_TEAM_MESSAGE_FILE="$(cygpath -w "$PWD/成员 消息.md")"
  powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[Text.Encoding]::UTF8; & $env:HUB_TEAM_COMMAND send --to lead --message-file $env:HUB_TEAM_MESSAGE_FILE'
  ```
  cmd 原生用法（不要粘贴到 PowerShell）：
  ```cmd
  set "teamData=%CLAUDE_HUB_DATA_DIR%"
  if not defined teamData set "teamData=%USERPROFILE%\.ai-hub-community"
  "%teamData%\team\hub-team.cmd" propose --plan-file "计划.json"
  ```
- **`.cmd` 批处理会截断换行后的正文；多行内容一律先写 UTF-8 文件，消息用 `--message-file`，计划用 `--plan-file`。** 不混用 PowerShell 的 `$env:`、Bash 的 `$VAR` 和 cmd 的 `%VAR%`。
- 可用动作只有：`status`、`accounts`、`propose`、`send`、`read`、`allow`、`restart`、`dismiss`。
- 身份由当前会话的环境变量自动提供。不要让用户复制任何令牌，不在消息、日志、文件里打印令牌，也不借用别的会话的身份。
- 先跑一次 `status`，看到团队信息或「你还不在任何团队里」才算可用；无输出、超时、报错都不算。不可用就告诉用户，改为单会话继续。只改说明、讨论方案或做只读检查时，不必招人。
- 缺身份时切到 Hub 内 CodeAgent PTY 会话；CodeAgent-Lite serve、DSH、外部终端尚未接通此入口。旧会话缺身份就重新打开该会话，不必重启整个 Hub，不复制其他会话令牌。

## 1. 值不值得组队

- 值得：任务能拆成 2 个以上边界清楚的模块，固定输入和接口后各自推进，且单会话预计要做几个小时以上。经验上，跨夜、超过 6 小时、有 3 个以上模块时收益最明显。
- 不值得：模块强耦合、每一步都要等上一步，或单会话很快能做完。短时的独立审查，交给已有成员或另一个账号的会话即可，不必为凑人数加人。
- 判断标准：拆完后，每个成员能否只靠「任务书 + 接口约定」独立推进。不能就先把接口定清楚，或者不拆。依赖别的模块的输出时，用固定样本、参考输入或模拟依赖把它隔开。

## 2. 招人（默认自动批准，侧栏可见）

1. **看号池**：`accounts`。只读本机号池和已缓存的模型权限，不登录、不联网、不改账号设置。返回：
   - `recommendedId`：推荐账号；
   - `rows`：每个号一行，字段有 `id`、`label`、`state`、`usable`、`activeSessions`、`models`、`modelsAuthoritative`、`defaultModel`，不可用时附原因。

   选号只看 `usable=true`，同一个号上的会话越少越好。号池没有额度百分比，不要估算余量。同一账号上多开会话共享该账号的限额，只有分到不同账号才可能分摊。

   `rows` 里 `id` 为 `personal` 的一行是个人账号。号池没有可用号时，`recommendedId` 就是它，只有一个号也能直接组队。选了它要告诉用户：这些成员和你共用同一个号的额度与并发，人多会变慢；想更快可以在号池再登一个别的号。个人账号上同时最多 3 位成员在干活，其余成员的消息自动排队，不用重新提交。
2. **写计划文件**（UTF-8 JSON），再 `propose --plan-file 计划.json`：
   ```json
   {"goal":"这批人一起要完成什么",
    "members":[{"role":"分工（边界）","task":"开工任务，长的写任务书路径","title":"侧栏显示名","cwd":"工作目录","account":"号池账号 id","model":"模型"}]}
   ```
   例如 `accounts` 当前返回同一可用账号的 `models` 含 `deepseek-v4-flash-0731` 和 `GLM-5.2-WX-Auto` 时，可直接写：
   ```json
   {"goal":"调研项目的现状与可选方案","members":[
     {"role":"资料调研","task":"阅读当前项目文档，写出现状与风险清单；选择 DeepSeek 做归纳和推理","title":"调研-DeepSeek","model":"deepseek-v4-flash-0731"},
     {"role":"方案对比","task":"独立比较两种实现方案，给出代价与推荐；选择 GLM 做异构复核","title":"对比-GLM","model":"GLM-5.2-WX-Auto"}]}
   ```
   样例的模型名只在本次 `accounts.models` 确实包含时照用；否则替换为清单中的实际名称。`cwd` 不写就用当前负责人目录，`account` 不写由 Hub 推荐，不编路径或账号。
   - 支持字段：顶层 `goal / members`，成员 `role / task / title / cwd / account / model / fresh / worktree`；每人必须写 `role / task`，`cwd` 要已存在。`worktree:false` 不自动建副本，`fresh:true` 禁止叫回老成员。**不要写 `effort / fastMode / speed / codexSpeedTier / kind`；`race / access` 尚未支持。**
   - `account` 可省略，省略时用 `recommendedId`。号池和个人账号都不可用时才会报错。
   - `model` 可省略，沿用该号 `defaultModel`；指定时从该号 `models` 选。清单外模型会进入共享模型校验/确认流程，不保证可用，不能凭记忆编型号。
   - DeepSeek、GLM 都是 CodeAgent 的 `model`，不是 `kind`。复杂推理、代码定位可优先选清单中适合的 DeepSeek；常规实现选合适的 GLM 等，独立审查尽量与作者异构。用户点名的模型优先，选型理由写在 `task`，不新增字段。
   - 模型下线/无权限：先看返回的降级说明与 `status.error`，再从 `accounts.models` 选可用模型。服务仅对明确模型不可用尝试账号默认模型并告知负责人；不要把登录/网络失败当成模型问题。无可用号时在左侧栏「账号」恢复登录或启用账号，先推进单会话可做部分，不反复重发。
   - 在每人的 `task` 里写一句选这个模型的理由（按第 4 节），不新增计划字段，供用户批准时判断。
3. **批准**。公司版默认开着「负责人组队自动批准」：账号和模型按号池校验通过，`propose` 直接返回 `status: approved` 并开始建成员，不用等用户。用户在设置里关掉后，提交的计划处于「待批准」（返回 `status: pending`），这时回复用户：「请在侧栏本会话那一行点『待批准』，可逐人修改账号和模型。」
   - 待批准的计划只有用户能批准，你不能代点，命令行也没有批准动作。
   - 批准时 Hub 会按号池当前状态重新校验账号和模型。不通过时，整份计划留在待批准、一个成员都不建，用户改好后再批。
   - 批准或驳回的结果会作为一条消息发给你。驳回就按意见改计划，重新提交。
4. **建成后核对**：某个成员没建成时，已建好的成员照常保留，通知里会写明原因。只为缺的那几位另交一份新计划，不要重复创建已建好的成员。计划里的账号和模型不代表已生效，成员开工后请它在第一条汇报里报出实际使用的模型。
   - 同一负责人 10 分钟内逐项去重相同请求；待批准、创建中和在队项不重招，失败/离队项可重提。真正的新任务写清不同任务内容；`fresh:true` 仍参与重复计划比较。
5. 成员人数不设常规上限（只有每位负责人 100 名的防失控安全阀），需要多少招多少。成员不能招人，要加人请向负责人提。

## 3. 分配任务、送达与收尾

- `send --to m1 --message-file 任务.md`：空闲时送达；改变正在做的事加 `--interrupt` 并写明哪条作废。
- `send --to lead --message "结论 + 路径"`：默认留言，攒 8 条或最老 20 分钟、负责人空闲时送达。阻塞、失败、拍板、判断变化加 `--wake`；交可验收结果加 `--deliver`，负责人处理后成员离队休眠，返工用 `send` 叫回。
- 回执写结果、验收达到与否、证据路径、未完成与风险，尽量 300 字。超过约 1800 字正文会落盘，用 `read --id 编号` 读完整原文后再执行。仅本队负责人和消息参与者能读。普通告知不逐条确认。
- 成员默认只联系负责人；负责人用 `allow --a m1 --b m2 --reason "原因"` 开放直连，`--off` 收回。抄送为摘要，涉及接口、取消、阻塞用 `read` 核原文。
- `status` 看 `error / worktree / worktreeError`、`runtime.lastOutputMinAgo`、`undelivered` 与计划状态；运行中但很久无输出不代表有进展。压缩、重启和分配任务前先查。
- 明确未送达时 Hub 按 1、3、10 分钟退避，必要时自动重启成员一次（30 分钟内最多一次）。输入框残留需确认时不自动重启；`unconfirmed` 可能已送达，先核会话和产物，避免重复执行。
- 确认卡住或离线后 `restart --member m1`；不再需要则 `dismiss --member m1`，会话保留。仅负责人可用，不靠重启整个 Hub 恢复成员。

## 4. 分工与验收

- 按模块拆，每人负责完整输入到输出；接口先定，共用文件指定唯一作者，接口变更与跨成员优先级由负责人裁决。负责人管目标、基线、验收与集成，成员在自己副本内自主实现和自测。
- 模型按第 2 节选择；复杂算法、架构、并发和数据正确性优先异构独立审查。审查先看原始需求、代码与证据，再看作者结论，有分歧用实验裁决，不让作者自审。
- 界面由能胜任的强模型定稿，交给其他模型实现时附颜色/字号/间距等设计令牌与逐页样稿；在 1440 和 1280 宽度核真实截图，功能通过不能代替观感验收。
- 卡点能在权限内解决就继续；需要别人时一次讲清原因、需要谁做什么、建议。里程碑、阻塞、跨模块发现及待裁决事项报告负责人。

## 5. 开工材料（负责人做）

- 在带日期任务目录写总纲、各成员任务书、接口约定和进展卡；任务书给明确路径。
- 总纲：目标与验收、当前优先级、基线 SHA、模块所有权、接口、阶段与已拍板事项；支线标后台。
- 任务书自包含：目标、基线、只改哪些文件、协作者边界、禁止范围、验证命令与交回格式。
- 用文件编辑工具或 PowerShell 单引号 here-string 写 UTF-8，读回核路径和反引号；只读任务明确只读，权限不足报告原因。

## 6. 隔离开发与合入

- 每个成员一个 worktree/分支，测试加载自己的代码；不碰别人在途改动。
- `cwd` 是仓库主目录时 Hub 自动建 worktree，按 `.agents/project.json` 的 `trunk / worktreeRoot`，默认当前提交及仓库同级目录。开工消息与 `status.worktree` 给目录、分支、基线；已有 worktree 直接用，不想自动建用 `worktree:false`。
- 建失败给 `worktreeError`，改代码前按项目规则自己建，不回主目录改。`node_modules` 若为 junction，禁止安装/裁剪依赖及递归删除。Hub 不自动清理；核实链接后仅摘链接用 `cmd /c rmdir "<目录>\node_modules"`，再按项目规则清理 worktree，避免递归删除穿透链接。
- 修行为问题附撤掉修复就失败的回归。共用文件小改单独提交，冲突交负责人。生成文件重新生成。
- 合入请求给分支、完整 SHA、验证命令和结果、证据；负责人亲自核 diff 再集成，集成后跑完整验证。长实验固定旧基线；推送、发布等对外动作按用户授权执行。

## 7. 进展卡与接力

- 各自在任务目录维护带日期进展卡，只由本人写；顶部「给用户看」写结果、影响、待拍板项。当前状态只留一处：基线 SHA、在途工作、等待项、证据、下一步和更新时间，流水另写日志。
- 里程碑、阻塞、交付、换号前更新；其他成员发现问题发消息请本人改。待拍板项放第一行，不用忙碌程度或消息数量代表收益。
- 压缩、重启、换号后先读卡、跑 `status`，核原进程与产物再重做；PID 可能复用，用启动/退出记录判断。消息成功、成员自报完成均不等于验收通过；模拟 CLI 验收要说明真实模型未测。

## 8. 底线与共享资源

- 子进程隐藏窗口，浏览器无头；验证用隔离 Hub，只按自己启动的 PID 清理，不关闭/重启用户的生产 Hub。
- 多核长测试、构建按项目算力调度；共用设备、远端目录、桌面程序先明确独占者，只关自己开的文档。
- PowerPoint 是单实例，脚本新建 PowerPoint.Application 拿到的往往就是用户开着的那个，退出它会关掉用户全部文稿（2026-11-24 真实发生过）。先记下已有的 PowerPoint 进程号；先遍历 $app.Presentations 按 FullName 找同一路径的文件，用户已开着就直接用它，不再打开也不关闭；找不到才用位置参数 $app.Presentations.Open(路径, -1, 0, 0) 在后台打开（PowerShell 里不能写命名参数），并在 finally 里只关自己打开的那一份；只有 PowerPoint 是本次新启动的进程、且关完后已没有任何演示文稿时才退出它。不按进程名结束 PowerPoint，不逐个关闭全部演示文稿，不对用户已开着的 PowerPoint 调用退出；文件被占用时换新文件名另存。
- 成员不自行推送/合入主干、重启/批量杀生产 Hub、删除任务目录以外文件、改生产数据配置、读取或使用按量 API Key；先 `send --to lead --wake` 交负责人判断，被拦不换通道绕过。
- 只读当前依靠任务书约定，本版没有后端强制守卫；权限不足报告原因，不扩大权限。资料留在本机；对外发送、删除覆盖、发布及花钱按用户授权执行。

## 9. 踩过的坑（防复发）

1. 建议「不取某块数据」或「跳过某个输入」前，先确认它不是后续步骤必需的输入；否则后面的环节会静默断掉一整夜。
2. 工具参数可能被残留的环境变量或默认值静默截短：验收核「最后一步的编号」「产物条数」这类硬指标，不只看返回码。
3. 内存紧张时宿主可能回收后台外壳脚本，子进程却还活着：重任务先按进程号查存活，再决定是否重跑。
4. 开工回执内容具体就直接分配任务，不必多一轮确认。

# CodeAgent 历史分支实验

仅 CodeAgent 单聊主卡片提供入口，默认开启。要关闭，在 Hub 数据目录的 `config.json` 中设置
`"experiments": { "codeagentPrefixBranch": false }`，修改后重启 Hub 窗口生效。
只有明确的布尔值 false 才关闭；缺省或其他任何值均开启，没有设置界面或环境变量覆盖。
关闭后卡片操作和普通分支工具布局恢复主线行为。保存其他设置保留整个 experiments 对象。
只能手改上述嵌套配置键；IPC 返回的扁平 codeagentPrefixBranch 仅用于读取，不是设置表单写入字段。

无论实验开启或关闭，打开休眠 CodeAgent 单聊都先检查 session:open-status，再通过原来的 resume 路径自动启动 CLI。
CLI 跑在常驻 PowerShell 里，CLI 自己退出后外壳仍在，会话不转休眠；PTY 外壳也退出（如控制台被关闭）时才保留卡片并转为休眠，此时“从此处分支”仍从完整原生记录读取，不唤醒源会话。
显式休眠会清空当前卡片；占用或恢复失败的占位页隐藏历史卡片，不提供该入口。
历史页先在 staging 容器渲染，再挂入主界面；挂入后补齐每轮最终正文卡的入口，加载更早页也一样。
配置晚于卡片到达时主动刷新入口，不要求先发一条消息。切点、安全检查和完整记录定位保持不变。
休眠入口先显示为禁用并说明“正在确认会话占用和记录状态”。Main 从自己的持久会话记录构造只读视图，
确认本 Hub 没有该会话的运行/启动条目、open owners 无占用、原生 JSONL 身份路径有效且稳定可读后才允许点击。
检查同时覆盖 Hub 会话 ID 和账号目录内的原生会话身份，其他 Hub 用不同会话 ID 打开同一记录也会拒绝。
占用、状态未知、记录不可读或不稳定都保留入口并显示禁用原因；重新打开历史会刷新状态，点击创建时再次校验。
实际创建期间短暂保留源会话的 open owners 键，结束后释放；不修改持久记录中的源会话状态。
末轮与中间轮次使用同一复制、校验和 --resume 启动路径：末轮保留完整记录，写入新 UUID 文件，
同样携带 codeagentPrefixFork 元数据；不再委托普通 fork-session，不恢复源会话。
普通“工具 → 分支”的外部 IPC、原生 --fork-session 及继承历史界面保持不变。
“从此处分支”的标题为 `分支N: <父会话当前标题>`，不剥离父标题已有的分支前缀；
N 按直接父会话从运行与持久化的兄弟分支共同计算，重启后的标题修复也保留嵌套前缀。
实验关闭后隐藏历史分支入口，Main 拒绝实验 IPC；休眠自动恢复和普通分支行为不受开关影响。
休眠分支拒绝后的“普通分支”退路经独立的实验 IPC 显式请求完整分支，复用同样的身份、占用和稳定读取检查；
它不要求历史切点合法，但不会把失败的历史分支请求自动改成完整复制，也不会启动源会话。

点击每轮最后一张 AI 正文回复，renderer 只提交会话 ID 和回复 ID。
用户记录 ID 接受标准 UUID，或小写 `msg_` 前缀加至少一个 ASCII 字母、数字、下划线、连字符，
总长度最多 128 字符（含前缀），不 trim、不改大小写；路径分隔符、空白、控制字符等均不接受。
公司电脑反馈的 `msg_` 加 48 位十六进制记录 ID 属于允许范围。renderer、Main 与切点解析共用此规则。
会话 ID 是另一种身份：源会话、新会话及 JSONL 文件名仍要求标准 UUID，不能用 msg_ 记录 ID 代替。
Main 读取完整、稳定的原生 JSONL，用现有 claudeDiskRecords/claudeTranscriptTurns
投影核实回复的 logicalTurnId，并回到原始行定位；前端分页、传入的切点或“最后一轮”标记不作为依据。
历史截断保留所选回复和之前所有记录，在其后第一条主链 user 行之前切开；含 tool_result 的 user 行不算切点。
`isSidechain === true` 的行不参与切点选择（包括 user 和排队 attachment），也不因其缺少 UUID 误报切点歧义。
本地命令、排队消息、合成消息和空正文 user 行都算切点，一律不带入分支。
排队 attachment 也提前作为切点，避免把尚未形成 user 回显的排队输入带入前缀。
切点缺少合法记录 ID 或 ID 不唯一时拒绝，绝不静默变成全量复制；检查引用与工具结果配对。
工具调用 ID/结果的 tool_use_id 按原始字符串配对，parentUuid、压缩引用和 prefixUserUuids 也按记录 ID 原值匹配，
这些字段不要求标准 UUID，复制时不重写，只有 sessionId/session_id 改为新会话 UUID。
若合并/续接卡跨过上述用户边界，逻辑卡 ID 能匹配但无法表达唯一切点，报 ambiguous-reply 并提供退路，
避免既带入隐藏输入又漏掉卡中已显示的后续回答。普通同轮多段回复和 tool_result 不受此限制。
正文所有权在分页前由投影决定，较早正文即使单独出现在一页也不出现入口。
只有所选回复后确实没有主链 user/排队 attachment，才复制完整记录；切点为 null 仍须用 replyId
从完整原生记录证明它确实是末轮，不能通过空切点绕过定位。末轮同样执行目录、旁链、引用、工具配对和稳定性检查。

带 codeagentPrefixFork 元数据的分支只读 Main 绑定的自身 JSONL；不读取或合并父会话历史，
不添加“分支前”标记。原有轮次与新发送的轮次都使用自身记录 ID，符合条件的最终正文卡都可再次分支。
创建、首次发送和重启读取共用同一套记录和卡片 ID，不再从继承卡切换到另一套原生卡。
已有带此元数据的分支也直接按这个规则显示；旧版本末轮走普通 fork 而没有该元数据的会话不会自动迁移，
因为无法可靠地区分它与用户从“工具 → 分支”创建的普通分支。

Hub 主进程在同一账号的 `configDir/projects/<工作目录编码>/<新 UUID>.jsonl`
独占创建并刷盘，随后用 `--resume 新 UUID` 启动子会话；不改源记录，不发送新 prompt。
前缀分支重启时使用 codeagentPrefixFork.configDir 中创建时记录的账号目录，即使号池绑定或全局配置随后改变也不改查找来源。
该目录覆盖只在前缀分支自己的代码段里；其他会话（包括普通号池分支）恢复 origin/main 的
resolveCodeAgentConfig(env).configDir 查找逻辑，不使用会话 codeagentConfigDir 或号池推导目录。
新文件写好后，种子读取或 createSession 失败会删除新文件；删除失败时诊断记录新 UUID 和 retained 状态，
界面提示不要恢复该记录。创建会话成功后文件归新会话所有，后续界面切换失败不删除其记录。
“更多 → 从此处分支”的悬浮提示：文件不会回退，跨会话记忆共享。
入口只放在该轮最后正文卡的“更多”菜单中，不作为卡片操作栏或正文底部的独立按钮。
同一张卡合并多段正文时，该卡的“更多”菜单仅有一个入口。
只显示最终正文 owner 的入口，加载更早页不会把入口移到早期正文卡。
开关关闭时不生成该选项，关闭后刷新已渲染的卡片也移除该选项；其余菜单标记和顺序与 origin/main 一致。
点击选项后收起菜单；会话状态不能确认时选项仍在菜单中，禁用并说明原因。
失败原因与普通分支/新开会话按钮在卡片内容中单独成行，不参与正文复制；
普通分支保留当前全部对话，不声称等价于所选历史切点。

## 同名目录：已核实的范围与保守处理

2026-11-05 用户提供公司电脑探测结果：会话同名目录包含
`model-io/model-io-0.jsonl` 和 `observability/obs.jsonl`；短会话实验只复制 JSONL，
已能通过 `--resume` 恢复并继续写入。这是公司电脑的短会话验证，非本机重新实测；
不能外推到工具调用长会话，后者仍未验证。

2026-11-06 用户补充真实诊断：同名目录存在 subagents，主记录 hasSidechain=false，工具配对完整。
据此历史截断放行不存在、空目录及仅含 model-io、observability、subagents 的结构，不复制附属目录，
不修改源目录；三个目录名均不区分大小写。model-io、observability 内允许任意普通文件；
subagents 内允许普通文件和嵌套子目录，只检查名称和类型，不跟随链接。
只枚举目录和检查条目类型，不打开、不读取、不复制其中的文件，也不预建新会话同名目录。
其他顶层条目、model-io/observability 内的子目录、任何层级的符号链接/junction、同名普通文件统一报 sidecar-unknown-content；
无法枚举或检查条目报 sidecar-unreadable。诊断记真实条目名，不用文件名猜子任务。
旁链拒绝只检查要保留的 JSONL 前缀中是否存在 `isSidechain === true` 的行。
agentId/agent_id、origin.kind、Task/Agent 工具名只作布尔诊断，不参与拒绝，不输出这些字段的原始值。
主链上带 agentId 的 tool_result 可以保留；工具调用和结果仍须通过 validatePrefix 的完整配对检查。
切点在 Task/Agent 调用前或完整配对之后均允许；不复制子 agent 明细，分支依赖主记录里的工具结果。
2026-11-06 用户公司电脑已验证 ba37a4e：切点在子 agent 之后可恢复、说出结果并继续发消息。
此结论来自用户真机反馈，不是本机重测；不复制 subagents 的决定保持不变。
切点之后的旁链不会阻止历史分支；保留范围内存在明确旁链时拒绝并提供退路。
末轮同样只复制 JSONL，并遵守上述目录规则；普通工具分支仍由 CLI 自己处理附属状态。

## 诊断

`<Hub 数据目录>/diagnostics/codeagent-prefix-fork.jsonl` 包含原因代码、源记录路径、
新 UUID、preparedFileState（removed/retained/session-owned 等）、保留/删除行数、源记录行数、
类型计数、子任务/排队/压缩标志和切点行类型 cutLineType（user/local-command/queued-message/synthetic-user）。
hasSubtasks 和 prefixHasSubtasks 只表示整份记录/前缀中的诊断线索，不作为拒绝依据；
prefixHasSidechain 才是前缀旁链拒绝判断。hasSidechain、hasAgentId（两种拼法）、hasOriginKind、
hasTaskNotification、hasTaskToolUse（Task/Agent）分别记录相关结构是否出现，不输出原始值。
prefixHasTaskToolUse 单独表示要保留的前缀是否出现 Task/Agent 调用，目录拒绝时也记录。
类型只输出固定白名单，未知类型归为 other；不写正文、工具参数、token 或账号字段。
sidecar 字段记录目录路径、根条目及三类已知目录内的相对条目名、检查是否完整、
hasSubagents（是否出现该目录名）以及 `copied: false`。允许和拒绝均记录；未知目录只记目录名，不遍历其内容。
实验关闭、会话忙、种类不支持等早期拒绝只记原因与 readSkipped，不读记录、不扫描目录；
session:prefix-fork-client-failed 也受开关、会话种类和忙碌状态校验。主读取和诊断降级读取均限制为 16 MiB，
超过时拒绝并提供普通分支/新会话，不截尾冒充完整记录。未读取的统计用 null 表示未知。
不完整 JSON 在大小上限内统计可解析行并报告 invalidLines，
metadataComplete=false。文件不可读时用 null 表示未知，不能解释为“没有子任务”。
传输或界面切换失败会尽力请求主进程补记；若主进程不可达，界面提示先检查是否已建会话，
无法承诺此时诊断已经落盘。

## 验证与证据边界

2026-11-05 本机只读统计 12 份最大的真实 Claude 长记录：每份 528571–8219357 字节，
合计 6648 行（922 行 tool_result）；parent_tool_use_id 出现 0 行，sidechain 出现 0 行。
统计未输出聊天正文；这不是 CodeAgent 长会话实验，也无法证明 parent_tool_use_id 的所有语义。
因此不再单凭该字段或正文包含任务标签拒绝。后续审查发现主链 tool_result 可带 agentId；
按用户最新决定，旁链拒绝进一步收敛为 `isSidechain === true`，工具结果仍必须与调用配对。

## 限制与待办（本轮不改实现）

- 合并卡首尾正文之间出现合成 user 行时，仍会报 ambiguous-reply；尚未在真实 CodeAgent 长记录上统计此情况的频率。
- replyId 路径按原始行和唯一记录 ID 复核切点，不使用旧 locateCut 的 promptId 歧义检查；这是现有行为，待真实记录进一步验证。
- 16 MiB 是历史分支主读取与诊断读取的硬上限，超出的长会话只能选择普通分支或新开会话。
- 同名目录仍逐项 lstat 检查允许的目录结构并排除链接；使用 readdirSync 的 withFileTypes 减少系统调用留作性能待办。
- 用户已真机验证 21ef320 的中间/末轮分支、再次分支、重启和无重复显示，并验证 ba37a4e 在子 agent 之后恢复和继续对话；本次移动菜单的真实 CodeAgent 界面仍待验收。

## 历次验证记录

- `npm.cmd test`：包含真实 IPC 注册、合成记录落盘、首/中/末轮、拒绝、配置保留、恢复与源文件不变测试。
- `node scripts/audit-public.js`；修改的 JS 均执行 `node --check`。
- `node tests/e2e-community-cdp.js`：临时 home/data 与独立 Electron，成员版路径验证启动、缺 CLI 提示和账号页；不连接提供方。
- `node tests/e2e-prefix-branch-cdp.js`：隔离 Electron 中用鼠标操作实际卡片渲染和分支组件；
  对话和创建结果是合成数据，显式关闭另调用真实 Main IPC 校验。验证入口、预先提示、拒绝退路、成功选中和传输失败。
  此测试没有启动真实 CLI，不能代替 CodeAgent 端到端验收。

2026-11-05 初版结果：`npm.cmd test` 911 通过、0 失败；public audit、改动 JS 语法检查、
两项隔离 GUI 均通过。`make-public.js --ref WORKTREE` 的临时导出也通过（0 泄露、
0 未解析引用、0 语法错误；2 条既有升级链接警告）。未改 community-edition.json 或 ci.yml，未推送。

初版首次专项测试暴露了异步测试迁移、配置函数接线和 PowerShell 管道 UTF-8 问题，均修正后重跑。
初次基础 GUI 报 spawn failed（独立依赖没有 Electron 二进制）；使用本机 Node 24、仅当次代理运行
`node node_modules/electron/install.js` 补齐后通过。专项 GUI 初次在 document.body 就绪前运行失败，
增加页面就绪等待后通过。结果保存在 `artifacts/community-gui/` 和 `artifacts/prefix-branch-gui/`。

2026-11-05 同名目录修订结果：专项 20 项、`npm.cmd test` 全量 915 项通过，0 失败；
`node scripts/audit-public.js`、改动 JS 的 `node --check`、`node tests/e2e-community-cdp.js`
及 `node tests/e2e-prefix-branch-cdp.js` 均通过。新增测试覆盖已知日志放行、未知/子任务条目拒绝、
不可读/链接拒绝、条目名诊断、未复制以及源 JSONL/目录/日志的哈希与修改时间不变。
GUI 用鼠标验证未知、不可读、子任务三类拒绝的两条退路；仍使用合成 IPC 结果。
本机未运行真实 CodeAgent；短会话可恢复依据来自本次用户反馈，工具调用长会话仍未验证。

2026-11-05 审查修订结果：fetch 后本分支落后 origin/main 2 个提交（未合并主线）。
`npm.cmd test` 925 项通过、0 失败；专项 65 项通过；`node scripts/audit-public.js` 通过，
改动 JS 的 `node --check`、`git diff --check` 均通过。
`node tests/e2e-community-cdp.js` 和 `node tests/e2e-prefix-branch-cdp.js` 均通过；
后者用鼠标验证不可读目录、前缀子任务、缺失切点 UUID、清理失败等原因及两条退路，
并核对显式关闭、正文入口、点击前提示和成功切换。已打开截图检查；数据与启动结果仍为合成。
新增真实投影链路测试验证 renderer logicalTurnId 能匹配 Main 卡片；合并卡跨用户边界则明确拒绝，
同轮多段正文与 tool_result 可正确分支，分页中的较早正文不出现入口。
初轮专项曾因旧目录白名单断言、改用有界读取后的 mock 和续接卡选择字段不匹配而失败，
更新这些测试后重跑通过；不是直接跳过失败项。日志位于 `artifacts/prefix-turn6-*.log`。
未验证真实 CodeAgent 恢复与工具调用长会话；未推送、未修改发行配置或 CI。

2026-11-05 旁链条件修订：fetch 后落后 origin/main 108 个提交，按本轮范围不合并主线。
`npm.cmd test` 927 项通过、0 失败；专项 67 项通过；`node scripts/audit-public.js`、
改动 JS 的 `node --check`、`git diff --check`、`node tests/e2e-community-cdp.js` 和
`node tests/e2e-prefix-branch-cdp.js` 均通过。GUI 中的对话与创建结果为合成数据，未启动真实 CodeAgent。
新增回归按审查记录的结构合成主链 agentId/agent_id 工具结果，覆盖 WebFetch、Task、Agent 的完整配对放行、
不完整配对拒绝、诊断不含原始 agentId、源文件不变；另覆盖旁链 user/排队附件不作切点、
真正主链切点缺 UUID 时拒绝、保留前缀含明确旁链时拒绝。
其他非阻塞意见仅记入上述限制与待办。日志位于 `artifacts/prefix-turn8-*.log`。

2026-11-05 msg_ 兼容修订：公司电脑确认旧入口把用户记录 ID 当标准 UUID 校验，导致按钮不显示；
同样的限制也存在于切点解析。现由纯函数模块统一 renderer/Main/core 的记录 ID 规则，并独立保留会话 UUID 校验。
已检查记录枚举、手动 locateCut、引用与工具配对、继承标记和恢复路径：它们按记录原值比较，
不需要把 msg_ 改成 UUID；恢复路径校验的是 sessionId 和文件身份，仍使用 UUID。
`npm.cmd test` 930 项通过、0 失败；专项 70 项通过；`node scripts/audit-public.js`、改动 JS 的
`node --check`、`git diff --check`、两项隔离 GUI 均通过。GUI 用 msg_ 加 48 位十六进制的合成 ID，
确认末张正文入口、点击 payload、拒绝退路、成功切换；已打开截图检查。
合成落盘测试覆盖首/中/末轮、源文件内容与 mtime 不变、引用保持、工具配对、继承标记和恢复，
并拒绝非法字符、超长和重复记录 ID，以及用 msg_ 冒充新会话 UUID。
`make-public.js --ref WORKTREE` 的临时导出通过（0 泄露、0 未解析引用、0 语法错误，2 条既有链接警告）；
新增纯函数模块随历史分支从公开版排除。本轮 fetch 后仍落后 origin/main 108 个提交，未合并主线。
日志在 `artifacts/prefix-turn9-*.log`；本机未运行真实 CodeAgent，需公司电脑复验按钮及真实恢复。

2026-11-06 历史入口与休眠分支修订：用户反馈公司电脑上新会话分支已通过工具调用、重启保持、
原文件和原会话不受影响验证；本轮修复针对旧会话重启后入口缺失，不能把该反馈当作本轮休眠修复的实测。
`npm.cmd test` 934 项通过，`node scripts/audit-public.js` 与原有两项隔离 GUI 通过。
新增 `node tests/e2e-prefix-dormant-cdp.js` 使用 msg_ 用户 ID 的合成原生 JSONL，由真实历史解析生成
source=claude-transcript 卡片，覆盖两次 Hub 启动、加载更早页、休眠入口可点、另一进程占用与未知状态禁用。
测试核对源会话没有进入运行列表、磁盘状态仍为 dormant，源 JSONL 内容和 mtime 不变。
另用真实 open owners 数据库覆盖不同 Hub 会话 ID 占用同一原生身份时的入口禁用与创建拒绝。
单元回归通过真实普通分支处理函数确认末轮只创建子会话，持久源信息不变；启动器为模拟实现。
GUI 用鼠标验证休眠拒绝后的显式普通分支退路；三项 GUI 均通过，已打开历史页截图检查入口。
改动 JS 的 node --check、git diff --check、临时公开版导出通过（0 泄露、0 未解析引用、0 语法错误；
2 条既有链接警告）。最新 fetch 后落后 origin/main 176 个提交；日志在 artifacts/prefix-turn11-*.log。
真实 CodeAgent 的本轮旧会话与休眠分支尚未验证；没有处理重复显示或再次分支，没有合并 origin/main。

2026-11-06 自有历史与再次分支修订：公司电脑确认 cb8c939 中间切点正确，同时发现复制历史被标为
“分支前”、末轮普通 fork 首次发送后出现两套历史。前者来自 markPrefixTurns 的主动标记，
后者从尚未落盘时的父历史继承切换到原生记录。现移除前缀分支的继承标记，末轮也先复制自有 JSONL，
再通过与中间轮次相同的目录/引用/配对/稳定性校验及 --resume 启动；普通工具分支路径未改。
先运行新断言得到 4 个预期失败，再修实现；更新末轮旁链旧期望后专项 77 项通过。
`npm.cmd test` 937 项、`node scripts/audit-public.js`、改动 JS 的 `node --check`、`git diff --check`
及 4 项 GUI（community、prefix-branch、prefix-dormant、prefix-lifecycle）均通过。
新增 `node tests/e2e-prefix-lifecycle-cdp.js` 复用本地 CodeAgent 协议夹具，通过实际鼠标、输入框、
Main 创建、PTY 提交与 hook 回填验证：中间分支/末轮分支创建和发送后历史各显示一次，
旧轮次可以再次分支且使用当前分支记录；完整退出重启后历史数量、唯一卡片 ID 和按钮正确。
种子使用 msg_ 用户 ID，历史经真实解析产出 source=claude-transcript；源 JSONL 内容和 mtime 未改变。
普通工具分支另有真实 IPC/解析回归，保留 --fork-session、继承卡及“分支前”行为。
GUI 初次因 CDP 字符串换行转义、夹具交互模式未开启/探测不退出，以及测试点击标记未清理失败，
修正测试配置与目标定位后全部通过；未用模拟 IPC 替代生命周期测试，已打开重启截图检查。
临时公开版导出通过（0 泄露、0 未解析引用、0 语法错误；2 条既有链接警告）。
日志位于 artifacts/prefix-turn13-*.log，界面结果在 artifacts/prefix-lifecycle-gui/。
本轮 fetch 后落后 origin/main 176 个提交，未合并主线；真实公司 CodeAgent 的本轮修复仍未验证。

2026-11-06 标题修订：用户已在公司电脑验证 21ef320 的中间/末轮分支、再次分支、重启及无重复显示。
本轮卡片分支保留直接父会话完整标题，启动标题整理也不再丢掉内层前缀；普通工具分支规则不变。
专项 43 项、全量 938 项、audit-public、语法检查通过；隔离生命周期 GUI 验证嵌套标题和重启后兄弟编号递增。
GUI 初轮点击后没有产生 Main 请求；调整测试为滚动完成并确认目标命中后点击，重跑通过，没有修改产品点击行为。
标题修复在真实 CodeAgent 上尚未验证。随后 fetch 得到 origin/main d02eef9，待 merge 的主线提交为 180 个。

2026-11-06 主线整合：标题修复提交为 68c587c；以普通 merge 整合 origin/main d02eef9，未 rebase。
唯一文本冲突是 package.json 的测试清单，保留主线全部测试并追加两份历史分支测试；自动合并后的分支接线逐项核对。
community-edition.json 与 .github/workflows/ci.yml 原样采用主线，未作手工编辑；依赖锁仅变更版本号，依赖图未变化。
合并后 `npm.cmd test` 1262 项通过，audit-public、改动 JS 语法检查、相对 origin/main 的 diff --check 通过。
主线自带两个终端屏幕夹具的行尾空格使相对合并前的 diff --check 报告空白提示，保留原样，不裁剪屏幕样本。
community、prefix-branch、prefix-dormant、prefix-lifecycle 四项隔离 GUI 通过；后者覆盖重启后再次分支
得到“分支2: 分支1: PREFIX LIFECYCLE”，已打开截图核对。首次整合 GUI 的临时 DOM 点击标记被历史刷新替换，
测试改用稳定原生轮次 ID 定位后通过；未改产品行为。公开版临时导出通过（0 泄露、0 未解析引用、0 语法错误；2 条既有链接警告）。
当时实验键默认关闭（现已改为默认开启）。日志在 artifacts/prefix-title-*.log 和 artifacts/prefix-merge-*.log；本轮标题修复与合并未在公司真实 CodeAgent 上复验。

2026-11-06 subagents 修订：fetch 成功，落后 origin/main 0 个提交，未合并主线。
按用户提供的诊断结构构造 msg_ 主链记录及 model-io/observability/subagents 目录；
新增两项回归先复现 sidecar-unknown-content，修正后专项 80 项、`npm.cmd test` 全量 1264 项通过。
Task/Agent 之前、完整配对之后和末轮均可创建独立 JSONL；不配对仍拒绝。
子目录普通文件不读、不复制，链接拒绝且不遍历，源记录与附属文件内容/mtime 均保持。
`node scripts/audit-public.js`、改动 JS 的 `node --check`、`git diff --check` 通过。
`node tests/e2e-prefix-branch-cdp.js` 覆盖原生格式 Task/Agent/Read、多段正文、较早页、
staging 挂载与宽窄窗口：入口位于最终正文之后，拒绝提示与退路独立成行；已打开截图核对。
专项 GUI 首次报告通过但 PowerShell 重定向命令返回 1；显式传递 Node 退出码后复跑为 0。
`node tests/e2e-prefix-dormant-cdp.js`、`node tests/e2e-prefix-lifecycle-cdp.js`、
`node tests/e2e-community-cdp.js` 均通过，覆盖休眠、占用、发送、再次分支和重启。
公开版临时导出通过（0 泄露、0 未解析引用、0 语法错误；2 条既有链接警告）。
以上为合成记录、隔离 Electron 和本地 CLI 协议夹具，真实 CodeAgent 在子 agent 之后恢复仍未验证。
本轮日志为 artifacts/*turn17*.log；本地任务卡同步规则但不提交。

2026-11-06 菜单修订：用户确认 ba37a4e 在子 agent 之后可恢复、说出结果并继续发消息；
保留不复制 subagents 的决定。本轮仅将入口移入最终正文卡的“更多”菜单，独立拒绝提示和退路不变。
首次 fetch 出现 SSL_ERROR_SYSCALL，重试成功后落后 origin/main 0 个提交；未合并主线。
新增菜单标记回归与启用后关闭的 DOM 对照：关闭时和 origin/main 菜单一致，无残留隐藏选项。
专项 46 项、`npm.cmd test` 全量 1265 项、`node scripts/audit-public.js`、改动 JS 的 `node --check`
及 `git diff --check` 通过；公开版临时导出通过（0 泄露、0 未解析引用、0 语法错误，2 条既有链接警告）。
`node tests/e2e-prefix-branch-cdp.js`、`node tests/e2e-prefix-dormant-cdp.js`、
`node tests/e2e-prefix-lifecycle-cdp.js` 均通过，鼠标先打开“更多”再点击分支，覆盖工具轮次、
较早页、休眠、占用、发送、再次分支和重启；已打开菜单截图核对，拒绝与退路仍在正文下单独成行。
`node tests/e2e-community-cdp.js` 首轮功能通过但 teardown 异常退出（3765269347）；
未改代码单独复跑通过、正常退出 0，异常退出原因尚未确定，保留两轮日志。
日志在 artifacts/*turn18*.log。以上使用合成数据和本地 CLI 协议夹具；本次菜单改动尚未在公司电脑真机验收。

2026-11-06 合入前账号目录隔离：按用户决定，普通分支恢复主线全局配置目录查找，
仅 codeagentPrefixFork.configDir 的覆盖留在前缀分支专用代码段内；前缀分支仍使用创建时记录的目录。
fetch 后 origin/main 为 d02eef9，落后 0 个提交，无需 merge。专项 48 项、全量 1267 项通过；
新增回归直接观测 findNativeClaudeHistory 收到的 CLAUDE_CONFIG_DIR，覆盖普通单账号/号池的
已绑定子会话、候选记录和待恢复源分支三条路径，以及单账号/号池前缀持久化后账号元数据变化。
audit-public、改动 JS 语法检查、diff --check、四项隔离 GUI 和公开版导出均通过；
基础 GUI 本轮正常退出 0。导出结果 0 泄露、0 未解析引用、0 语法错误，2 条既有链接警告。
导出的 codeagent-fork-identity.js 与合入前 origin/main 全文件比较，仅忽略额外未使用的
session 参数、对应调用参数及行尾后完全相同，未残留 codeagentPrefixFork 逻辑。
未改 community-edition.json 或 ci.yml，不发版；本轮账号目录恢复使用合成记录和本地协议夹具验证，
未在公司电脑真实 CodeAgent 上复验。日志为 artifacts/*turn21*.log。

2026-11-09 休眠打开修订：移除 selectSession 的 browseDormant 捷径，无论实验开关均先检查占用再自动恢复 CLI。
休眠源的三个实验 IPC、完整原生记录读取和不唤醒源会话的契约保持不变；配置读取失败仍隐藏入口。
显式休眠清空卡片，恢复失败占位页隐藏卡片；CLI 跑在常驻 PowerShell 里，CLI 自己退出后外壳仍在，会话不转休眠。PTY 外壳也退出（如控制台被关闭）时才保留卡片并转为休眠，此时入口从完整原生记录读取，不唤醒源会话。GUI 改为先验证真实鼠标恢复，再让模拟 CLI 和外壳依次退出验证休眠卡片。
生命周期测试不再断言源 CLI 从未启动，仍检查所有启动使用 --resume 而非 --fork-session。菜单合成测试无需改变。
其余前缀分支代码段检查通过（2026-11-10 起随公开版发布）。
本次未验证真实公司 CodeAgent。

2026-11-09 休眠 E2E 范围修订：转休眠后等待入口数量连续约 3 秒不变，再检查入口非空且全部可见、可用；延迟配置重建入口时必须恢复到该稳定数量。
“加载更早”不在此 E2E，由 tests/unit-codeagent-prefix-branch.test.js 和 tests/e2e-prefix-branch-cdp.js（较早分页不前移入口，含 cb8c939 引入的历史入口）覆盖；已知现象：PTY 外壳退出后保留卡片可能被重载为较短历史，疑与 session-closed 的 cardHistoryViews.drop 和 limit:4 实时刷新有关，确切路径未确认，尚未修复。
本次只调整测试与文档，未修改产品代码；node --check 通过。沙箱无法运行 GUI，本次未运行 GUI E2E。

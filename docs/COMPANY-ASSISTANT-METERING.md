# 公司助理任务计量与基线采集

本步骤只记录现有简报（brief）和聊天（chat）任务，不拆分会话、不改变提示词或队列，也没有新增界面。任务提交前固定原生 JSONL 的读取边界；任务结束时固定第二个边界，复用 `ClaudeUsageLedger` 按消息 ID 累计全部模型响应。单次历史读取限时 250ms，超时标为不可得；收尾不等待读取或写盘。读取和写入失败只输出固定诊断，不输出异常中的路径或消息内容。

文件位置：`<Hub 数据目录>/company-assistant/metering-YYYY-MM-DD.jsonl`。日期使用项目现有的上海日期规则；写入后只清理此命名格式下超过 14 个自然日期的计量文件（含当天）。不改简报、原生会话或其他历史文件。Hub 退出时仍在后台写入的记录、进程崩溃中的任务不保证落盘。

每行包括任务 ID、brief/chat、会话 ID、毫秒时间戳、success/failure、模型、前后 Context（含百分比）、本次 token、前后 Credit 数值和档位、Credit 差、压缩标记和原因。简报解析失败记 failure。未进入 CLI 的失败任务也有记录，此时可测字段通常为 null。文件不保存消息、提示词、原生记录路径、账号或凭据。

## 只读汇总

在包含本次改动的代码目录，用 Node.js 22+ 运行（数据目录换成公司电脑实际目录）：

```powershell
node scripts/company-assistant-metering-summary.js "$env:USERPROFILE\.ai-hub-community\company-assistant"
node scripts/company-assistant-metering-summary.js "D:\你的Hub数据\company-assistant" 2026-11-03
```

省略目录时遵循 `CLAUDE_HUB_DATA_DIR`，否则使用 `%USERPROFILE%\.ai-hub-community`。脚本仅仅读取计量 JSONL，输出 JSON；`groups` 按日期和任务类型输出任务数、失败数、四类 token 及总量、Context token 变化合计、压缩和不可得次数。`measuredTokens`、`measuredContext` 表示实际参与汇总的记录数，缺失记录不作为零消耗加入；全部缺失时合计为 null。`flags` 列出压缩或不可得的任务 ID 和原因。汇总不写文件、不执行清理。

Node 未加入 PATH 时，用本机实际的 Node 可执行文件路径：

```powershell
& '<node.exe 的实际路径>' scripts/company-assistant-metering-summary.js '<实际计量目录>'
```

## 如何采集旧行为基线

1. 在公司电脑启动包含本次改动的 Hub，赶在当天简报自动生成前（默认 08:20）。记录 Hub/CodeAgent 版本、实际模型、账号代称和采集范围；这些人工备注不要包含凭据或消息正文。
2. 保持同账号没有其他会话消耗，避免跨额度重置点。完成一次简报，等整理和 CLI 忙状态结束，再问一条固定短问题。若已生成当天简报，「重新生成」只能算再次生成的增量。
3. 等计量文件出现后运行上述汇总，核对 brief、chat 各一条，记录对应任务和会话 ID；检查 flags。持续收集，文件自动保留最近 14 个日期。

## 数据解释和待真机确认项

- `tokens.input` 包含缓存读取、缓存写入；`total=input+output`，缓存是输入的子集，不要重复相加。同 ID 多次快照取各字段最大值。一轮中只要发现一个新响应 usage 全零，本轮 token 就为 null（usage-zero）；缺失、异常或截断历史也不当成零。更换原生文件时保守标记不可得。
- Context 优先直接复用当前屏幕 Stats 解析，读不到记 stats-unavailable；屏幕值有舍入误差。它不是累计消耗，压缩后的负变化也不换算成 token。
- Credit 换档记 credit-tier-changed、额度增加记 credit-reset、未知档位记 credit-tier-unknown。即使有有效差值，它仍是账号快照差，不保证独占归属；跨重置但净值下降无法自动识别，需要人工剔除。
- 压缩证据来自任务期间的合法顶层压缩 hook、原生 compact_boundary 增量、屏幕新出现的既有压缩提示。false 仅表示可读历史中未观察到压缩；证据不可读则 null。不可把普通 Context 下降直接判为压缩。
- **未确认**：公司 CodeAgent 当前 usage 是否仍全零、实际模型元数据与 Context/Credit 面板是否及时刷新、压缩 hook/原生标记是否完整、原生文件路径绑定时机和历史规模是否导致限时不可读。首次新会话尚未绑定原生记录时可能不可测，不能伪造基线。
- 超时失败不表示 CLI 已停止；失败快照只覆盖 Hub 判定失败的时刻，后续消耗不自动补归属。人工直接在同一个 CLI 输入、其他自动动作也可能影响任务归属；采集时避免这些操作。

## 本地验证记录（2026-11-03）

本次使用项目记忆指定的 Node 运行时，没有安装依赖；本 worktree 的 node_modules 为普通目录。

- `node --test tests/unit-company-assistant-metering.test.js`：因测试运行器创建子进程被沙箱拒绝（spawn EPERM）而未执行测试。
- `node --test --test-isolation=none tests/unit-company-assistant-metering.test.js`：6 项全过，包含累计去重、全零、换档、压缩、读失败、清理及汇总。
- `npm test`：3 个测试文件均因 spawn EPERM 未执行。随后用 `node --test --test-isolation=none tests/unit-community.test.js tests/unit-community-onboarding.test.js tests/unit-community-hooks.test.js tests/unit-company-assistant-metering.test.js` 验证，当时新增测试为 4 项，总计 18 项中 16 项通过；原有 hook 转发和源码 ZIP 审计测试仍因内部创建子进程被拒绝失败。没有修改原有测试或绕过断言。
- `node scripts/audit-public.js`：首次指出本文档含开发机用户路径，移除该路径后复跑通过（ok=true，1276 个文件）。
- 对 5 个改动 JavaScript 文件分别运行 `node --check`：全部通过；`git diff --check` 通过。
- `node tests/e2e-community-cdp.js`：启动隔离 Hub 时 spawn EPERM，GUI 检查未执行。公司真机与真实 provider 未验证。

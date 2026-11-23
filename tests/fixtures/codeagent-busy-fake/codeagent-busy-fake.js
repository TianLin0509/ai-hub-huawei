'use strict';
// 「开很多会话、CodeAgent 跑任务时 Hub 每 3–5 秒卡一下」的复现替身（2026-11-23）。
// 一个会话同时做真 CodeAgent 跑任务时会做的三件事，不调用任何模型：
//   1. 终端：全屏界面持续刷新（沿用 codeagent-tui-standin 的画法，约 24 块/秒）；
//   2. 原生记录：<配置目录>/projects/<转义工作目录>/<id>.jsonl 每隔一会追加一轮「工具调用 + 工具结果 + 回答片段」；
//   3. hook：启动报 SessionStart、开工报 UserPromptSubmit，之后每次工具调用报 PreToolUse / PostToolUse。
// 节奏可用环境变量调：BUSY_FAKE_TOOL_MS（每轮工具调用间隔，默认 1500）、BUSY_FAKE_RESULT_BYTES（每条工具结果字节，默认 4000）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('1.2615.02.01 (codeAgentCLI)\n', () => process.exit(0)); return; }
if (args[0] === '--help' || args[0] === 'serve') { process.exit(0); }
const configDir = process.env.CODEAGENT3_CONFIG_DIR || '';
const isProbe = !process.env.CLAUDE_HUB_SESSION_ID;
if (isProbe) { process.stdout.write('> Anything I can assist you with?\r\n'); setInterval(() => {}, 1 << 30); return; }
const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt >= 0 && /^[0-9a-f-]{36}$/i.test(args[resumeAt + 1] || '') ? args[resumeAt + 1] : crypto.randomUUID();
const cwd = process.cwd();
const dir = path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, `${sessionId}.jsonl`);
const now = () => new Date().toISOString();
const append = row => fs.appendFileSync(transcript, JSON.stringify({ sessionId, cwd, timestamp: now(), ...row }) + '\n');
if (!fs.existsSync(transcript)) append({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: '请把仓库里的调度模块重构一下' } });

// hook 异步触发（真 CLI 也不会因为 hook 停下界面刷新）；同一事件不排队堆积。
let hookSettings = null;
function hooksFor(event) {
  if (!hookSettings) { try { hookSettings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')); } catch { hookSettings = {}; } }
  const groups = hookSettings.hooks && hookSettings.hooks[event];
  return Array.isArray(groups) ? groups.flatMap(g => (g.hooks || []).filter(h => h.type === 'command' && h.command)) : [];
}
function fireHook(event, extra = {}) {
  const payload = JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd, hook_event_name: event, source: 'startup', ...extra });
  for (const hook of hooksFor(event)) {
    const child = spawn(hook.command, { shell: true, windowsHide: true, env: process.env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => {});
    child.stdin.end(payload);
  }
}
fireHook('SessionStart');
setTimeout(() => fireHook('UserPromptSubmit', { prompt: '请把仓库里的调度模块重构一下', prompt_id: crypto.randomUUID() }), 800);

const toolMs = Number(process.env.BUSY_FAKE_TOOL_MS || 1500);
const resultBytes = Number(process.env.BUSY_FAKE_RESULT_BYTES || 4000);
const TOOLS = ['Read', 'Grep', 'Edit', 'Bash'];
let round = 0;
function toolRound() {
  round++;
  const tool = TOOLS[round % TOOLS.length];
  const toolUseId = 'toolu_' + crypto.randomBytes(12).toString('hex');
  const input = tool === 'Bash' ? { command: `node scripts/check.js --round ${round}` } : { file_path: path.join(cwd, `src/sched-${round % 7}.js`) };
  fireHook('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: toolUseId });
  const assistantId = crypto.randomUUID();
  append({ type: 'assistant', uuid: assistantId, message: { id: 'msg_' + crypto.randomBytes(12).toString('hex'), role: 'assistant', model: 'GLM-5.2-WX-Auto',
    content: [{ type: 'text', text: `第 ${round} 步：先看一下 ${tool} 的结果再决定怎么改调度队列。` }, { type: 'tool_use', id: toolUseId, name: tool, input }],
    usage: { input_tokens: 12000 + round * 50, output_tokens: 300, cache_read_input_tokens: 10000 } } });
  const body = ('调度器按信道质量分配资源块，HARQ 负责重传合并。' .repeat(Math.ceil(resultBytes / 60))).slice(0, Math.floor(resultBytes / 3));
  append({ type: 'user', uuid: crypto.randomUUID(), parentUuid: assistantId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: body }] } });
  fireHook('PostToolUse', { tool_name: tool, tool_input: input, tool_use_id: toolUseId, tool_response: { ok: true } });
}
setInterval(toolRound, toolMs);

// 终端画面：复用 tui 替身的刷新节奏。
require('../codeagent-tui-standin/fake-opentui.js');

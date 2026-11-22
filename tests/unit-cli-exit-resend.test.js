'use strict';
// 「CLI 已退出、消息未发送」一键「重启会话并重发」+ 终端最后几行（2026-11-20 根因调查结论 C）。
// 终端尾部截取与脱敏、经 IPC 传到界面、轻提示上的按钮与尾部、渲染层动作接线。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { terminalTailLines } = require('../core/group-chat-watcher');
const card = require('../renderer/hub-error-card');

test('终端最后几行：去控制符，最多 5 行、每行 ≤160 字，家目录和密钥脱敏', () => {
  const home = os.homedir();
  const buffer = ['第一行旧输出', '第二行', '第三行', '\x1b[31mError: Effort level "max" is not available\x1b[0m',
    `config at ${home}\\.claude\\settings.json`, 'key sk-AbCdEf0123456789xyzXYZ rejected', 'x'.repeat(400), `PS ${home}> `].join('\r\n');
  const tail = terminalTailLines(buffer);
  assert.equal(tail.length, 5);
  assert.equal(tail[0], 'Error: Effort level "max" is not available');
  assert.ok(!tail.some(l => l.includes(home)), '家目录换成 ~');
  assert.ok(tail.some(l => l === '（这一行疑似含密钥，已隐去）') && !tail.some(l => l.includes('sk-AbCdEf')), '含密钥的行整行隐去');
  assert.ok(tail.every(l => l.length <= 160));
  assert.match(tail[4], /^PS ~>/);
  assert.deepEqual(terminalTailLines(''), []);
});

test('cli-exited 分支带上 terminalTail 并记启动阻塞日志；IPC 把它原样交给界面', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), 'utf8');
  assert.match(src, /const terminalTail = terminalTailLines\(exitBuffer\);\r?\n\s*await logStartupBlock\(sid, 'cli-exited', exitBuffer\);/);
  assert.match(src, /code:'cli-exited', \.\.\.\(missing \? \{ missingCli: missing \} : \{\}\), \.\.\.\(terminalTail\.length \? \{ terminalTail \} : \{\}\)/);
  // 走真实的 prompt-submit-handlers：发送抛出带 terminalTail 的「已退出」，回执里要有 code / terminalTail。
  const file = path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js');
  const localRequire = createRequire(file);
  const error = Object.assign(Error('CLI 已退出到系统终端，消息未发送；请先重启会话'), { notSent: true, code: 'cli-exited', terminalTail: ['Error: 401', 'PS ~>'] });
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, AbortController, setTimeout, clearTimeout,
    require: name => name === '../../core/group-chat-watcher.js' ? { codeAgentInputAction: async () => ({ ok: true }), sendToPty: () => { throw error; } } : localRequire(name) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const manager = new EventEmitter();
  manager.getSession = id => (id === 's1' ? { kind: 'codeagent' } : null);
  const handlers = new Map();
  const reg = context.module.exports.registerPromptSubmitIpc({ handle: (n, fn) => handlers.set(n, fn) }, {
    sessionManager: manager, sendToRenderer() {}, logger: { warn() {} }, commandTranscriptStore: { begin: () => ({ duplicate: false }), finish() {} } });
  try {
    const got = await handlers.get('session:send-prompt')(null, { sessionId: 's1', text: '你好', clientSubmissionId: 'c1' });
    assert.equal(got.code, 'cli-exited');
    assert.equal(got.notSent, true);
    assert.deepEqual([...got.terminalTail], ['Error: 401', 'PS ~>']);
  } finally { reg.dispose(); }
});

function fakeDoc() {
  const made = [];
  return { made, body: { appendChild() {} }, getElementById: () => null,
    createElement: () => { const el = { dataset: {}, innerHTML: '', classList: { add() {}, contains: () => false }, setAttribute() {}, addEventListener() {}, insertAdjacentHTML() {}, remove() {} }; made.push(el); return el; } };
}
const acts = h => [...h.matchAll(/data-hub-err-act="([^"]+)">([^<]+)</g)].map(m => [m[1], m[2]]);

test('轻提示：已退出时主按钮是「重启会话并重发」，旁边「只重启」，下面列终端最后几行', () => {
  const doc = fakeDoc();
  const el = card.showErrorToast(doc, '消息未发送：CLI 已退出到系统终端，消息未发送；请先重启会话',
    { sessionId: 's1', resendText: '帮我整理周报', terminalTail: ['Error: Effort level "max" is not available', 'PS ~>'] });
  assert.deepEqual(acts(el.innerHTML), [['known:session-restart-resend', '重启会话并重发'], ['known:session-restart', '只重启']]);
  assert.match(el.innerHTML, /class="hub-err-toast-btn primary" data-hub-err-act="known:session-restart-resend"/);
  assert.match(el.innerHTML, /终端最后几行（退出原因）<\/span><pre>Error: Effort level &quot;max&quot; is not available\nPS ~&gt;<\/pre>/);
  assert.equal(el._hubResendText, '帮我整理周报');
  assert.equal(el.dataset.sessionId, 's1');
});

test('轻提示：没有原文（例如助理通路）只给「重启会话」；找不到 CLI 等其他报错不出重发按钮', () => {
  const plain = card.showErrorToast(fakeDoc(), '消息未发送：CLI 已退出到系统终端，消息未发送；请先重启会话', { sessionId: 's1' });
  assert.deepEqual(acts(plain.innerHTML), [['known:session-restart', '重启会话']]);
  assert.doesNotMatch(plain.innerHTML, /hub-err-toast-tail/);
  const other = card.showErrorToast(fakeDoc(), '消息未发送：API Error: 400 模型不存在或配置有误', { sessionId: 's1', resendText: '你好' });
  assert.ok(!acts(other.innerHTML).some(([a]) => a === 'known:session-restart-resend'));
});

test('渲染层接线：已退出且不是缺 CLI 时才带原文；动作先重启、再等就绪重发、发出后清掉输入框里的同一段原文', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /const exited = result\.code === 'cli-exited' && !result\.missingCli;/);
  assert.match(renderer, /if \(exited\) showToast\('消息未发送：' \+ \(result\.message \|\| 'CLI 已退出'\), 'error', \{ sessionId, resendText: text, terminalTail:/);
  assert.match(renderer, /window\.__hubClearFloatingDraftIf = \(sessionId, text\) => \{/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub-error-card.js'), 'utf8');
  const block = src.slice(src.indexOf("if (act === 'known:session-restart-resend')"), src.indexOf("if (act === 'known:open-accounts')"));
  assert.ok(block.indexOf('__hubRestartSessionInPlace(sessionId)') > 0);
  assert.ok(block.indexOf("invoke('session:send-prompt'") > block.indexOf('__hubRestartSessionInPlace(sessionId)'), '先重启后重发');
  assert.match(block, /waitForCliReady: true/);
  assert.ok(block.indexOf('__hubClearFloatingDraftIf') > block.indexOf("invoke('session:send-prompt'"), '发出去才清输入框');
});

function fakeButton({ sessionId = 's1', text = '帮我整理周报' } = {}) {
  const toast = { dataset: { sessionId }, _hubResendText: text, removed: false, remove() { this.removed = true; } };
  return { textContent: '重启会话并重发', disabled: false, isConnected: true, closest: sel => (sel === '[data-session-id]' || sel === '#hub-err-toast' ? toast : null), toast };
}
async function runResend({ restart, send }) {
  const calls = [], button = fakeButton();
  const win = { __hubRestartSessionInPlace: async id => { calls.push(['restart', id]); return restart; },
    __hubClearFloatingDraftIf: (id, text) => { calls.push(['clear', id, text]); return true; } };
  const ipcRenderer = { invoke: async (ch, req) => { calls.push([ch, req.sessionId, req.text, req.waitForCliReady]); return send; } };
  await card.runKnownAction('known:session-restart-resend', button, { doc: {}, win, ipcRenderer, closeOverlays() {} });
  return { calls, label: button.textContent };
}

test('一键动作：重启成功 → 等就绪重发同一段原文 → 清掉输入框里的原文', async () => {
  const { calls, label } = await runResend({ restart: { id: 's1' }, send: { ok: true } });
  assert.deepEqual(calls, [['restart', 's1'], ['session:send-prompt', 's1', '帮我整理周报', true], ['clear', 's1', '帮我整理周报']]);
  assert.equal(label, '已重启并重发');
});

test('一键动作：CLI 启动即退出、没有原生会话 ID 时照实说下一步；重发失败时说原文还在，不清输入框', async () => {
  const refused = await runResend({ restart: { ok: false, error: 'native-session-id-missing', message: '当前会话尚未绑定原生会话 ID' }, send: { ok: true } });
  assert.deepEqual(refused.calls, [['restart', 's1']]);
  assert.match(refused.label, /^没做成：这个会话的 CLI 一启动就退出了.*请新建会话再发/);
  const failed = await runResend({ restart: { id: 's1' }, send: { ok: false, notSent: true, message: 'CLI 已退出到系统终端，消息未发送' } });
  assert.ok(!failed.calls.some(c => c[0] === 'clear'));
  assert.match(failed.label, /已重启，但重发没成功：CLI 已退出到系统终端.*原文还在输入框/);
});

test('等确认时 CLI 退回命令行：回执带终端尾部；可能已被收下，主按钮「重启会话」，重发降为次按钮并提示先核对', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), 'utf8');
  assert.match(src, /message: 'CLI 已退出到命令行，消息可能没有被接收，未补回车', \.\.\.\(terminalTail\.length \? \{ terminalTail \} : \{\}\)/);
  const handler = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js'), 'utf8');
  assert.match(handler, /\.\.\.\(Array\.isArray\(result\.terminalTail\) \? \{terminalTail:result\.terminalTail\.slice\(-5\)\} : \{\}\),/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /if \(result\?\.error === 'cli-exited'\) \{\r?\n\s*showToast\(`发送失败：\$\{reason\}。\$\{restored \? '原文已放回输入框。' : ''\}`, 'error', \{ sessionId, resendText: text, resendUncertain: true, terminalTail:/);
  assert.match(renderer, /reportFloatingSendFailure\(sessionId, inputBox, text, result\?\.message \|\| result\?\.error \|\| '发送失败', clientSubmissionId, result\);/);
  // 和 main 的「重发条」并存：已退出这一路也挂上重发条（送达未知，按钮写「确认没收到，重发」）
  assert.match(renderer, /resendUncertain: true, terminalTail:[^\n]*\r?\n\s*inputBox\?\.closest\?\.\('\.floating-input-bar'\)\?\._resendStrip\?\.show\(\{ text, reason, uncertain: true, submissionId \}\);/);
  assert.match(renderer, /\.\.\.\(options\.resendUncertain \? \{ resendUncertain: true \} : \{\}\)/);
  // 发送前就拦下的「未发送」才是确定没收到：那一路不带 resendUncertain
  assert.doesNotMatch(renderer, /if \(exited\) showToast\([^\n]*resendUncertain/);
  const toast = card.showErrorToast(fakeDoc(), '发送失败：CLI 已退出到命令行，消息可能没有被接收，未补回车。原文已放回输入框。', { sessionId: 's1', resendText: '你好', resendUncertain: true, terminalTail: ['PS ~>'] });
  assert.deepEqual(acts(toast.innerHTML), [['known:session-restart', '重启会话'], ['known:session-restart-resend', '确认没收到，重启并重发']]);
  assert.match(toast.innerHTML, /class="hub-err-toast-btn primary" data-hub-err-act="known:session-restart"/);
  assert.match(toast.innerHTML, /hub-err-toast-note">这条可能已被 CLI 收下：先看对话里有没有它/);
  // 确定未发送时仍是重发为主
  const sure = card.showErrorToast(fakeDoc(), '消息未发送：CLI 已退出到系统终端，消息未发送；请先重启会话', { sessionId: 's1', resendText: '你好' });
  assert.equal(acts(sure.innerHTML)[0][0], 'known:session-restart-resend');
  assert.doesNotMatch(sure.innerHTML, /hub-err-toast-note/);
});

test('终端最后几行再过密钥规则：无前缀的部门 Key、JSON 字段整行隐去（sanitize 认不出的）', () => {
  const buffer = ['正常输出', 'config {"api_key":"0123456789abcdef0123456789abcdef"}', 'using key Q2xpZW50U2VjcmV0S2V5MTIzNDU2Nzg5MEFCQ0RFRg now', 'PS ~> '].join('\r\n');
  const tail = terminalTailLines(buffer);
  assert.equal(tail.length, 4);
  assert.equal(tail[0], '正常输出');
  assert.equal(tail[1], '（这一行疑似含密钥，已隐去）');
  assert.equal(tail[2], '（这一行疑似含密钥，已隐去）');
  assert.ok(!tail.join('\n').includes('0123456789abcdef') && !tail.join('\n').includes('Q2xpZW50'));
});

test('正常 TUI 输出（含改标题序列）不被当成宿主提示符而拒发：CodeAgent / Claude / Codex / pi', () => {
  const ESC = '\x1b', ST = '\x1b\\', BEL = '\x07';
  const screens = {
    codeagent: `${ESC}]0;CodeAgent - D:\\work${ST}╭──────────────╮\r\n│ > 帮我整理周报 │\r\n╰──────────────╯\r\n  ? for shortcuts`,
    claude: `${ESC}]0;✳ Claude Code${BEL}● 我先读一下 D:\\work\\main.js\r\n  ⎿  Read 120 lines\r\n> `,
    claudeSt: `${ESC}]0;✳ 整理周报${ST}\r\n✻ Thinking… (esc to interrupt)`,
    codex: `${ESC}]0;codex${ST}• Ran Get-ChildItem D:\\work\r\n  └ main.js\r\n› Ask Codex to do anything\r\n  ⏎ send`,
    codexPath: `${ESC}]0;D:\\work${ST}› 修改 D:\\work\\a.ps1 的第 3 行`,
    pi: `${ESC}]0;pi - D:\\work${ST}\r\n> 在跑测试\r\n  claude-opus · 12k tokens`,
  };
  for (const [name, screen] of Object.entries(screens)) assert.equal(detectHostShellTakeover('历史输出\r\n' + screen), false, name);
});

// 2026-11-20 负责人定：隔离 Hub 实测用户的话被 PowerShell 当命令执行。根因：PowerShell 用 ESC ] 0;… ESC \ 改窗口标题，
// 残渣粘在提示符前，「已退回系统终端」检查认不出，正文被粘进 PowerShell 并回车。下面每条撤掉修复即失败。
const { detectHostShellTakeover } = require('../core/host-shell-detector');
const PS_TITLE = '\x1b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x1b\\';

test('宿主提示符：ST 结尾的窗口标题粘在提示符前（含 >> 续行）也认得出 CLI 已退出', () => {
  assert.equal(detectHostShellTakeover('Error: x\r\n' + PS_TITLE + 'PS D:\\Temp\\work> '), true);
  assert.equal(detectHostShellTakeover('Error: x\r\n' + PS_TITLE + 'PS D:\\Temp\\work> >> '), true);
  assert.equal(detectHostShellTakeover('Error: x\r\nPS D:\\Temp\\work> >> '), true);
  // CLI 还在跑：标题后面是 CLI 自己的画面，没有宿主提示符
  assert.equal(detectHostShellTakeover('\x1b]0;✳ Claude Code\x1b\\> 帮我看看这个函数\r\n  ⎿ 正在思考'), false);
});

test('AI 会话发送前看到宿主提示符就拒发：正文一个字都不写进 PowerShell', async () => {
  const watcher = require('../core/group-chat-watcher');
  const writes = [];
  const buffer = 'Starting CodeAgent...\r\nError: Effort level "max" is not available\r\n' + PS_TITLE + 'PS D:\\Temp\\work> >> ';
  const sessionManager = {
    getSession: () => ({ id: 's1', kind: 'codeagent', createdAt: Date.now() - 600000 }),
    getSessionBuffer: () => buffer, getGroupChatReady: () => true, setGroupChatReady() {},
    writeToSession: (_id, data) => writes.push(data), write: (_id, data) => writes.push(data),
    getGroupChatLastActivity: () => 0, sessions: new Map(),
  };
  if (typeof watcher.init === 'function') watcher.init({ sessionManager, cliReadyDetector: { isReady: () => true }, transcriptTap: null });
  let error = null;
  try { await watcher.sendToPty('s1', '帮我把这周的周报整理一下', 'codeagent', { requireReady: false }); }
  catch (e) { error = e; }
  assert.ok(error, '应当拒发');
  assert.equal(error.code, 'cli-exited');
  assert.equal(error.notSent, true);
  assert.ok(!writes.some(w => String(w).includes('周报')), '正文不能写进终端');
  assert.ok(error.terminalTail.some(l => /^PS D:/.test(l)), '终端尾部里标题残渣已去掉，提示符单独成行：' + JSON.stringify(error.terminalTail));
});

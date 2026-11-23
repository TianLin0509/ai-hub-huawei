'use strict';
// 号池端到端测试用的假 CodeAgent：记下每次启动拿到的配置目录、工作目录和参数；
// 像真 CLI 一样按「配置目录里 settings.json 登记的 SessionStart hook」向 Hub 报到（顺带验证 Hub 部署到号池目录的 hook 能用），
// 并在 <配置目录>/projects/<转义的工作目录>/<id>.jsonl 写一条会话记录，供 --resume 找到。
// 屏幕照公司 CodeAgent 1.2615 的实录画：空闲时「> Anything I can assist you with?」，输入 /model 回车弹出「Select model」菜单，
// Esc 关闭。菜单里的模型按凭证里的工号定：z 开头的号只有 DeepSeek，其余只有 GLM（模拟各号模型权限不同）。
// 不调用任何模型，也不需要登录。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
// 真 CLI 读完版本就退出。以前这里也进交互循环，Hub 探测版本后没收掉就留下 node 进程，全机累计 200 多个。
// 版本和公司实录同格式，正好等于 Hub 的最低版本：不弹升级提醒，也不会再去读 --help。
// Windows 上管道写入是异步的，写完再退出，否则版本号可能被截掉。
if (args[0] === '--version') {
  process.stdout.write('1.2615.02.01 (codeAgentCLI)\n', () => process.exit(0));
  return;
}
// CODEAGENT_POOL_FAKE_HELP_SETTINGS=1：--help 像 1.2615.02.05 一样列出 --settings（Hub 据此用 --settings 固定会话模型）。
if (args[0] === '--help' && process.env.CODEAGENT_POOL_FAKE_HELP_SETTINGS === '1') {
  process.stdout.write('Usage: codeagent [options]\n  --settings <file-or-json>  Load additional settings\n  --resume <id>\n', () => process.exit(0));
  return;
}
const configDir = process.env.CODEAGENT3_CONFIG_DIR || '';
const log = process.env.CODEAGENT_POOL_FAKE_LOG;
const resumeAt = args.indexOf('--resume');
const resumeId = resumeAt >= 0 && /^[0-9a-f-]{36}$/i.test(args[resumeAt + 1] || '') ? args[resumeAt + 1] : null;
const sessionId = resumeId || crypto.randomUUID();
const cwd = process.cwd();
const isProbe = !process.env.CLAUDE_HUB_SESSION_ID;
let transcript = null;
if (configDir && !isProbe) {
  const dir = path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  transcript = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcript)) {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId, cwd, uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(), message: { role: 'user', content: 'fake' } }) + '\n');
  }
}
if (log) fs.appendFileSync(log, JSON.stringify({ at: Date.now(), cwd, args, configDir: configDir || null,
  hubSession: process.env.CLAUDE_HUB_SESSION_ID || null, sessionId, resumed: !!resumeId, probe: isProbe }) + '\n');

function fireHook(event, name, extra = {}) {
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')); } catch { return; }
  const groups = settings && settings.hooks && settings.hooks[event];
  if (!Array.isArray(groups)) return;
  const payload = JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd, hook_event_name: event, source: resumeId ? 'resume' : 'startup', ...extra });
  for (const group of groups) for (const hook of group.hooks || []) {
    if (group.matcher && ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event)
        && !new RegExp(group.matcher).test(String(extra.tool_name || ''))) continue;
    if (hook.type !== 'command' || !hook.command) continue;
    const r = spawnSync(hook.command, { input: payload, shell: true, timeout: 10000, windowsHide: true, env: process.env });
    if (log) fs.appendFileSync(log, JSON.stringify({ at: Date.now(), hook: name, status: r.status, hubSession: process.env.CLAUDE_HUB_SESSION_ID || null }) + '\n');
  }
}
if (!isProbe) fireHook('SessionStart', 'session-start');

function accountModels(menu = false) {
  let accountId = '';
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'));
    const entry = Object.values(raw).find(v => v && typeof v === 'object');
    accountId = String(entry && entry.accountId || '');
  } catch { /* 没登录 */ }
  // CODEAGENT_POOL_FAKE_MODELS=a,b,c：这个号的模型清单（serve 和 /model 菜单同一份），用来测长清单。
  // 模拟 serve 报短名称、原生菜单带线路前缀的公司环境。
  const listed = String(menu && process.env.CODEAGENT_POOL_FAKE_MENU_MODELS || process.env.CODEAGENT_POOL_FAKE_MODELS || '').split(',').map(m => m.trim()).filter(Boolean);
  if (listed.length) return listed;
  return /^z/i.test(accountId) ? ['deepseek-v4-flash-0731'] : ['GLM-5.2-WX-Auto'];
}
// serve 模式（2026-10-30，Hub 先经 serve 读模型清单）：交给假 serve（codeagent-serve-fake），清单和 /model 菜单一致；
// CODEAGENT_POOL_FAKE_NO_SERVE=1 时像老版本 CodeAgent 一样不认 serve（立即退出），用来测回落读屏。
if (args[0] === 'serve') {
  if (process.env.CODEAGENT_POOL_FAKE_NO_SERVE === '1') { process.stderr.write('Unknown command: serve\n'); process.exit(2); }
  const models = Object.fromEntries(accountModels().map(id => [id, { id, display_name: id, max_context_tokens: 202752, originCoefficient: '1x', isIdle: false, load: 'low' }]));
  const file = path.join(require('os').tmpdir(), `codeagent-pool-fake-providers-${process.pid}.json`);
  // CODEAGENT_POOL_FAKE_DISABLED_PROVIDER=名字:模型1,模型2（只在测试里打开）：再报一个状态为 disabled 的供应商，测「暂不可用」一组。
  const disabled = String(process.env.CODEAGENT_POOL_FAKE_DISABLED_PROVIDER || '');
  const extra = disabled.includes(':') ? [{ id: 'team', display_name: disabled.split(':')[0], status: 'disabled',
    models: Object.fromEntries(disabled.split(':')[1].split(',').filter(Boolean).map(id => [id, { id, display_name: id }])) }] : [];
  const providers = process.env.CODEAGENT_POOL_FAKE_PROVIDER_FILE
    ? JSON.parse(fs.readFileSync(process.env.CODEAGENT_POOL_FAKE_PROVIDER_FILE, 'utf8')) : [{ id: 'w3', status: 'available', models }, ...extra];
  fs.writeFileSync(file, JSON.stringify({ providers, busyIdleDefinition: { discount_status: '闲时2折进行中' },
    creditUsage: { quotas: [{ type: 'CPM', used: 1000, total: 400000, remaining: 399000, resetAt: '2026-11-14 00:00:00' },
      { type: 'CPD_Peak', used: 50, total: 20000, remaining: 19950, resetAt: '2026-10-31 00:00:00' }] } }));
  // 每个模型的配额：今日 29.16M / 400M（7.29%），和公司 /model 菜单实录同一组数
  const quotaDir = path.join(require('os').tmpdir(), `codeagent-pool-fake-quota-${process.pid}`);
  fs.mkdirSync(quotaDir, { recursive: true });
  for (const id of Object.keys(models)) {
    fs.writeFileSync(path.join(quotaDir, `${id}.json`), JSON.stringify({ quotas: [{ type: 'TPD', used_quota: '29160000', total_quota: '400000000', reset_at: '2026-10-31 06:00:00' }] }));
  }
  process.on('exit', () => { try { fs.unlinkSync(file); fs.rmSync(quotaDir, { recursive: true, force: true }); } catch { /* 已删 */ } });
  process.env.SERVE_FAKE_PROVIDERS = file;
  process.env.SERVE_FAKE_QUOTA_DIR = quotaDir;
  require('../codeagent-serve-fake/codeagent-serve-fake.js');
  return;
}
const out = text => process.stdout.write(text);
const prompt = () => out('\x1b[2J\x1b[H  CodeAgent (fake)\r\n\r\n> Anything I can assist you with?\r\n');
function menu() {
  const models = accountModels(true);
  out('\x1b[2J\x1b[H  Select model    ✕\r\n\r\n  Built-in\r\n');
  models.forEach((m, i) => out(`  ${i === 0 ? '❯' : ' '}  ${i + 1}. ${m}${i === 0 ? ' default ✓' : ''}   0x\r\n`));
  out('\r\n  Navigate ↑ ↓ | Select enter | Back esc\r\n');
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
prompt();
// Company team UI test: the fixture inherits the real Hub session identity and
// executes the production CLI. No identity is forged or exposed to the driver.
// Ordinary prompts are acknowledged through the same native hooks/JSONL path.
if (process.env.CLAUDE_HUB_E2E === '1' && process.env.CODEAGENT_TEAM_FAKE_CONTROL_DIR && !isProbe) {
  require('./team-control')({ sessionId, transcript, cwd, fireHook, prompt, menu });
  return;
}
let typed = '';
// CODEAGENT_POOL_FAKE_ANSWER_MODEL_FILE=<文件>：普通消息也回答——写原生记录（回答的 model 取文件里当时写的，模拟在后台 /model 换了模型），
// 再按配置目录登记的 hook 报 UserPromptSubmit / Stop，Hub 照真 CLI 的路径读到「实际模型」。
const answerModelFile = process.env.CODEAGENT_POOL_FAKE_ANSWER_MODEL_FILE || '';
function answer(text) {
  if (!transcript) return;
  const uuid = crypto.randomUUID();
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', sessionId, cwd, uuid, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n');
  fireHook('UserPromptSubmit', 'prompt', { prompt: text, prompt_id: uuid });
  let model = 'fixture-no-model';
  try { model = fs.readFileSync(answerModelFile, 'utf8').trim() || model; } catch { /* 没写就用占位 */ }
  // CLI 1.2615.02.03 真机：--settings 只在启动时定模型，活着时 /model 的选择优先。
  if (menuSelect) model = sessionModel || model;
  // Optional test-only runtime result, independent of menu/config precedence.
  // This simulates authoritative provider evidence, not terminal confirmation.
  try { model = fs.readFileSync(process.env.CODEAGENT_POOL_FAKE_RUNTIME_MODEL_FILE, 'utf8').trim() || model; } catch {}
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId, cwd, uuid: crypto.randomUUID(), parentUuid: uuid, timestamp: new Date().toISOString(),
    message: { id: 'msg_' + crypto.randomUUID().replace(/-/g, ''), role: 'assistant', model, content: [{ type: 'text', text: '夹具已收到：' + text }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n');
  fireHook('Stop', 'stop', { last_assistant_message: '夹具已收到：' + text });
}
const menuSelect = process.env.CODEAGENT_POOL_FAKE_MENU_SELECT === '1';
const settingsAt = args.indexOf('--settings');
function launchSettingsModel() {
  if (settingsAt < 0) return '';
  try { return String(JSON.parse(fs.readFileSync(args[settingsAt + 1], 'utf8')).model || '').trim(); } catch { return ''; }
}
let sessionModel = launchSettingsModel(), menuOpen = false, menuCursor = 0, pendingEsc = null, pendingKeys = '';
function drawMenu() {
  const models = accountModels(true);
  out('\x1b[2J\x1b[H  Select model    ✕\r\n\r\n  Built-in\r\n');
  models.forEach((m, i) => out(`  ${i === menuCursor ? '❯' : ' '}  ${i + 1}. ${m}${i === 0 ? ' default ✓' : ''}   0x\r\n`));
  out('\r\n  Navigate ↑ ↓ | Select enter | Back esc\r\n');
}
let pasteBuffer = null;
function handleKeys(chunk) {
  if (menuSelect && process.env.CODEAGENT_POOL_FAKE_KEYLOG) fs.appendFileSync(process.env.CODEAGENT_POOL_FAKE_KEYLOG, JSON.stringify({ menuOpen, chunk: chunk.toString('utf8') }) + '\n');
  if (menuSelect && menuOpen) {
    // 菜单里：上下键移光标（每次重画），回车选中并回显「Set model to …」，Esc 关菜单。
    // 方向键可能被拆成「Esc」和「[B」两段到达：单独一个 Esc 先等一下，后面接着「[A/[B」就拼成方向键。
    let keys = pendingKeys + chunk.toString('utf8');
    pendingKeys = '';
    if (pendingEsc) { clearTimeout(pendingEsc); pendingEsc = null; }
    const partial = /\x1b\[?$/.exec(keys);
    if (partial) {
      pendingKeys = partial[0]; keys = keys.slice(0, partial.index);
      pendingEsc = setTimeout(() => { pendingEsc = null; pendingKeys = ''; menuOpen = false; prompt(); }, 150);
    }
    const models = accountModels(true);
    for (const key of keys.match(/\x1b\[[AB]|\x1b|\r|\n|./gs) || []) {
      if (key === '\x1b[B') { menuCursor = Math.min(models.length - 1, menuCursor + 1); drawMenu(); }
      else if (key === '\x1b[A') { menuCursor = Math.max(0, menuCursor - 1); drawMenu(); }
      else if (key === '\r' || key === '\n') { sessionModel = models[menuCursor]; menuOpen = false; prompt(); out(`  ⎿  Set model to ${sessionModel}\r\n`); }
      else if (key === '\x1b') { menuOpen = false; prompt(); }
    }
    return;
  }
  // Hub 发消息用括号粘贴（ESC[200~ … ESC[201~），再单独补回车；粘贴内容当正文，不当作 Esc。
  const text = [...chunk.toString('utf8').replace(/\x1b\[200~/g, '\u0001').replace(/\x1b\[201~/g, '\u0002')];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\u0001') { pasteBuffer = ''; continue; }
    if (ch === '\u0002') { typed += pasteBuffer || ''; pasteBuffer = null; continue; }
    if (pasteBuffer !== null) { pasteBuffer += ch; continue; }
    if (ch === '\x1b') { typed = ''; prompt(); continue; }
    if (ch === '\r' || ch === '\n') {
      const line = typed.trim(); typed = '';
      // 同一段输入里 /model 回车后面紧跟的方向键和回车交给菜单处理（Hub 会把连续敲的键合成一段写进来）。
      if (line === '/model') {
        if (menuSelect) { menuOpen = true; menuCursor = 0; drawMenu(); if (i + 1 < text.length) handleKeys(text.slice(i + 1).join('')); return; }
        menu();
      } else { if (line) answer(line); prompt(); }
    } else if (ch === '\x7f' || ch === '\b') typed = typed.slice(0, -1);
    else if (ch >= ' ') typed += ch;
  }
}
if (answerModelFile) process.stdin.on('data', handleKeys);
else process.stdin.on('data', chunk => {
  const text = chunk.toString('utf8');
  if (text.includes('\x1b')) { typed = ''; prompt(); return; }
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') { if (/\/model\s*$/.test(typed)) menu(); else prompt(); typed = ''; }
    else typed += ch;
  }
});
setInterval(() => {}, 1 << 30);

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
    if (hook.type !== 'command' || !hook.command) continue;
    const r = spawnSync(hook.command, { input: payload, shell: true, timeout: 10000, windowsHide: true, env: process.env });
    if (log) fs.appendFileSync(log, JSON.stringify({ at: Date.now(), hook: name, status: r.status, hubSession: process.env.CLAUDE_HUB_SESSION_ID || null }) + '\n');
  }
}
if (!isProbe) fireHook('SessionStart', 'session-start');

function accountModels() {
  let accountId = '';
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'));
    const entry = Object.values(raw).find(v => v && typeof v === 'object');
    accountId = String(entry && entry.accountId || '');
  } catch { /* 没登录 */ }
  return /^z/i.test(accountId) ? ['deepseek-v4-flash-0731'] : ['GLM-5.2-WX-Auto'];
}
// serve 模式（2026-10-30，Hub 先经 serve 读模型清单）：交给假 serve（codeagent-serve-fake），清单和 /model 菜单一致；
// CODEAGENT_POOL_FAKE_NO_SERVE=1 时像老版本 CodeAgent 一样不认 serve（立即退出），用来测回落读屏。
if (args[0] === 'serve') {
  if (process.env.CODEAGENT_POOL_FAKE_NO_SERVE === '1') { process.stderr.write('Unknown command: serve\n'); process.exit(2); }
  const models = Object.fromEntries(accountModels().map(id => [id, { id, display_name: id, max_context_tokens: 202752, originCoefficient: '1x', isIdle: false, load: 'low' }]));
  const file = path.join(require('os').tmpdir(), `codeagent-pool-fake-providers-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'w3', status: 'available', models }], busyIdleDefinition: { discount_status: '闲时2折进行中' },
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
  const models = accountModels();
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
process.stdin.on('data', chunk => {
  const text = chunk.toString('utf8');
  if (text.includes('\x1b')) { typed = ''; prompt(); return; }
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') { if (/\/model\s*$/.test(typed)) menu(); else prompt(); typed = ''; }
    else typed += ch;
  }
});
setInterval(() => {}, 1 << 30);

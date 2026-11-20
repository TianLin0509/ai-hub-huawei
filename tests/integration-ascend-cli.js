'use strict';
// API 网关体检集成（2026-11-20）：假网关 + 真实本机反代 + 真实 CLI，用 Hub 给会话的同一套启动参数走一遍
//   「填 key → 体检 → 选模型 → 发一句」：
//   1 core/api-gateway.save（填 key，读目录推分组、去掉非对话模型）→ healthcheck（能力表、首字时间）；
//   2 起本机反代（server.mjs，环境变量同 main/company-proxy-service.js：模型表、默认模型、首字时间、分组）；
//   3 Codex：core/company-model-proxy.applyCodexEnv 生成的 CODEX_HOME（含按目录真实上下文写的模型目录）跑 `codex exec`；
//     Claude Code：applyClaudeEnv 生成的环境跑 `claude -p`；
//   4 选一个「不对 free 分组开放」的模型发一句，CLI 拿到人话报错、只发一次不重试。
// 不碰真实网关和真实 key；CLI 找不到就跳过那一项并在结果里写明。
//   node tests/integration-ascend-cli.js [--codex <codex.exe>] [--claude <claude 命令>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { startFakeAscend } = require('./helpers/fake-ascend-gateway');
const gateway = require('../core/api-gateway');
const proxy = require('../core/company-model-proxy');

const fakeSafe = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('enc:' + s), decryptString: b => String(b).replace(/^enc:/, '') };
const argOf = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ''; };

function which(names) {
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    for (const n of names) { const f = path.join(dir, n); if (dir && fs.existsSync(f)) return f; }
  }
  return '';
}
function run(file, args, { env, cwd, timeoutMs = 180000, input = '' }) {
  return new Promise(resolve => {
    const shell = /\.(cmd|bat)$/i.test(file);
    const child = spawn(file, args, { env, cwd, windowsHide: true, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill(); err += '\n[timeout]'; }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
    child.stdin.end(input);
  });
}

async function main() {
  const report = { at: new Date().toISOString(), steps: [], ok: false };
  const step = (name, ok, extra = {}) => { report.steps.push({ name, ok: !!ok, ...extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.note ? ' — ' + extra.note : ''}`); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ascend-cli-'));
  const dataDir = path.join(root, 'data'), work = path.join(root, 'work');
  fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  const gw = await startFakeAscend();
  let stopProxy = async () => {};
  try {
    // 1 填 key → 体检
    const saved = await gateway.save(dataDir, { baseURL: gw.baseURL, apiKey: gw.key }, { safeStorage: fakeSafe });
    step('填 key：保存成功，推出 free 分组，4 个对话模型', saved.ok && saved.group === 'free' && saved.models.length === 4, { note: `${saved.group} / ${saved.models?.join(',')}` });
    const hc = await gateway.healthcheck(dataDir, { safeStorage: fakeSafe });
    const rows = hc.health?.rows || [];
    step('体检：能力表 4 行，3 个能用、1 个分组无渠道', hc.ok && rows.length === 4 && rows.filter(r => r.ok).length === 3,
      { note: rows.map(r => `${r.id}:${r.ok ? `ok ${r.firstMs}ms tools=${r.tools} think=${r.thinking}` : r.error?.code}`).join(' | ') });

    // 2 本机反代（环境变量与 Hub 起反代时一致）
    const endpoint = proxy.ensureEndpoint(dataDir);
    const view = gateway.read(dataDir);
    const env = { AI_HUB_COMPANY_PROXY_KEY: endpoint.key, AI_HUB_API_GATEWAY_URL: view.baseURL, AI_HUB_API_GATEWAY_KEY: gw.key,
      AI_HUB_API_GATEWAY_MODELS: view.models.join(','), AI_HUB_API_GATEWAY_MODEL: view.model,
      AI_HUB_API_GATEWAY_FIRST_MS: JSON.stringify(gateway.firstTokenMs(dataDir)), AI_HUB_API_GATEWAY_GROUP: view.group };
    const { main: proxyMain } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'server.mjs')).href);
    const running = proxyMain(['--data-dir', dataDir, '--port', '0', '--mock-upstream'], { env });
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) { try { port = JSON.parse(fs.readFileSync(path.join(dataDir, 'company-model-proxy', 'proxy-state.json'), 'utf8')).port; } catch { await new Promise(r => setTimeout(r, 50)); } }
    proxy.setEndpointPort(dataDir, port);
    stopProxy = async () => { await fetch(`http://127.0.0.1:${port}/admin/shutdown`, { method: 'POST', headers: { authorization: 'Bearer ' + endpoint.key } }).catch(() => {}); await running.catch(() => {}); };
    step('本机反代已起', port > 0, { note: 'port ' + port });

    const baseEnv = { ...process.env };
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete baseEnv[k];

    // 3a Codex
    const codex = argOf('--codex') || which(['codex.exe', 'codex.cmd', 'codex']);
    if (!codex) step('Codex：本机没找到 codex，跳过', true, { skipped: true });
    else {
      const cenv = { ...baseEnv };
      proxy.applyCodexEnv(cenv, { dataDir, sessionId: 'itg-codex', model: 'deepseek-v4.1-flash', projectDir: work, gateway: true });
      const catalog = JSON.parse(fs.readFileSync(path.join(cenv.CODEX_HOME, 'company-model-catalog.json'), 'utf8'));
      const win = Object.fromEntries(catalog.models.map(m => [m.slug, m.context_window]));
      step('Codex 模型目录按网关目录写上下文：deepseek 256K、glm 取不到用 128000', win['deepseek-v4.1-flash'] === 256000 && win['glm-5.3-flash'] === 128000, { note: JSON.stringify(win) });
      const ask = await run(codex, ['exec', '--skip-git-repo-check', '-C', work, 'Reply with OK only.'], { env: cenv, cwd: work });
      step('Codex 选 deepseek-v4.1-flash 发一句：拿到回答', ask.code === 0 && /\bOK\b/.test(ask.out), { note: `exit ${ask.code}; ${(ask.out || ask.err).trim().slice(-200)}` });
      const seenBefore = gw.seen.length;
      const bad = await run(codex, ['exec', '--skip-git-repo-check', '-C', work, '-m', 'qwen3.8-27b', 'Reply with OK only.'], { env: cenv, cwd: work });
      const all = bad.out + bad.err;
      step('Codex 选分组不开放的 qwen3.8-27b：拿到「不对你的 free 分组开放」，只发一次', /free 分组开放/.test(all) && gw.seen.length - seenBefore === 1,
        { note: `exit ${bad.code}; sent ${gw.seen.length - seenBefore}; ${all.replace(/\s+/g, ' ').match(/(?:API 网关：|连不上网关)[^"}]{0,120}/)?.[0] || all.slice(-200)}` });
    }

    // 3b Claude Code
    const claude = argOf('--claude') || which(['claude.exe', 'claude.cmd', 'claude']);
    if (!claude) step('Claude Code：本机没找到 claude，跳过', true, { skipped: true });
    else {
      const cfg = path.join(root, 'claude-config'); fs.mkdirSync(cfg, { recursive: true });
      fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
      const aenv = { ...baseEnv, CLAUDE_CONFIG_DIR: cfg };
      const chosen = proxy.applyClaudeEnv(aenv, { dataDir, sessionId: 'itg-claude', model: 'glm-5.3-flash', gateway: true });
      const ask = await run(claude, ['-p', '--output-format', 'text', 'Reply with OK only.'], { env: aenv, cwd: work });
      step(`Claude Code 选 ${chosen} 发一句：拿到回答`, ask.code === 0 && /OK/.test(ask.out), { note: `exit ${ask.code}; ${(ask.out || ask.err).trim().slice(-200)}` });
      const benv = { ...baseEnv, CLAUDE_CONFIG_DIR: cfg };
      proxy.applyClaudeEnv(benv, { dataDir, sessionId: 'itg-claude2', model: 'qwen3.8-27b', gateway: true });
      const seenBefore = gw.seen.length;
      const bad = await run(claude, ['-p', '--output-format', 'text', 'Reply with OK only.'], { env: benv, cwd: work });
      const all = bad.out + bad.err;
      step('Claude Code 选 qwen3.8-27b：拿到「不对你的 free 分组开放」，没有自动重试', /free 分组开放/.test(all) && gw.seen.length - seenBefore <= 2,
        { note: `exit ${bad.code}; sent ${gw.seen.length - seenBefore}; ${all.replace(/\s+/g, ' ').match(/(?:API 网关：|连不上网关).{0,120}/)?.[0] || all.slice(-200)}` });
    }
    report.ok = report.steps.every(s => s.ok);
  } catch (error) {
    report.error = error.stack;
    console.error(error.stack);
  } finally {
    await stopProxy();
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
    const outDir = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/ascend-cli');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    fs.writeFileSync(path.join(outDir, `${stamp}-ascend-cli-integration-m3.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, passed: report.steps.filter(s => s.ok).length, total: report.steps.length }));
    if (!report.ok) process.exitCode = 1;
  }
}
main();

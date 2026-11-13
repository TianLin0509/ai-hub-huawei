'use strict';
// Company model proxy, real user path in an isolated Hub (hidden window, own data dir and CDP port):
//   Settings -> own API -> pick "company model" for Claude Code, Codex and DSH -> new session of each kind
//   -> ask it to read a file -> the answer shows up.
// The real Claude Code / Codex / DSH CLIs run; the proxy runs as Hub starts it, against the synthetic
// upstream (AI_HUB_COMPANY_PROXY_MOCK=1). No company network, no real credentials.
//   node tests/e2e-company-model-proxy-cdp.js            (artifacts: HUB_E2E_ARTIFACT_DIR or artifacts/company-model-proxy)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/company-model-proxy');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const report = { ok: false, checks: [], screenshots: [], sessions: {}, mockUpstream: true };
const KINDS = [
  { ui: 'claude', api: 'claude', label: 'Claude Code', model: 'GLM-5.2-WX', marker: 'CLAUDE_MARKER_7Q2' },
  { ui: 'codex', api: 'codex', label: 'Codex', model: 'deepseek-v4.1-flash-1017', marker: 'CODEX_MARKER_4K9' },
  { ui: 'deepseek', api: 'deepseek-acp', label: 'DSH', model: 'GLM-5.2-WX', marker: 'DSH_MARKER_8M1' },
].filter(k => !process.env.E2E_KINDS || process.env.E2E_KINDS.split(',').includes(k.ui));

function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  }); });
}
function whichDir(name) {
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    for (const ext of ['.exe', '.cmd', '']) { if (dir && fs.existsSync(path.join(dir, name + ext))) return dir; }
  }
  return null;
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-proxy-'));
  report.root = root;
  const home = path.join(root, 'home'), data = path.join(root, 'data'), claudeDir = path.join(root, 'claude'), files = path.join(root, 'files');
  for (const dir of [home, data, claudeDir, files, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  // Claude Code first-run screens are not what this test is about.
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
  for (const k of KINDS) fs.writeFileSync(path.join(files, `note-${k.ui}.txt`), `This file belongs to the ${k.label} check.\n${k.marker}\n`);
  // Two pool accounts (synthetic logins in mock mode) plus the personal account.
  // A third account only has DeepSeek: GLM sessions must never be sent to it.
  const POOL = ['aaaaaa1', 'bbbbbb2'], DS_ONLY = 'dsonly3';
  fs.mkdirSync(path.join(data, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(data, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [...POOL, DS_ONLY].map(id => ({ id, label: 'Pool ' + id })) }));
  const writeModels = (id, models) => {
    const dir = path.join(data, 'codeagent-pool', 'accounts', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hub-models.json'), JSON.stringify({ models, defaultModel: models[0], at: new Date().toISOString(), source: 'serve' }));
  };
  for (const id of POOL) writeModels(id, ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017']);
  writeModels(DS_ONLY, ['deepseek-v4.1-flash-1017']);
  fs.writeFileSync(path.join(files, 'note-fallback.txt'), 'Pool exhausted check.\nFALLBACK_MARKER_3Z5\n');
  // 侧栏额度（2026-11-12）：每个号先放一份读数，GLM 今日用 11%、DeepSeek 用 37%，用来核对反代会话显示的是哪个模型。
  const usageMenu = require('../core/codeagent-usage-menu');
  const glmRow = { name: 'GLM-5.2-WX-Auto', day: { used: '11M', total: '100M', pct: 11 }, hour: { pct: 1 }, min: { pct: 1 } };
  const dsRow = { name: 'DeepSeek-V4.1-Flash-1017', day: { used: '37M', total: '100M', pct: 37 }, hour: { pct: 2 }, min: { pct: 2 } };
  // 只有 DeepSeek 权限的号，菜单里也只有 DeepSeek 一行（和真机一致）。
  for (const id of [...POOL, DS_ONLY, 'personal']) {
    usageMenu.recordUsage(data, id, { models: id === DS_ONLY ? [dsRow] : [glmRow, dsRow], modelsRead: { status: 'ok' } }, { label: id, source: 'serve' });
  }
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const cliDirs = ['claude', 'codex', 'node'].map(whichDir);
  assert.ok(cliDirs.every(Boolean), 'claude, codex and node must be installed for this end-to-end test');
  const dshRoot = process.env.AI_HUB_DSH_CLI_ROOT || (() => {
    try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'hub-cli-runtime.json'), 'utf8')).root; } catch { return ''; }
  })();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: claudeDir,
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
    AI_HUB_COMPANY_PROXY_MOCK: '1', AI_HUB_DSH_CLI_ROOT: dshRoot,
    [pathKey]: [...new Set(cliDirs), system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'),
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '',
    HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '',
    // Simulate the company machine: a system proxy that must not swallow loopback traffic.
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
  let hub, cdp;
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(150); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
    const point = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    await sleep(250);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = `${stamp}-proxy-${name}-claude.png`;
    fs.writeFileSync(path.join(out, file), Buffer.from(image.data, 'base64'));
    report.screenshots.push(path.join(out, file));
  }
  async function proxyStatus() {
    const endpoint = JSON.parse(fs.readFileSync(path.join(data, 'company-model-proxy', 'endpoint.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/admin/status`, { headers: { authorization: `Bearer ${endpoint.key}` } });
    return response.json();
  }
  // E2E_MOCK_DEEPSEEK_NO_THINKING=1: the synthetic upstream answers like real DeepSeek without thinking
  // (no reasoning, a short text before the tool call, spaced tool arguments) - company Q-1106-04 r7.
  const dsNoThinking = process.env.E2E_MOCK_DEEPSEEK_NO_THINKING === '1';
  report.deepseekNoThinking = dsNoThinking;
  // E2E_MOCK_LINGER_MS=n: the synthetic upstream keeps each stream open n ms after [DONE], like the real one.
  // DSH (pi-ai) closes the connection right after [DONE]; that must not be logged as aborted or failed (company v4).
  const lingerMs = Number(process.env.E2E_MOCK_LINGER_MS) || 0;
  report.lingerAfterDoneMs = lingerMs;
  if (dsNoThinking || lingerMs) {
    fs.mkdirSync(path.join(data, 'company-model-proxy'), { recursive: true });
    fs.writeFileSync(path.join(data, 'company-model-proxy', 'mock-control.json'), JSON.stringify({ ...(dsNoThinking ? { deepseekNoThinking: true } : {}), ...(lingerMs ? { lingerAfterDoneMs: lingerMs } : {}) }));
  }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'company-model-proxy', windowMode: 'hidden', extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!window.__companyApiOpen && !!window.WorkspaceController', 'renderer ready');

    // 1. Settings -> own API -> company model, per tool.
    await click('#btn-options'); await click('#options-settings');
    await until('!document.getElementById("config-modal").classList.contains("hidden")', 'settings');
    await click('#company-api-settings-open');
    await until('!!document.querySelector("#company-api-dialog [data-api-mode]")', 'API dialog');
    for (const k of KINDS) {
      await click(`[data-api-kind="${k.api}"]`);
      await click('[data-api-mode="proxy"]');
      await until('!!document.querySelector("#company-api-dialog [data-proxy-form]")', 'proxy form ' + k.api);
      check(`${k.label}：公司模型下拉里有两个模型`, await cdp.eval(`[...document.querySelectorAll('#company-api-dialog [name=model] option')].map(o=>o.value).join()==='GLM-5.2-WX,deepseek-v4.1-flash-1017'`));
      await cdp.eval(`(()=>{const s=document.querySelector('#company-api-dialog [name=model]');s.value=${JSON.stringify(k.model)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await click('#company-api-dialog [type="submit"]');
      await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.startsWith("已保存")', 'save ' + k.api);
    }
    await until('document.querySelector("#company-api-dialog [data-proxy-state]")?.dataset.proxyState === "running"', 'proxy running shown in dialog', 30000);
    check('设置弹窗显示「反代运行中」', await cdp.eval('document.getElementById("company-api-dialog").innerText.includes("反代运行中")'));
    await shot('settings-running-1440');
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check('所选工具的公司模型设置已落盘', KINDS.every(k => (k.api === 'deepseek-acp' ? saved.acp?.companyApi : saved.providers?.[k.api])?.backend === 'proxy'));
    const status0 = await proxyStatus();
    check('反代由 Hub 后台启动、模拟上游就绪', status0.ready === true && status0.mock === true);
    report.proxyPid = status0.pid;
    await click('.company-api-close');
    await cdp.eval('document.querySelector("#config-modal .config-close, #config-modal [data-close], #cfg-close")?.click()');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

    // 2. New session of each kind -> read a file -> answer.
    for (const k of KINDS) {
      await click('#btn-new');
      await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center');
      await until(`document.querySelector('.new-session-option[data-kind="${k.ui}"]')?.dataset.installed === '1'`, k.ui + ' detected', 30000);
      await click(`.new-session-option[data-kind="${k.ui}"]`);
      await until(`document.querySelector('#new-session-model')?.value === ${JSON.stringify(k.model)}`, k.ui + ' model preselected', 20000);
      await until(`document.querySelectorAll('#new-session-model-cards .session-model-card[data-source=company]').length === 2`, k.ui + ' model cards', 20000).catch(() => {});
      check(`${k.label}：启动中心的模型卡两个公司模型都能选`, await cdp.eval(`[...document.querySelectorAll('#new-session-model-cards .session-model-card[data-source=company]')].map(o=>o.dataset.modelCard).sort().join()==='GLM-5.2-WX,deepseek-v4.1-flash-1017'`));
      await shot(`launch-${k.ui}-1440`);
      const before = await cdp.eval('[...document.querySelectorAll("[data-session-id]")].map(e=>e.dataset.sessionId)');
      await click('#new-session-submit');
      await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', k.ui + ' session created', 60000);
      const id = await cdp.eval('window.activeSessionId || (typeof activeSessionId!=="undefined" ? activeSessionId : null)');
      report.sessions[k.ui] = { id, before: before.length };
      await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, k.ui + ' composer visible', 60000);
      // Let the CLI finish booting before typing.
      await sleep(k.ui === 'deepseek' ? 8000 : 6000);
      const file = path.join(files, `note-${k.ui}.txt`);
      await click('#terminal-panel .floating-input-box');
      await cdp.send('Input.insertText', { text: `请读取文件 ${file} ，告诉我里面的标记。` });
      await click('#terminal-panel .floating-input-send');
      const deadline = Date.now() + 120000;
      let seen = false;
      while (Date.now() < deadline) {
        seen = await cdp.eval(`document.body.innerText.includes(${JSON.stringify('MOCK_FINAL: ' + k.marker)})`).catch(() => false);
        if (seen) break;
        await sleep(1000);
      }
      const status = await proxyStatus();
      report.sessions[k.ui].proxy = { byKind: status.stats.byKind, upstream: status.mockUpstream, accounts: status.router?.accounts };
      await shot(`answer-${k.ui}-1440`);
      check(`${k.label}：界面上看到读文件后的回答（${k.marker}）`, seen);
      // 侧栏额度：这个会话实际用的号那一行，按会话的模型显示（DeepSeek 剩 63%、GLM 剩 89%），不是号的默认模型。
      const assigned = status.router?.assignments?.[String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)] || '';
      const wantName = /deepseek/i.test(k.model) ? 'DeepSeek-V4.1-Flash-1017' : 'GLM-5.2-WX-Auto';
      const quotaExpr = `(async()=>{const p=window.codeagentQuotaPanel;if(!p)return null;await p.reload?.();const v=p.view();return (v.rows||[]).map(r=>({id:r.id,current:r.current,model:r.token&&r.token.name,pct:r.token&&r.token.pct}));})()`;
      let quotaRows = null;
      const quotaEnd = Date.now() + 20000;
      while (Date.now() < quotaEnd) {
        quotaRows = await cdp.eval(quotaExpr).catch(() => null);
        if (quotaRows && quotaRows.some(r => r.current && r.model === wantName)) break;
        await sleep(1000);
      }
      report.sessions[k.ui].quota = { assigned, rows: quotaRows };
      const currentRow = (quotaRows || []).find(r => r.current);
      check(`${k.label}：侧栏额度标出这个会话用的号（${assigned || '未分配'}），并显示 ${wantName} 的额度`,
        !!assigned && currentRow?.id === assigned && currentRow.model === wantName && currentRow.pct === (wantName.startsWith('DeepSeek') ? 63 : 89));
      check(`${k.label}：其他号仍显示各自默认模型的额度`, (quotaRows || []).filter(r => !r.current && r.model).every(r => r.model === (r.id === DS_ONLY ? 'DeepSeek-V4.1-Flash-1017' : 'GLM-5.2-WX-Auto')));
    }
    const final = await proxyStatus();
    report.finalProxy = { stats: final.stats, upstream: final.mockUpstream };
    check('三个客户端都经反代发出请求，并做了读文件工具调用', KINDS.every(k => final.stats.byKind[k.ui === 'deepseek' ? 'dsh' : k.ui] > 0) && final.mockUpstream.toolCalls >= KINDS.length && final.mockUpstream.finals >= KINDS.length);
    if (!dsNoThinking) check('思考内容回放正常（工具调用后的请求带回 reasoning）', final.mockUpstream.reasoningMissing === 0);
    check('发给上游的对话历史合法（每条工具结果都紧跟它的调用）', final.mockUpstream.historyErrors === 0);
    const used = Object.keys(final.mockUpstream.byToken);
    check('会话分到号池账号（个人号留作兜底）', used.every(t => [...POOL, DS_ONLY].some(id => t === 'mock-token-' + id)));
    const proxyLog = () => { try { return fs.readFileSync(path.join(data, 'diagnostics', 'company-model-proxy.log'), 'utf8'); } catch { return ''; } };
    report.proxyAbortedOrFailed = (proxyLog().match(/proxy event request_(aborted|failed)/g) || []).length;
    check('完整回答没有被记成中止或失败（客户端读完 [DONE] 就断开也算正常结束）', report.proxyAbortedOrFailed === 0 && final.stats.failed === 0);
    check('GLM 会话从不派给只有 DeepSeek 权限的号', /GLM-5\.2-WX -> HTTP \d+ via /.test(proxyLog()) && !new RegExp(`GLM-5\\.2-WX -> HTTP \\d+ via ${DS_ONLY}`).test(proxyLog()));

    // 3. Pool exhausted: both pool accounts answer 429 -> the session falls back to the personal account, with a notice.
    if (KINDS.some(k => k.ui === 'claude')) {
      fs.writeFileSync(path.join(data, 'company-model-proxy', 'mock-control.json'), JSON.stringify({ rateLimitedTokens: POOL.map(id => 'mock-token-' + id) }));
      await click('#btn-new');
      await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center (fallback)');
      await click('.new-session-option[data-kind="claude"]');
      await until('document.querySelector("#new-session-model")?.value === "GLM-5.2-WX"', 'claude model (fallback)', 20000);
      await click('#new-session-submit');
      await until('getComputedStyle(document.getElementById("new-session-menu")).display === "none"', 'fallback session created', 60000);
      await until(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'fallback composer', 60000);
      await sleep(6000);
      await click('#terminal-panel .floating-input-box');
      await cdp.send('Input.insertText', { text: `请读取文件 ${path.join(files, 'note-fallback.txt')} ，告诉我里面的标记。` });
      await click('#terminal-panel .floating-input-send');
      // Sticky notice: stays until the user closes it.
      const noticeVisible = 'Array.from(document.querySelectorAll("#hub-sticky-notices .hub-sticky-notice")).some(n => n.offsetParent !== null && n.textContent.includes("个人 CodeAgent 账号"))';
      let toast = false;
      const end = Date.now() + 60000;
      while (Date.now() < end && !toast) {
        toast = await cdp.eval(noticeVisible).catch(() => false);
        if (!toast) await sleep(300);
      }
      await shot('pool-fallback-notice-1440');
      check('号池都限流时界面提示「已改用个人账号」（常驻提示条）', toast);
      await sleep(9000);
      check('换号提示 9 秒后仍在（不再 2.6 秒自动消失）', await cdp.eval(noticeVisible).catch(() => false));
      await cdp.eval('Array.from(document.querySelectorAll("#hub-sticky-notices .hub-sticky-notice")).filter(n => n.textContent.includes("个人 CodeAgent 账号")).forEach(n => n.querySelector(".hub-sticky-notice-close").click())');
      await sleep(300);
      check('点「知道了」后提示条关闭', !(await cdp.eval(noticeVisible).catch(() => true)));
      const endAnswer = Date.now() + 90000;
      let answered = false;
      while (Date.now() < endAnswer && !answered) { answered = await cdp.eval('document.body.innerText.includes("MOCK_FINAL: FALLBACK_MARKER_3Z5")').catch(() => false); if (!answered) await sleep(1000); }
      await shot('pool-fallback-answer-1440');
      check('号池都限流时会话仍由个人账号答完', answered);
      const st = await proxyStatus();
      report.fallbackProxy = { events: st.router.events, accounts: st.router.accounts, byToken: st.mockUpstream.byToken, rateLimited: st.mockUpstream.rateLimited };
      check('两个号池账号都被标记限流冷却，并记录退回个人号', POOL.every(id => st.router.events.some(e => e.type === 'rate_limited' && e.account === id))
        && st.router.events.some(e => e.type === 'fallback_personal') && st.mockUpstream.byToken['mock-token-personal'] > 0);
      // 2026-11-12：限流只冷却「号 + 模型」，不再把整个号写进账号页的避让记录（号的 DeepSeek 照常可用）。
      let avoid = {};
      try { avoid = JSON.parse(fs.readFileSync(path.join(data, 'codeagent-pool', 'quota-avoid.json'), 'utf8')); } catch { avoid = {}; }
      check('限流只冷却这个号的 GLM：整号不进避让记录，反代状态里记的是 GLM-5.2-WX', POOL.every(id => !avoid.accounts?.[id]
        && st.router.accounts.find(a => a.id === id)?.rateLimitedModels?.some(x => x.model === 'GLM-5.2-WX')));
      const usageNow = usageMenu.readUsage(data);
      check('反代成功的请求把用到的号标成「额度待刷新」', Object.values(usageNow).some(e => (e.dirtyVersion || 0) > (e.cleanVersion || 0)));
    }
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      fs.writeFileSync(path.join(out, `${stamp}-proxy-hub-claude.log`), hub.log().join('\n'));
      try { report.exit = await gracefulQuit(hub); }
      catch (error) { report.teardownError = error.stack; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
      try { fs.copyFileSync(path.join(data, 'diagnostics', 'company-model-proxy.log'), path.join(out, `${stamp}-proxy-process-claude.log`)); } catch { /* not started */ }
      if (report.proxyPid) {
        // The proxy follows Hub out: graceful shutdown first, parent watch / kill as fallback.
        const end = Date.now() + 8000;
        const alive = () => { try { process.kill(report.proxyPid, 0); return true; } catch { return false; } };
        while (alive() && Date.now() < end) await sleep(200);
        report.proxyStoppedWithHub = !alive();
        report.proxyStateFileRemoved = !fs.existsSync(path.join(data, 'company-model-proxy', 'proxy-state.json'));
      }
    }
    report.ok = !!report.uiChecksPassed && report.proxyStoppedWithHub === true && report.exit?.exitCode === 0 && !report.exit.forced && !report.teardownError;
    fs.writeFileSync(path.join(out, `${stamp}-proxy-e2e-result-claude.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, screenshots: report.screenshots.length, exit: report.exit, error: report.error || report.teardownError }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });

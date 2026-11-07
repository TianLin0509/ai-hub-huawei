'use strict';
// Two isolated Hub processes; real UI, gateway, local proxy and protocol converters; synthetic upstream/accounts.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pool = require('../core/lan-pool');
const model = pool.MODEL_IDS[0];
const realCli = process.env.LAN_E2E_REAL_CLI === '1';
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/20261107-lan-pool-codex');
const result = { ok: false, mockUpstream: true, twoRealHubProcesses: true, realCli, checks: [], screenshots: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(cdp, expression, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; if (label.endsWith('readback') && await cdp.eval('document.body.innerText.includes("issue with the selected model")').catch(() => false)) throw new Error(label + ': CLI rejected the shared model'); await sleep(200); } throw new Error('Timeout: ' + label); }
async function click(cdp, selector) {
  const p = await cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing '+${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); if(!r.width||!r.height)throw Error('Hidden control'); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
}
async function fill(cdp, selector, value) { await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lan-pool-e2e-')); result.isolatedRoot = root;
  const hostData = path.join(root, 'host/data'), clientData = path.join(root, 'client/data');
  fs.mkdirSync(path.join(hostData, 'codeagent-pool'), { recursive: true }); fs.mkdirSync(clientData, { recursive: true });
  const ids = ['pool001', 'pool002', 'pool003', 'pool004', 'pool005'];
  fs.writeFileSync(path.join(hostData, 'codeagent-pool/pool.json'), JSON.stringify({ accounts: ids.map((id, i) => ({ id, note: '主机备注' + (i + 1) })) }));
  for (const id of ids) {
    const dir = path.join(hostData, 'codeagent-pool/accounts', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ devUCOAuth: { accountId: id, xAuthToken: 'synthetic-only-' + id, xAuthExpires: Date.now() + 86400000 } }));
    fs.writeFileSync(path.join(dir, 'hub-models.json'), JSON.stringify({ models: pool.MODEL_IDS, defaultModel: model, at: new Date().toISOString(), source: 'serve' }));
    require('../core/codeagent-usage-menu').recordUsage(hostData, id, { models: [{ name: model, day: { pct: 10 + ids.indexOf(id) * 10, used: 10, total: 100 }, hour: { pct: 5 }, min: { pct: 2 } }] }, { source: 'serve' });
  }
  let host, client, hc, cc;
  const check = (label, condition) => { assert.ok(condition, label); result.checks.push(label); };
  const shot = async (cdp, label) => {
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' }); const name = '20261107-' + label + '.png';
    fs.writeFileSync(path.join(out, name), Buffer.from(png.data, 'base64')); result.screenshots.push(name);
  };
  async function launch(data, name) {
    const home = path.join(path.dirname(data), 'home'), claude = path.join(path.dirname(data), 'claude');
    for (const p of [home, claude, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', bypassPermissionsModeAccepted: true, numStartups: 5 }));
    const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: name, windowMode: 'hidden', extraEnv: {
      AI_HUB_COMPANY_PROXY_MOCK: '1', AI_HUB_CODEAGENT_CONFIG_DIR: path.join(path.dirname(data), 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
      HOME: home, USERPROFILE: home, CLAUDE_HUB_HOME_DIR: home, CLAUDE_CONFIG_DIR: claude,
      APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), CODEX_HOME: path.join(path.dirname(data), 'codex'),
      AI_HUB_WORKSPACE_ROOT: path.join(path.dirname(data), 'workspaces'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '',
    } });
    const cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(cdp, '!!window.__lanPoolOpen', 'shared settings loaded'); return [hub, cdp];
  }
  try {
    [host, hc] = await launch(hostData, 'lan-host'); [client, cc] = await launch(clientData, 'lan-client');
    result.pids = [host.pid, client.pid];
    await click(hc, '#btn-options'); await click(hc, '#options-settings'); await click(hc, '#lan-pool-settings-open');
    await click(hc, '[data-lan-tab="host"]'); const port = await freePort();
    await fill(hc, '[data-lan-host] [name=port]', port); await fill(hc, '[data-lan-host] [name=bindAddress]', '127.0.0.1'); await click(hc, '[data-lan-host] [type=submit]');
    await until(hc, 'document.querySelector("#lan-pool-dialog")?.innerText.includes("共享已开启")', 'host sharing enabled');
    await until(hc, '(async()=>{const s=await ipcRenderer.invoke("company-proxy:status");return s.proxy.state==="running";})()', 'local proxy ready');
    await fill(hc, '[data-lan-member] [name=name]', '测试同事甲'); await click(hc, '[data-lan-member] [type=submit]');
    await until(hc, '!!document.querySelector(".lp-secret-raw")', 'member generated');
    const secret = await hc.eval('document.querySelector(".lp-secret-raw").value');
    const invite = await hc.eval('document.querySelector("[data-lan-invite]").textContent');
    check('主机生成的一行连接信息同时含地址和口令', invite.includes(secret) && invite.includes('http://127.0.0.1:' + port));
    check('主机通过真实设置界面生成专属口令', /^[a-f0-9]{48}$/.test(secret));
    const memberId = pool.read(hostData).host.members[0].id;
    await fill(hc, '[data-lan-member] [name=name]', '测试同事乙'); await click(hc, '[data-lan-member] [type=submit]');
    await until(hc, 'document.querySelector(".lp-table")?.innerText.includes("测试同事乙")', 'second member');
    await shot(hc, '主机共享管理');
    await click(cc, '#btn-options'); await click(cc, '#options-settings'); await click(cc, '#lan-pool-settings-open');
    await shot(cc, '同事未连接引导');
    const address = 'http://127.0.0.1:' + port;
    await fill(cc, '[data-lan-connect] [name=address]', invite);
    check('粘贴整行连接信息后自动拆出地址和口令', await cc.eval(`document.querySelector('[data-lan-connect] [name=address]').value === ${JSON.stringify(address)} && document.querySelector('[data-lan-connect] [name=key]').value === ${JSON.stringify(secret)}`));
    await click(cc, '[data-lan-connect] [type=submit]');
    await until(cc, 'document.querySelector("#lan-pool-dialog [role=status]")?.textContent.startsWith("已连接")', 'client connected');
    await until(cc, '!!document.querySelector("[data-lan-client-state=online]")', 'client online card');
    await shot(cc, '同事已连接');
    check('同事无 CodeAgent 凭据也可连接', !fs.existsSync(path.join(root, 'client/codeagent/.credentials.json')));
    const snapshot = await cc.eval('ipcRenderer.invoke("codeagent:quota-panel")');
    check('右侧栏真实 IPC 返回主机五个号的额度', snapshot.shared && snapshot.rows.length === 5 && snapshot.rows[0].usage.models[0].day.pct === 10);
    check('额度接口没有主机账号标识或备注', !JSON.stringify(snapshot).includes('pool001') && !JSON.stringify(snapshot).includes('主机备注'));
    await click(cc, '.company-api-close');
    await cc.eval('window.__companyApiOpen("claude")');
    await until(cc, '!!document.querySelector("#company-api-dialog [data-proxy-form]")', 'shared API configuration');
    check('自有 API 设置正确显示共享主机状态', await cc.eval('document.getElementById("company-api-dialog").innerText.includes("共享主机已连接")'));
    check('同事端无需选择公司区域或读取本机凭据', await cc.eval('!document.querySelector("#company-api-dialog [data-proxy-zone-select]")'));
    await click(cc, '#company-api-dialog .company-api-close');
    await cc.eval('window.codeagentQuotaPanel.reload().then(()=>window.codeagentQuotaPanel.render())');
    const collapsed = await cc.eval('window.codeagentQuotaPanel.getState().collapsed'); if (collapsed) await click(cc, '[data-qp-action=expand]');
    await until(cc, 'document.getElementById("account-quota-panel").innerText.includes("90%")', 'quota values rendered');
    await shot(cc, '同事右侧共享额度');
    await click(cc, '#btn-new');
    await until(cc, 'document.getElementById("lan-pool-launch-summary").innerText.includes("90% 剩余")', 'launch quota summary');
    check('启动中心状态条显示共享号池可用数', await cc.eval('document.getElementById("lan-pool-launch-summary").innerText.includes("共享号池 · 5/5 可用")'));
    check('启动摘要和启动参数跟随已选共享模型卡', await cc.eval('(() => {const card=document.querySelector("#new-session-model-cards [aria-checked=true]");const summary=document.getElementById("new-session-summary").innerText;return card?.dataset.source==="company" && document.getElementById("new-session-model").value===card.dataset.modelCard && summary.includes(card.dataset.modelCard) && summary.includes("共享号池") && !summary.includes("沿用本机");})()'));
    await shot(cc, '同事启动中心额度');
    if (realCli) {
      const files = path.join(root, 'client/files'); fs.mkdirSync(files, { recursive: true });
      for (const kind of ['claude', 'codex']) {
        const marker = kind.toUpperCase() + '_LAN_READBACK_9Q7'; const file = path.join(files, '20261107-' + kind + '-readback.txt');
        fs.writeFileSync(file, 'Read this local file through the real CLI tool.\n' + marker + '\n');
        await until(cc, 'getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch open');
        await until(cc, `document.querySelector('.new-session-option[data-kind="${kind}"]')?.dataset.installed === '1'`, kind + ' installed');
        await click(cc, `.new-session-option[data-kind="${kind}"]`);
        await until(cc, `document.getElementById('new-session-model').value === ${JSON.stringify(model)}`, kind + ' shared model selected');
        await click(cc, '#new-session-submit');
        await until(cc, 'getComputedStyle(document.getElementById("new-session-menu")).display === "none"', kind + ' created', 60000);
        await until(cc, '!!document.querySelector("#terminal-panel .floating-input-box")?.offsetParent', kind + ' composer', 60000);
        await sleep(6000);
        await click(cc, '#terminal-panel .floating-input-box');
        await cc.send('Input.insertText', { text: `请读取文件 ${file} ，告诉我里面的标记。` });
        await click(cc, '#terminal-panel .floating-input-send');
        await until(cc, `document.body.innerText.includes(${JSON.stringify(marker)})`, kind + ' readback', 120000);
        check(kind + ' 真实 CLI 经共享号池读文件并显示标记', true);
        await shot(cc, '真实-' + kind + '-共享读文件');
        await click(cc, '#btn-new');
      }
      const endpoint = JSON.parse(fs.readFileSync(path.join(hostData, 'company-model-proxy/endpoint.json'), 'utf8'));
      const proxy = await (await fetch('http://127.0.0.1:' + endpoint.port + '/admin/status', { headers: { authorization: 'Bearer ' + endpoint.key } })).json();
      check('真实 CLI 工具执行结果经过共享网关回传给模拟模型', proxy.mockUpstream.toolCalls >= 2 && proxy.mockUpstream.finals >= 2);
      check('工具历史和思考回放保持完整', proxy.mockUpstream.historyErrors === 0 && proxy.mockUpstream.reasoningMissing === 0);
    }
    for (const route of ['/v1/messages', '/v1/responses', '/v1/chat/completions']) {
      const body = route === '/v1/responses' ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply LAN_TEST' }] }], stream: true }
        : { model, messages: [{ role: 'user', content: 'Reply LAN_TEST' }], max_tokens: 64, stream: route !== '/v1/messages' };
      const response = await fetch(address + route, { method: 'POST', headers: { authorization: 'Bearer ' + secret + '.client-session', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await response.text(); check('共享网关与真实转换器通过 ' + route, response.status === 200 && text.length > 30);
    }
    require('../core/codeagent-usage-menu').recordUsage(hostData, ids[0], { models: [{ name: model, day: { pct: 55 } }] }, { source: 'serve' });
    const after = await cc.eval('ipcRenderer.invoke("codeagent:quota-panel",{refresh:true})');
    check('手动刷新能同步主机新读数', after.rows[0].usage.models[0].day.pct === 55);
    // 账号页：主机看到同事和用量，同事看到共享号额度。
    await cc.eval('document.getElementById("new-session-menu").style.display="none"');
    await hc.eval('document.querySelector("#lan-pool-dialog")?.close()');
    for (const cdp of [hc, cc]) await cdp.eval('document.getElementById("btn-rail-accounts").click()');
    await until(hc, '(t => t.includes("测试同事甲") && t.includes("3 次"))(document.querySelector("[data-lan-account-slot] .lp-card")?.innerText || "")', 'host account card with usage');
    check('主机账号页显示内网共享和同事用量', await hc.eval('(t => t.includes("内网共享") && t.includes("正在共享") && t.includes("2 位同事"))(document.querySelector("[data-lan-account-slot]").innerText)'));
    await shot(hc, '主机账号页');
    await until(cc, '(document.querySelector("[data-lan-account-slot] .lp-card")?.querySelectorAll(".lp-quota li").length || 0) === 5', 'client account card');
    check('同事账号页显示共享号池逐号额度', await cc.eval('document.querySelector("[data-lan-account-slot]").innerText.includes("45% 剩余")'));
    await shot(cc, '同事账号页');
    // 号池视图（成员版专属）：主机从账号页卡片打开，看到同事在线、今天用量和事件。
    check('主机账号页卡片有号池视图入口', await hc.eval(`!!document.querySelector('[data-lan-account-slot] [data-lan-card="dashboard"]')`));
    await click(hc, '[data-lan-account-slot] [data-lan-card="dashboard"]');
    await until(hc, '(t => t.includes("测试同事甲") && t.includes("在线同事"))(document.querySelector("#lan-pool-dashboard .pd-body")?.innerText || "")', 'pool dashboard');
    check('号池视图显示同事在线', await hc.eval('(r => !!r && /在线|使用中/.test(r.innerText))([...document.querySelectorAll("#lan-pool-dashboard .pd-row")].find(r => r.innerText.includes("测试同事甲")))'));
    check('号池视图显示今天请求数与事件', await hc.eval('(() => { const d = document.querySelector("#lan-pool-dashboard"); const row = [...d.querySelectorAll(".pd-row")].find(r => r.innerText.includes("测试同事甲")); return Number(row.querySelector("td:nth-child(5) b").textContent) >= 3 && d.querySelector(".pd-events").innerText.includes("上线"); })()'));
    check('号池视图显示主机各号额度', await hc.eval('document.querySelectorAll("#lan-pool-dashboard .lp-quota li").length === 5'));
    await shot(hc, '主机号池视图');
    await hc.eval('[...document.querySelectorAll("#lan-pool-dashboard .pd-row")].find(r => r.innerText.includes("测试同事甲")).click()');
    await until(hc, '!!document.querySelector("#lan-pool-dashboard .pd-detail")', 'dashboard detail');
    check('点开同事看到按模型和按工具明细', await hc.eval('(t => t.includes("按模型") && t.includes("按工具"))(document.querySelector("#lan-pool-dashboard .pd-detail").innerText)'));
    await shot(hc, '主机号池视图-明细');
    check('号池视图在 1440 宽度不横向溢出', await hc.eval('(b => b.scrollWidth <= b.clientWidth + 1)(document.querySelector("#lan-pool-dashboard .pd-body"))'));
    await hc.eval('document.querySelector("#lan-pool-dashboard").close()');
    await hc.eval('window.__lanPoolOpen("host")');
    await until(hc, '!!document.querySelector(`[data-lan-revoke="' + memberId + '"]`)', 'host dialog reopened');
    await click(hc, `[data-lan-revoke="${memberId}"]`);
    check('撤销需要二次确认', await hc.eval(`!!document.querySelector('[data-lan-revoke="${memberId}"][data-confirmed]')`));
    await click(hc, `[data-lan-revoke="${memberId}"][data-confirmed]`);
    await until(hc, 'document.querySelector("#lan-pool-dialog").innerText.includes("已撤销")', 'member revoked');
    const revoked = await fetch(address + '/v1/models', { headers: { authorization: 'Bearer ' + secret } }); check('撤销后模型接口立即拒绝', revoked.status === 401);
    await hc.eval('document.querySelector("#lan-pool-dialog")?.close(); window.__lanPoolDashboardOpen()');
    await until(hc, '(document.querySelector("#lan-pool-dashboard .pd-events")?.innerText || "").includes("撤销")', 'dashboard revoke event');
    check('号池视图记下撤销事件', true);
    await hc.eval('document.querySelector("#lan-pool-dashboard").close()');
    await cc.eval('window.codeagentQuotaPanel.refresh()');
    check('同事侧提示口令已撤销并保留读数', await cc.eval('document.getElementById("account-quota-panel").innerText.includes("已撤销")'));
    await cc.eval('window.__lanPoolOpen("client")');
    await until(cc, '!!document.querySelector("[data-lan-client-state=revoked]")', 'client revoked card');
    await shot(cc, '同事口令撤销提示');
    const horizontal = await cc.eval('document.documentElement.scrollWidth>innerWidth'); check('1440 宽度无整页横向溢出', !horizontal);
    result.ok = true;
  } catch (error) {
    if (cc) {
      try { await shot(cc, '失败现场'); fs.writeFileSync(path.join(out, '20261107-lan-e2e-failure-text-codex.json'), JSON.stringify(await cc.eval('({text:document.body.innerText,sessions:typeof sessions!=="undefined"?[...sessions.values()].map(s=>({id:s.id,kind:s.kind,status:s.status})):[]})'), null, 2)); } catch { /* keep the first failure */ }
    }
    throw error;
  } finally {
    await hc?.close(); await cc?.close(); if (client) await gracefulQuit(client); if (host) await gracefulQuit(host);
  }
}
main().catch(error => { result.error = error.stack; process.exitCode = 1; }).finally(() => { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, '20261107-lan-pool-e2e-codex.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ok: result.ok, checks: result.checks.length, error: result.error, out })); });

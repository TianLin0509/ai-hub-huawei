'use strict';
// 本机 CLI 诊断界面 GUI 走查（2026-11-20，HUB-H 第一期 A 线界面）：隔离 Hub + 真实鼠标点击。
// 体检本身仍跑真实的 env-check:run，只把假结论挂到对应行的 extra.locate 上（和定位中心合入后的形状一致）。
// 系统选文件框无法用 CDP 点，harness:pick-path 直接返回「选中后试跑」的两种结果。复制只截获文本，不写系统剪贴板；反馈只截获内容，不真发。
// 用法：node tests/e2e-harness-diagnosis-cdp.js [--out <截图目录>]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : process.env.HUB_E2E_ARTIFACT_DIR || path.join(__dirname, '..', '.shots'));
const report = { ok: false, checks: [], screenshots: [], providerNetworkTested: false };
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-harness-ui-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  for (const dir of [home, data, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
    [pathKey]: [system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
  let hub, cdp;
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('✓', name); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(100); }
    throw new Error('等待超时：' + label);
  }
  async function click(selector) {
    const point = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('找不到 '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('看不见 '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    await sleep(250);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, `20261120-harness-ui-${name}.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.screenshots.push(file);
  }
  const noScroll = async sel => { const m = await cdp.eval(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); return e ? [e.scrollHeight, e.clientHeight] : null; })()`); (report.scroll = report.scroll || []).push(m); if (!(m && m[0] <= m[1] + 1)) await shot('body-overflow-' + report.scroll.length); return !!m && m[0] <= m[1] + 1; };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'harness-ui-m2', extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await until('!!window.__envCheck && !!window.__companyApiOpen && !!document.getElementById("options-env-check")', 'renderer ready', 60000);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.captureScreenshot', { format: 'png' });
    await until('window.innerWidth === 1440', 'viewport 1440');
    await cdp.eval(`(() => {
      const { ipcRenderer } = require('electron');
      const fake = require(${JSON.stringify(path.join(__dirname, 'fixtures', 'harness-locate-fake.js'))});
      const orig = ipcRenderer.invoke.bind(ipcRenderer);
      const st = window.__hxTest = { state: fake.results(), pick: 'fail', copied: [], sent: null, calls: [] };
      navigator.clipboard.writeText = async text => { st.copied.push(text); };
      ipcRenderer.invoke = async (ch, p) => {
        if (ch.startsWith('harness:')) st.calls.push(ch + (p && p.fresh ? ':fresh' : ''));
        if (ch === 'harness:peek-all' || ch === 'harness:locate-all') return st.state;
        if (ch === 'harness:locate') return st.state[p.id];
        if (ch === 'harness:pick-path') { const r = st.pick === 'ok' ? fake.pickOk(p.id) : fake.pickFail(p.id); if (st.pick === 'ok') st.state[p.id] = r; return r; }
        if (ch === 'harness:clear-path') return st.state[p.id];
        if (ch === 'harness:diagnosis') return { text: (p && p.ids ? p.ids : Object.keys(st.state)).map(id => id + '：' + st.state[id].reason + '\\n  查过 ' + st.state[id].checked.length + ' 处，%USERPROFILE%\\\\…').join('\\n') };
        if (ch === 'hub-feedback:send') { st.sent = p; return { ok: true, id: 'e2e-fixture', via: 'intranet' }; }
        if (ch === 'env-check:run') {
          const r = await orig(ch, p);
          for (const item of r.items || []) { const loc = st.state[item.id]; if (loc) { item.extra = { ...item.extra, locate: loc }; item.fixes = loc.fixes; item.cause = loc.reason; item.status = loc.verdict === 'ok' ? 'ok' : loc.verdict === 'broken' || loc.verdict === 'not-found' ? 'bad' : 'warn'; } }
          for (const id of ['pi', 'kimi']) if (!(r.items || []).some(i => i.id === id)) r.items.push({ id, name: st.state[id].label, status: 'bad', detail: st.state[id].reason, fixes: st.state[id].fixes, extra: { locate: st.state[id] } });
          return r;
        }
        return orig(ch, p);
      };
      return true;
    })()`);

    // 1. 启动中心徽标：五种结论各有说法，能用的不出徽标。
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center');
    await until('document.querySelector(".new-session-option[data-kind=codex]")?.dataset.harness === "too-old"', 'codex badge');
    const badges = await cdp.eval(`Object.fromEntries([...document.querySelectorAll('.new-session-option')].map(b => [b.dataset.kind, (b.querySelector('.company-cli-status')?.hidden ? '' : b.querySelector('.company-cli-status')?.textContent) || '']))`);
    report.badges = badges;
    check('启动中心：Codex 徽标「版本太低」', badges.codex === '版本太低');
    check('启动中心：Claude、DSH 能用，不出徽标', badges.claude === '' && badges.deepseek === '');
    if ('pi' in badges) check('启动中心：pi 徽标「未安装」', badges.pi === '未安装');
    check('打开启动中心时调了 harness:peek-all 和 harness:locate-all（不加 fresh）', await cdp.eval('window.__hxTest.calls.includes("harness:peek-all") && window.__hxTest.calls.includes("harness:locate-all")'));
    await shot('01-launch-badges');
    // harness:changed 到来时就地改徽标，不用重开。
    await cdp.eval(`require('electron').ipcRenderer.emit('harness:changed', {}, { id: 'codex', result: { ...window.__hxTest.state.codex, verdict: 'broken', reason: '试跑报错' } })`);
    await until('document.querySelector(".new-session-option[data-kind=codex] .company-cli-status")?.textContent === "跑不起来"', 'badge live update');
    check('收到 harness:changed，Codex 徽标就地变成「跑不起来」', true);
    await shot('02-launch-badge-live');
    // 点「跑不起来」的卡片：打开体检并展开这一项的结论卡，不弹「未安装」。
    await click('.new-session-option[data-kind=codex]');
    await until('document.getElementById("env-check-dialog")?.open && document.querySelector("#env-check-dialog [data-ec-id=codex].expanded")', 'focus codex card', 60000);
    check('点「跑不起来」的 Codex 卡：体检打开并展开 Codex 结论卡', !(await cdp.eval('!!document.getElementById("company-api-dialog")')));
    await shot('03-launch-click-broken-opens-card');
    await cdp.eval('document.getElementById("env-check-dialog").close()');
    await cdp.eval(`require('electron').ipcRenderer.emit('harness:changed', {}, { id: 'codex', result: window.__hxTest.state.codex })`);

    // 2. 体检：组件中心里的结论卡。
    await cdp.eval('document.getElementById("new-session-menu").style.display="none"');
    await cdp.eval('document.getElementById("options-env-check").click()');
    await until('document.getElementById("env-check-dialog")?.open', 'env-check open');
    await click('[data-ec-tab="components"]');
    await until('document.querySelector("#env-check-dialog [data-hx-verdict]")', 'locate rows', 90000);
    await until('!document.querySelector("#env-check-dialog [data-ec=rerun]").disabled', 'env-check done', 90000);
    const verdicts = await cdp.eval(`[...document.querySelectorAll('#env-check-dialog [data-hx-verdict]')].map(li => li.dataset.ecId + ':' + li.querySelector('.hx-verdict').textContent)`);
    report.componentRows = verdicts;
    check('组件中心：Claude「能用」、Codex「版本太低」、DSH「能用」、CodeAgent「暂时不可用」', ['claude:能用', 'codex:版本太低', 'dsh:能用', 'codeagent:暂时不可用'].every(v => verdicts.includes(v)));
    check('DSH 第二行写「找到 2 处，1 处能用」', await cdp.eval('/找到 2 处，1 处能用/.test(document.querySelector("#env-check-dialog [data-ec-id=dsh] .ec-detail").textContent)'));
    check('顶部有「复制全部诊断」', await cdp.eval('!document.querySelector("#env-check-dialog [data-ec=copy-diag]").hidden'));
    check('没有结论卡的行保持旧样式', await cdp.eval('[...document.querySelectorAll("#env-check-dialog .ec-item[data-ec-id]")].some(li => !li.dataset.hxVerdict && li.querySelector(".ec-state"))'));
    // 2026-11-21 返工第 4 条：体检本身每行已试跑，界面不再先跑 locate-all（启动中心那一次除外）。
    check('打开体检时不再额外调 harness:locate-all', await cdp.eval('window.__hxTest.calls.filter(c => c.startsWith("harness:locate-all")).length === 1'));
    await noScroll('#env-check-dialog .ec-body');
    check('结论卡收起时只占两行（结论+一句人话），不比旧行高', await cdp.eval('[...document.querySelectorAll("#env-check-dialog [data-hx-verdict]:not(.expanded) .ec-name, #env-check-dialog [data-hx-verdict]:not(.expanded) .ec-detail")].every(e => e.getBoundingClientRect().height <= 22)'));
    await shot('04-components-cards');
    // 展开 DSH：两个候选各自的结论，标出 Hub 将用哪一个；再展开查过的位置。
    await click('#env-check-dialog [data-ec-toggle="dsh"]');
    await until('document.querySelector("#env-check-dialog [data-hx-panel=dsh]")', 'dsh panel');
    check('DSH 展开后列 2 个候选，桌面版标「Hub 将用这个」', await cdp.eval('document.querySelectorAll("#env-check-dialog [data-hx-panel=dsh] .hx-cand").length === 2 && /DSH Desktop/.test(document.querySelector("#env-check-dialog .hx-chosen").textContent)'));
    await click('#env-check-dialog [data-hx-checked="dsh"]');
    await until('document.querySelectorAll("#env-check-dialog [data-hx-panel=dsh] .hx-checked li").length === 4', 'dsh checked');
    check('展开「查过的 4 处」逐条显示', true);
    await noScroll('#env-check-dialog .ec-body');
    await shot('05-dsh-expanded-checked');
    // 复制这一项的诊断。
    await click('#env-check-dialog [data-hx-act="copy"][data-hx-id="dsh"]');
    await until('window.__hxTest.copied.length === 1', 'copy dsh');
    check('卡片上「复制诊断」复制的是打码后的 DSH 诊断', await cdp.eval('/^dsh：/.test(window.__hxTest.copied[0]) && !/\\n(claude|pi)：/.test(window.__hxTest.copied[0]) && /%USERPROFILE%/.test(window.__hxTest.copied[0])'));
    check('复制后底部提示「已复制这一项的诊断」', await cdp.eval('/已复制这一项的诊断/.test(document.querySelector("#env-check-dialog [data-ec=msg]").textContent)'));
    await click('#env-check-dialog [data-ec="copy-diag"]');
    await until('window.__hxTest.copied.length === 2', 'copy all');
    check('顶部「复制全部诊断」包含全部 CLI', await cdp.eval('["claude","codex","dsh","pi","codeagent","kimi"].every(id => window.__hxTest.copied[1].includes(id + "："))'));
    await click('#env-check-dialog [data-ec-toggle="dsh"]');

    // 3. 环境明细：pi 没找到 → 选择文件，失败如实报、成功才生效。
    await click('[data-ec-tab="environment"]');
    await until('document.querySelector("#env-check-dialog [data-ec-id=pi]")', 'pi row');
    const piPick = await cdp.eval('(() => { const b=[...document.querySelectorAll("#env-check-dialog [data-ec-id=pi] [data-ec-fix]")].find(x => /选择文件/.test(x.textContent)); return b ? b.dataset.ecFix : ""; })()');
    check('pi 行有「我装在别处，选择文件」按钮', !!piPick);
    await click(`#env-check-dialog [data-ec-fix="${piPick}"]`);
    await until('/没用上你选的文件/.test(document.querySelector("#env-check-dialog [data-ec=msg]").textContent)', 'pick fail');
    check('选择失败：原样显示原因并说明原设置没变，pi 仍是「没找到」', await cdp.eval('/不是 pi.*原来的设置没有改动/.test(document.querySelector("#env-check-dialog [data-ec=msg]").textContent) && document.querySelector("#env-check-dialog [data-ec-id=pi]").dataset.hxVerdict === "not-found"'));
    await click('#env-check-dialog [data-ec-toggle="pi"]');
    await click('#env-check-dialog [data-hx-checked="pi"]');
    await until('document.querySelectorAll("#env-check-dialog [data-hx-panel=pi] .hx-checked li").length === 6', 'pi checked');
    await shot('06-pi-pick-failed-checked');
    await cdp.eval('window.__hxTest.pick = "ok"');
    await click(`#env-check-dialog [data-ec-fix="${piPick}"]`);
    await until('/已改用你选的文件/.test(document.querySelector("#env-check-dialog [data-ec=msg]").textContent)', 'pick ok');
    await until('document.querySelector("#env-check-dialog [data-ec-id=pi]")?.dataset.hxVerdict === "ok"', 'pi ok');
    check('选择成功：pi 变「能用」，来源是「你手动指定的」，并给可点的「改回自动查找」', await cdp.eval('/你手动指定的/.test(document.querySelector("#env-check-dialog [data-ec-id=pi] .hx-meta").textContent) && !document.querySelector("#env-check-dialog [data-hx-act=clear][data-hx-id=pi]").disabled'));
    await shot('07-pi-pick-ok');
    await noScroll('#env-check-dialog .ec-body');
    // 「重新体检」加 fresh。
    await until('!document.querySelector("#env-check-dialog [data-ec=rerun]").disabled', 'run after pick', 90000);
    await click('#env-check-dialog [data-ec="rerun"]');
    await sleep(300);
    await until('!document.querySelector("#env-check-dialog [data-ec=rerun]").disabled', 'rerun done', 90000);
    check('「重新体检」不再先调 harness:locate-all', await cdp.eval('!window.__hxTest.calls.includes("harness:locate-all:fresh")'));
    await cdp.eval('document.getElementById("env-check-dialog").close()');

    // 4. 一键反馈：附带内容里列出诊断，发送时接在描述后面。
    await cdp.eval('document.getElementById("options-feedback").click()');
    await until('/本机 CLI 识别诊断/.test(document.querySelector(".hub-feedback-dialog [data-hf=items]")?.textContent || "")', 'feedback items', 30000);
    check('一键反馈预览列出「本机 CLI 识别诊断（用户名已打码）」', true);
    await shot('08-feedback-with-diagnosis');
    await click('.hub-feedback-dialog [data-hf="desc"]');
    await cdp.send('Input.insertText', { text: 'DSH 新建会话打不开' });
    await click('.hub-feedback-dialog [data-hf="send"]');
    await until('!!window.__hxTest.sent', 'feedback sent');
    check('发送的描述 = 同事写的话 + 打码诊断', await cdp.eval('window.__hxTest.sent.description.startsWith("DSH 新建会话打不开\\n\\n## 本机 CLI 识别诊断（已打码）\\n") && /dsh：/.test(window.__hxTest.sent.description)'));
    report.ok = true;
  } finally {
    report.root = root;
    fs.writeFileSync(path.join(out, '20261120-harness-ui-report.json'), JSON.stringify(report, null, 2));
    if (cdp) cdp.close?.();
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}

main().then(() => { console.log('通过', report.checks.length, '项；截图', report.screenshots.length, '张 →', out); }, error => { console.error('失败：', error.stack || error.message); process.exitCode = 1; });

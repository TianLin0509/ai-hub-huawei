'use strict';
// 诊断界面返工走查（2026-11-21，独立审查 6 条里的界面部分）：隔离 Hub + 真实鼠标点击，1440×900 截图。
// 走查四个场景：选文件试跑失败、一键补齐失败（公司代理 407）、组件中心 CLI 卡的「选择文件 / 改回自动查找」、「不适用」行。
// 用法：node tests/e2e-harness-rework-cdp.js [--out <截图目录>]
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
const report = { ok: false, checks: [], screenshots: [] };
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-harness-rework-'));
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
    const file = path.join(out, `20261121-rework-${name}.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.screenshots.push(file);
  }
  const msg = 'document.querySelector("#env-check-dialog [data-ec=msg]").textContent';
  const waitIdle = () => until('!document.querySelector("#env-check-dialog [data-ec=rerun]").disabled', 'env-check idle', 90000);
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'harness-rework-m6', extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await until('!!window.__envCheck && !!document.getElementById("options-env-check")', 'renderer ready', 60000);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('window.innerWidth === 1440', 'viewport 1440');
    await cdp.eval(`(() => {
      const { ipcRenderer } = require('electron');
      const fake = require(${JSON.stringify(path.join(__dirname, 'fixtures', 'harness-locate-fake.js'))});
      const orig = ipcRenderer.invoke.bind(ipcRenderer);
      const state = fake.results();
      // Claude：环境明细里能用（官方安装位置）；组件中心场景再改成「跑不起来」。
      // DSH：只装了核心包，缺界面包，fixes 给「一键补齐」。
      state.dsh = { ...state.dsh, verdict: 'broken', reason: '只装了核心包，缺界面包 @dsh/tui，补齐后才能用', chosen: state.dsh.candidates[1],
        fixes: [{ label: '一键补齐', act: 'harness-repair', id: 'dsh' }, { label: '手动选择程序…', act: 'harness-pick', id: 'dsh' }] };
      state.node = { ...state.pi, id: 'node', label: 'Node.js', reason: '没找到 Node.js' };
      const bad = { path: 'E:\\\\tools\\\\old-claude\\\\claude.exe', source: 'manual', sourceLabel: '你手动指定的', version: '0.2.9', runtime: null, verdict: 'too-old', reason: '版本太低' };
      const st = window.__rw = { state, calls: [], offNode: true };
      ipcRenderer.invoke = async (ch, p) => {
        if (ch.startsWith('harness:')) st.calls.push(ch);
        if (ch === 'harness:peek-all' || ch === 'harness:locate-all') return st.state;
        if (ch === 'harness:locate') return st.state[p.id];
        if (ch === 'harness:pick-path') return { ...st.state[p.id], verdict: 'too-old', reasonCode: 'manual-path-failed', reason: '你选的 ' + bad.path + ' 没通过试跑：版本 0.2.9 太低，Hub 需要 1.0 以上', chosen: bad, candidates: [bad],
          fixes: [{ label: '改回自动查找', act: 'harness-clear-manual', id: p.id }, { label: '手动选择程序…', act: 'harness-pick', id: p.id }] };
        if (ch === 'harness:apply-fix' && p.act === 'harness-repair') return { ...st.state[p.id], repairError: '公司代理要求登录（407），Hub 连不上 npm 默认源；稍后再试，或联系管理员放行这台电脑的代理。原话：npm ERR! 407 Proxy Authentication Required - GET https://registry.npmjs.org/@dsh%2ftui（缓存 C:\\\\Users\\\\zhangsan\\\\AppData\\\\Local\\\\npm-cache）' };
        if (ch === 'cli-tools:state') return { available: true, tools: {} };
        if (ch === 'env-check:run') {
          const r = await orig(ch, p);
          for (const item of r.items || []) {
            const loc = st.state[item.id]; if (!loc) continue;
            item.extra = { ...item.extra, locate: loc }; item.fixes = loc.fixes; item.cause = loc.reason;
            item.status = loc.verdict === 'ok' ? 'ok' : loc.verdict === 'broken' || loc.verdict === 'not-found' ? 'bad' : 'warn';
            if (item.id === 'node' && st.offNode) { item.status = 'off'; item.detail = '用不到：这台电脑上的 CLI 都自带运行环境，不需要单独的 Node.js'; }
          }
          return r;
        }
        return orig(ch, p);
      };
      return true;
    })()`);

    await cdp.eval('document.getElementById("options-env-check").click()');
    await until('document.getElementById("env-check-dialog")?.open', 'env-check open');
    await click('[data-ec-tab="environment"]');
    await until('document.querySelector("#env-check-dialog [data-ec-id=claude][data-hx-verdict]")', 'claude row', 90000);
    await waitIdle();
    check('打开体检没有额外调 harness:locate-all（第 4 条）', await cdp.eval('!window.__rw.calls.includes("harness:locate-all")'));

    // 场景 1：选文件试跑没通过。
    if (!(await cdp.eval('!!document.querySelector("#env-check-dialog [data-ec-id=claude].expanded")'))) await click('#env-check-dialog [data-ec-toggle="claude"]');
    await until('document.querySelector("#env-check-dialog [data-hx-panel=claude]")', 'claude panel');
    await click('#env-check-dialog [data-hx-act="pick"][data-hx-id="claude"]');
    await until(`/没用上你选的文件/.test(${msg})`, 'pick failed');
    await until('window.__rw.calls.includes("harness:locate")', 'relocate');
    check('选文件失败：底部说「没用上…原来的设置没有改动」（第 1 条）', await cdp.eval(`/没用上你选的文件.*原来的设置没有改动。$/.test(${msg}) && !/新建会话/.test(${msg})`));
    check('选文件失败：重取当前状态，结论卡仍是原来那份，不出现失败文件', await cdp.eval('document.querySelector("#env-check-dialog [data-ec-id=claude]").dataset.hxVerdict === "ok" && !/old-claude/.test(document.querySelector("#env-check-dialog [data-ec-id=claude]").textContent)'));
    await click('#env-check-dialog [data-ec-id="claude"] [data-ec-toggle="claude"]');
    await shot('pick-failed');

    // 场景 2：一键补齐失败（407）。
    const repair = await cdp.eval('(() => { const b=[...document.querySelectorAll("#env-check-dialog [data-ec-id=dsh] [data-ec-fix]")].find(x => /一键补齐/.test(x.textContent)); return b ? b.dataset.ecFix : ""; })()');
    check('DSH 行有「一键补齐」', !!repair);
    await click(`#env-check-dialog [data-ec-fix="${repair}"]`);
    await until('document.querySelector("#env-check-dialog [data-hx-repair-error=dsh]")', 'repair error');
    check('补齐失败：原因挂在 DSH 行按钮旁，写明 407（第 2 条）', await cdp.eval('/没补齐：公司代理要求登录（407）/.test(document.querySelector("#env-check-dialog [data-hx-repair-error=dsh]").textContent)'));
    check('补齐失败：原话里的用户名已打码', await cdp.eval('/Users\\\\<user>/.test(document.querySelector("#env-check-dialog [data-hx-repair-error=dsh]").textContent) && !/zhangsan/.test(document.getElementById("env-check-dialog").textContent)'));
    await cdp.eval('document.querySelector("#env-check-dialog [data-ec-id=dsh]").scrollIntoView({block:"center"})');
    await shot('repair-failed');

    // 场景 4：不适用的 Node 行。
    check('Node 行保持灰色「不适用」，不显示「没找到」（第 5 条）', await cdp.eval('(() => { const li=document.querySelector("#env-check-dialog [data-ec-id=node]"); return !!li && li.classList.contains("ec-off") && /不适用/.test(li.querySelector(".ec-state")?.textContent || "") && !/没找到/.test(li.textContent); })()'));
    await cdp.eval('document.querySelector("#env-check-dialog [data-ec-id=node]").scrollIntoView({block:"center"})');
    await shot('off-row');

    // 场景 3：组件中心里 Claude 跑不起来，行上只有安装按钮，展开后「选择文件」「改回自动查找」都在。
    await cdp.eval(`window.__rw.state.claude = { ...window.__rw.state.claude, verdict: 'broken', reason: 'Claude Code 试跑报错：找不到 git-bash', fixes: [{ label: '手动选择程序…', act: 'harness-pick', id: 'claude' }, { label: '重新检测', act: 'recheck' }] }`);
    await click('#env-check-dialog [data-ec="rerun"]');
    await sleep(300); await waitIdle();
    await click('[data-ec-tab="components"]');
    await until('document.querySelector("#env-check-dialog [data-ec-id=claude][data-hx-verdict=broken]")', 'claude broken');
    check('组件中心 Claude 行上是安装按钮', await cdp.eval('!!document.querySelector("#env-check-dialog [data-ec-id=claude] [data-ec-install=claude]")'));
    // 行可能被后台状态推送（cli-tools:state 等）重画，点一次没展开就再点，最多 3 次。
    for (let i = 0; i < 3 && !(await cdp.eval('!!document.querySelector("#env-check-dialog [data-hx-panel=claude]")')); i++) {
      if (!(await cdp.eval('!!document.querySelector("#env-check-dialog [data-ec-id=claude].expanded")'))) await click('#env-check-dialog [data-ec-toggle="claude"]');
      await sleep(500);
    }
    await until('document.querySelector("#env-check-dialog [data-hx-panel=claude]")', 'claude panel (components)', 5000);
    check('组件中心 Claude 卡：「我装在别处，选择文件」「改回自动查找」都在（第 3 条）', await cdp.eval('!!document.querySelector("#env-check-dialog [data-hx-act=pick][data-hx-id=claude]") && /改回自动查找/.test(document.querySelector("#env-check-dialog [data-hx-act=clear][data-hx-id=claude]")?.textContent || "")'));
    check('「重新体检」也没有调 harness:locate-all（第 4 条）', await cdp.eval('!window.__rw.calls.some(c => c.startsWith("harness:locate-all"))'));
    await shot('components-buttons');
    report.ok = true;
  } finally {
    report.root = root;
    fs.writeFileSync(path.join(out, '20261121-rework-report.json'), JSON.stringify(report, null, 2));
    if (cdp) cdp.close?.();
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}

main().then(() => { console.log('通过', report.checks.length, '项；截图', report.screenshots.length, '张 →', out); }, error => { console.error('失败：', error.stack || error.message); process.exitCode = 1; });

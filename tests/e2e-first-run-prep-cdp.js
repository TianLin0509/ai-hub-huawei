'use strict';
// 首次启动准备页真实界面：全新数据目录第一次打开有准备页并自动进入、第二次不等待；公司版没装 CodeAgent 时说清原因、依赖项等待、能先进入。
// 公司版场景需要 HUB_E2E_COMPANY=1，并在程序目录放公司版标记文件。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(os.tmpdir(), 'first-run-prep-shots'));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const root = process.env.AI_HUB_PROD_ROOT;
const exe = root ? { executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe') } : {};

function isolatedEnv(home) {
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  return { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    PATH: `${system};${path.dirname(process.execPath)}`, AI_HUB_FIRST_RUN_PREP: '1', ...(root ? { NODE_PATH: path.join(root, 'node_modules') } : {}) };
}
async function open(data, home, label) {
  const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label, extraEnv: isolatedEnv(home), ...exe });
  const cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
  return { hub, cdp, until: async (expr, what, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cdp.eval(expr).catch(() => false)) return; await sleep(150); }
    throw new Error('等待超时：' + what);
  } };
}
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, name), Buffer.from((r.result || r).data, 'base64'));
}
const rowsJs = `JSON.stringify([...document.querySelectorAll('.fr-row')].map(r => [r.dataset.fr, r.querySelector('.fr-dot').className.replace('fr-dot ',''), r.querySelector('.fr-d').textContent]))`;

async function personal() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-p-')), data = path.join(base, 'data'), home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  let s = await open(data, home, 'fr-first');
  const t0 = Date.now();
  await s.until('!!document.querySelector("#first-run-prep .fr-row")', '第一次打开出现准备页');
  await shot(s.cdp, 'first-running.png');
  await s.until(`!!document.querySelector("#first-run-prep") && ![...document.querySelectorAll('.fr-dot')].some(d => /run|wait/.test(d.className))`, '所有项查完', 90000).catch(() => {});
  const rows = JSON.parse(await s.cdp.eval(rowsJs).catch(() => '[]'));
  await shot(s.cdp, 'first-done.png');
  await s.until('!document.querySelector("#first-run-prep") || document.querySelector(".fr-go.pri") || /需要处理/.test(document.querySelector(".fr-sum").textContent)', '有结论', 15000);
  const ms = Date.now() - t0;
  console.log('第一次：', ms, 'ms', JSON.stringify(rows));
  await sleep(2000);
  assert.ok(fs.existsSync(path.join(data, 'first-run-prep.json')), '结果已存下');
  await gracefulQuit(s.hub);

  s = await open(data, home, 'fr-second');
  await s.until('!!window.WorkspaceController', '主界面就绪');
  await sleep(1500);
  assert.equal(await s.cdp.eval('!!document.querySelector("#first-run-prep")'), false, '第二次不显示准备页');
  console.log('第二次打开：没有准备页');
  await shot(s.cdp, 'second.png');
  await gracefulQuit(s.hub);
}

async function companyMissing() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-c-')), data = path.join(base, 'data'), home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const s = await open(data, home, 'fr-company');
  await s.until('!!document.querySelector("[data-fr=hello]")', '公司版有公司模型行');
  await s.until(`document.querySelector('[data-fr=codeagent] .fr-dot').classList.contains('bad')`, 'CodeAgent 标红', 60000);
  await s.until(`![...document.querySelectorAll('.fr-dot')].some(d => /run|wait/.test(d.className))`, '全部查完', 90000).catch(() => {});
  const rows = JSON.parse(await s.cdp.eval(rowsJs));
  console.log('公司版：', JSON.stringify(rows));
  await shot(s.cdp, 'company-missing.png');
  assert.equal(rows.find(r => r[0] === 'login')[1], 'hold');
  assert.ok(await s.cdp.eval(`!!document.querySelector('[data-fr=codeagent] .fr-fix')`), '红色行有按钮');
  await s.cdp.eval(`document.querySelector('.fr-go').click()`);
  await sleep(300);
  assert.equal(await s.cdp.eval('!!document.querySelector("#first-run-prep")'), false, '可以先进入');
  await gracefulQuit(s.hub);
}

(process.env.HUB_E2E_COMPANY === '1' ? companyMissing() : personal()).then(() => { console.log('PASS 截图：' + out); process.exit(0); }, error => { console.error('FAIL', error); process.exit(1); });

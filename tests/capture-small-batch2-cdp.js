'use strict';
//   门户：假门户停在登录页 → 失败页写清原因和按钮；改成能读 → 点「重试」读到数据；再停在登录页 → 旧数据上方出横幅；点「一键反馈」带原因打开反馈框。
//   会议室：在可选功能里关掉 → 会议室页盖「未开启」说明，不拉起组件；可选功能清单里有「会议室」。
//   完成提醒：设置「桌面回执」下有「CodeAgent 自带的完成提醒」，默认自动，改成保留能存住（11-20 起三档，见 tests/e2e-codeagent-cli-notify.js）。
// 用法：node tests/capture-small-batch2-cdp.js --out <新目录>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

let mode = 'login';
function fakePortal() {
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' }); res.end(JSON.stringify(body)); };
  const ago = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10) + ' 10:05:51';
  const T = (id, desc, days) => ({ taskUUID: id, taskDesc: desc, time: ago(days), taskURL: 'https://flow.corp.example/t/' + id, applicant: '某系统 00123456', handler: '某人 00654321' });
  return new Promise(r => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(decodeURIComponent(req.url));
      if (mode === 'ok') {
        if (u.startsWith('/next/service/rest/my/w3account')) return json(res, { uid: 'u1', email: 'someone@corp.example', profile: { lname: '某人' } });
        if (u.startsWith('/service/rest/task/getappinfocount')) return json(res, { todoCount: 2, todoData: [{ appName: '绩效', appNum: '1' }, { appName: '考勤', appNum: '1' }] });
        if (u.startsWith('/service/rest/task/appinfo')) return json(res, []);
        const m = /^\/service\/rest\/task\/(tasklists|applists)\/([^?]+)/.exec(u);
        if (m) return json(res, { count: 1, data: [T(m[2], m[2] === '绩效' ? '请完成中期辅导与反馈' : '考勤异常，请确认', m[2] === '绩效' ? 34 : 3)] });
        if (u.startsWith('/next/proxyw3/')) return json(res, { data: { count: 0 } });
        if (u.startsWith('/service/rest/info/common/docs')) return json(res, {});
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta charset="utf-8"><body>门户首页</body>');
      }
      // 登录页：有密码框、一直不跳回，模拟免密没生效
      if (u.startsWith('/next/service/rest/my/w3account')) return json(res, {});
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body>账号登录 <input type="password"></body>');
    });
    srv.listen(0, '127.0.0.1', () => r(srv));
  });
}

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(os.tmpdir(), 'smallE-capture-' + Date.now()));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-smallE-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false, attendance: false, w3: true }));
  const srv = await fakePortal();
  const ev = { steps: [], rendererErrors: [], overflow: {} };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'smallE-capture', extraEnv: {
      CLAUDE_HUB_COMPANY_W3: '1', CLAUDE_HUB_W3_TIMER: '0', CLAUDE_HUB_W3_URL: `http://127.0.0.1:${srv.address().port}/`,
      ...(fs.existsSync(path.join(REPO, 'community-edition.json')) ? {} : { CLAUDE_HUB_COMPANY_ASSISTANT: '1' }),
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(__dirname, 'fixtures/welink-cli-standin.js'),
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') ev.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(300); } throw Error('Timeout: ' + label); };
    const shot = async name => { await sleep(700); fs.writeFileSync(path.join(out, `20261119-smallE-${name}.png`), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); ev.steps.push('shot ' + name); };
    const click = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    const P = `document.getElementById('company-w3-page')`;

    // 门户 · 首次读取就停在登录页
    await wait(`!!document.getElementById('btn-company-w3')`, 'w3 nav', 60000);
    await click('#btn-company-w3');
    await wait(`${P}&&${P}.querySelector('.w3p-blank[data-fail-kind="login"]')`, 'login failure page', 150000);
    ev.loginPage = await c.eval(`(()=>{const b=${P}.querySelector('.w3p-blank');return {text:b.innerText,buttons:[...b.querySelectorAll('button')].map(x=>x.innerText)}})()`);
    ev.overflow.failPage = await c.eval(`(()=>{const p=${P};return p.scrollHeight>p.clientHeight+1})()`);
    await shot('01-门户-停在登录页');
    // 能读了 → 重试
    mode = 'ok';
    await click('#company-w3-page .w3p-blank [data-w3="sync"]');
    await wait(`${P}.querySelector('.w3p-row')`, 'rows after retry', 150000);
    ev.alertHiddenAfterOk = await c.eval(`${P}.querySelector('[data-slot="alert"]').hidden`);
    await shot('02-门户-重试后读到');
    // 再失败 → 旧数据上方横幅
    mode = 'login';
    await click('#company-w3-page .w3p-head [data-w3="sync"]');
    await wait(`!${P}.querySelector('[data-slot="alert"]').hidden`, 'alert banner', 150000);
    ev.alert = await c.eval(`(()=>{const a=${P}.querySelector('[data-slot="alert"]');return {text:a.innerText,buttons:[...a.querySelectorAll('button')].map(x=>x.innerText)}})()`);
    ev.rowsKept = await c.eval(`${P}.querySelectorAll('.w3p-row').length`);
    ev.overflow.alert = await c.eval(`(()=>{const p=${P};const b=p.querySelector('.w3p-body');return {page:p.scrollHeight>p.clientHeight+1,body:b.scrollHeight>b.clientHeight+1}})()`);
    await shot('03-门户-旧数据加失败横幅');
    await click('#company-w3-page [data-slot="alert"] [data-w3="feedback"]');
    await sleep(1500);
    ev.feedbackDesc = await c.eval(`(()=>{const t=[...document.querySelectorAll('textarea')].find(x=>x.offsetParent&&/门户读取不到/.test(x.value));return t?t.value:null})()`);
    await shot('04-门户-一键反馈带原因');
    const logFile = path.join(data, 'logs', 'company-w3.log');
    ev.logFile = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(x => ({ ok: x.ok, kind: x.kind, finalHost: x.finalHost, loginCopy: x.loginCopy })) : null;
    await c.eval(`[...document.querySelectorAll('button')].filter(b=>b.offsetParent&&/^(取消|关闭|×)$/.test(b.innerText.trim())).forEach(b=>b.click())`);

    // 会议室开关
    ev.roomsInList = await c.eval(`window.__optionalFeatures.refresh().then(l=>l.find(f=>f.id==='rooms')||null)`);
    if (ev.roomsInList) {
      ev.roomsOff = await c.eval(`window.__optionalFeatures.set('rooms', false).then(()=>window.__optionalFeatures.get('rooms'))`);
      await c.eval(`document.documentElement.removeAttribute('data-of-nav-hidden')`); // 只为点开入口截图；真实界面关掉后入口收起
      await click('#btn-company-rooms');
      await wait(`(()=>{const p=document.getElementById('company-rooms-page');return p&&!p.hidden&&!p.querySelector('.of-gate').hidden})()`, 'rooms gate', 20000);
      ev.roomsGate = await c.eval(`document.querySelector('#company-rooms-page .of-gate').innerText`);
      await sleep(3500);
      ev.roomsRuntimeDownloadStarted = fs.existsSync(path.join(data, 'room-runtime'));
      await shot('05-会议室-关闭后');
      await click('#btn-home');
    }

    // 完成提醒设置
    await c.eval(`require('electron').ipcRenderer.emit('desktop-notification:open-settings', {}, {})`);
    await wait(`(()=>{const r=document.getElementById('cfg-codeagent-cli-notify-row');return r&&r.style.display!=='none'&&r.offsetParent})()`, 'cli notify row', 20000);
    ev.cliDefault = await c.eval(`document.getElementById('cfg-codeagent-cli-notify').value`);
    await c.eval(`document.getElementById('cfg-notify-mode-section').scrollIntoView({block:'center'})`);
    await shot('06-设置-完成提醒只留一个');
    await c.eval(`(()=>{const e=document.getElementById('cfg-codeagent-cli-notify');e.value='own';e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(800);
    const cliFile = path.join(data, 'codeagent-cli-notify.json');
    ev.cliSaved = fs.existsSync(cliFile) ? JSON.parse(fs.readFileSync(cliFile, 'utf8')).mode : null;
  } catch (error) { ev.error = error.message; try { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261119-smallE-error.png'), Buffer.from(s.data, 'base64')); } catch { /* */ } }
  finally {
    fs.writeFileSync(path.join(out, '20261119-smallE-evidence.json'), JSON.stringify(ev, null, 2));
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    srv.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* */ }
  }
  console.log(JSON.stringify({ out, error: ev.error || null, rendererErrors: ev.rendererErrors.length }));
  if (ev.error) process.exitCode = 1;
}
run();

'use strict';
// 「CLI 已退出 → 重启会话并重发」真实点击验证（2026-11-20）：隔离数据目录、隐藏窗口、启动即退出的假 CodeAgent；1440×900。
//   node tests/capture-cli-exit-resend-cdp.js --out <新目录>
// 流程：新建 CodeAgent 会话（假 CLI 打印报错后退出，终端回到 PowerShell）→ 在输入框发一句 → 等「消息未发送」提示，
// 截图（按钮 + 终端最后几行）→ 删掉标记文件（模拟原因已修好）→ 点「重启会话并重发」→ 等按钮显示结果、截图。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

function seed(dir) {
  const { writeProbed } = require(path.join(REPO, 'core/codeagent-model-probe'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'capture-personal', expiresAt: Date.now() + 86400000 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
}

async function run(out) {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-exit-')), data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  const flag = path.join(root, 'exit-now.flag');
  fs.writeFileSync(flag, '1');
  seed(personal);
  const evidence = { root, shots: [], rendererErrors: [], steps: [], startedAt: new Date().toISOString() };
  const extraEnv = { AI_HUB_WORKSPACE_ROOT: work, HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/cli-exit-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal, CLI_EXIT_FAKE_FLAG: flag,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'),
    CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex') };
  let hub, c;
  const step = s => { evidence.steps.push(`${new Date().toISOString().slice(11, 19)} ${s}`); };
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'cli-exit-capture', extraEnv });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch {} });
    await c.send('Runtime.enable');
    const wait = async (expr, label, timeout = 30000) => {
      let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e.message; } await sleep(250); }
      throw Error('Timeout ' + label + (last ? ': ' + last : ''));
    };
    const click = async selector => {
      const xy = await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`, 'clickable ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    const shot = async name => {
      await sleep(300);
      const image = Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      const file = path.join(out, `20261120-cli-exit-resend-${name}-1440-m2.png`);
      fs.writeFileSync(file, image); evidence.shots.push(file);
    };
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('typeof selectSession === "function"', 'renderer ready');
    await sleep(1500);
    const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'codeagent', opts: { cwd: work, title: '示例：会退出的会话' } })})`);
    if (!created?.id) throw Error('会话没建起来：' + JSON.stringify(created));
    const sid = created.id; step('created ' + sid.slice(0, 8));
    await c.eval(`selectSession(${JSON.stringify(sid)})`);
    // 等假 CLI 退出、终端回到 PowerShell。
    await wait(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box');return !!b})()`, 'composer', 30000);
    await sleep(9000);
    await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box');b.focus();return true})()`);
    // 记下发送回执，失败时好定位（不改行为）。
    await c.eval(`(()=>{window.__sendLog=[];const o=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(ch,...a)=>{const p=o(ch,...a);if(ch==='session:send-prompt'){window.__sendLog.push({called:Date.now()});}if(ch==='session:send-prompt')p.then(r=>window.__sendLog.push({req:{text:a[0]&&a[0].text,wait:a[0]&&a[0].waitForCliReady},r}),e=>window.__sendLog.push({err:String(e)}));return p};return true})()`);
    evidence.bufferBeforeSend = await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(sid)}).then(t=>String(t||'').replace(/\[[0-9;?]*[a-zA-Z]/g,'').slice(-300))`).catch(() => null);
    await c.send('Input.insertText', { text: '帮我把这周的周报整理一下' });
    await sleep(300);
    evidence.beforeClick = await c.eval(`(()=>{const bar=document.querySelector('.floating-input-bar[data-session-id="${sid}"]');const b=bar&&bar.querySelector('.floating-input-send');const r=b&&b.getBoundingClientRect();return {draft:bar&&bar.querySelector('.floating-input-box').innerText,active:document.activeElement&&document.activeElement.className,btn:b?{dis:b.disabled,cls:b.className,rect:[r.x,r.y,r.width,r.height].map(Math.round),hit:(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)||{}).className}:null}})()`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(2000);
    evidence.afterClick = await c.eval(`({log:JSON.stringify(window.__sendLog),draft:document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box').innerText,toast:document.getElementById('hub-err-toast')?.innerText||null})`);
    step('sent');
    try { await wait(`document.querySelector('#hub-err-toast [data-hub-err-act="known:session-restart-resend"]')`, 'not-sent toast with resend', 150000); }
    catch (e) {
      evidence.sendLog = await c.eval('JSON.stringify(window.__sendLog)').catch(() => null);
      evidence.sameIpc = await c.eval(`ipcRenderer === require('electron').ipcRenderer`).catch(e => String(e));
      evidence.failState = await c.eval(`({toast:document.getElementById('hub-err-toast')?.innerText||null,toasts:[...document.querySelectorAll('[class*=toast]')].map(t=>t.innerText.slice(0,200)).filter(Boolean),draft:document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')?.innerText})`).catch(() => null);
      evidence.failBuffer = await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(sid)}).then(t=>String(t||'').slice(-1500)).catch(e=>'n/a '+e.message)`).catch(() => null);
      await shot('fail');
      throw e;
    }
    step('toast shown');
    evidence.sendLog = await c.eval('JSON.stringify(window.__sendLog)').catch(() => null);
    evidence.toast = await c.eval(`({text:document.querySelector('#hub-err-toast .hub-err-toast-text')?.textContent,tail:document.querySelector('#hub-err-toast .hub-err-toast-tail pre')?.textContent,buttons:[...document.querySelectorAll('#hub-err-toast button')].map(b=>b.textContent),draft:document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')?.innerText})`);
    await shot('toast');
    // 模拟用户修好了原因（例如换了档位），再一键重启并重发。
    fs.rmSync(flag, { force: true });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 720, y: 860 });
    evidence.beforeResend = await c.eval(`(()=>{const b=document.querySelector('#hub-err-toast [data-hub-err-act="known:session-restart-resend"]');const r=b.getBoundingClientRect();const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:[r.x,r.y,r.width,r.height].map(Math.round),hit:h&&(h.dataset.hubErrAct||h.className||h.tagName),toasts:document.querySelectorAll('#hub-err-toast').length}})()`);
    await click('#hub-err-toast [data-hub-err-act="known:session-restart-resend"]');
    step('clicked resend');
    // 按钮上的字就是进度：记下出现过的每一种，直到出结果（成功、或「没做成：原因」）。
    evidence.labels = [];
    for (const until = Date.now() + 150000; Date.now() < until;) {
      const label = await c.eval(`document.querySelector('#hub-err-toast [data-hub-err-act="known:session-restart-resend"]')?.textContent || 'toast-closed'`).catch(() => 'eval-failed');
      if (evidence.labels[evidence.labels.length - 1] !== label) { evidence.labels.push(label); if (/等就绪|正在重启/.test(label)) await shot('progress'); }
      if (/已重启并重发|已重发|没做成|toast-closed/.test(label)) { evidence.final = label; break; }
      await sleep(200);
    }
    step('final ' + evidence.final);
    if (evidence.final && evidence.final !== 'toast-closed') await shot('result');
    await sleep(2500);
    evidence.after = await c.eval(`({draft:document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')?.innerText ?? null,toast:!!document.getElementById('hub-err-toast')})`);
    evidence.ptyTail = await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(sid)}).then(t=>String(t||'').slice(-600)).catch(e=>'n/a '+e.message)`);
    await shot('after');
    const log = path.join(data, 'logs', 'codeagent-startup-blocks.log');
    evidence.startupBlocks = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(l => l.includes('"cli-exited"')).slice(-1) : [];
  } finally {
    try { c?.ws?.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(e => { evidence.quitError = e.message; });
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, '20261120-cli-exit-resend-evidence-m2.json'), JSON.stringify(evidence, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  return evidence;
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : path.join(REPO, 'artifacts', 'cli-exit-resend-' + Date.now());
  run(out).then(e => console.log(JSON.stringify({ shots: e.shots, toast: e.toast, final: e.final, after: e.after, errors: e.rendererErrors.length, steps: e.steps }, null, 2)))
    .catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
}
module.exports = { run };

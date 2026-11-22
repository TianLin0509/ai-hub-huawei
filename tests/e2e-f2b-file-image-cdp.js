'use strict';
// 隔离 Hub + 模拟 CodeAgent；真实 PNG、File、DOM 事件、IPC 和 nativeImage，不读写系统剪贴板。
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'artifacts/f2b-file-image');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-f2b-'));
  const data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, personal, out]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'f2b-personal', expiresAt: Date.now() + 86400000 } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  require('../core/codeagent-model-probe').writeProbed(path.join(personal, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
  const original = path.join(work, '原始 大图.png');
  await require('sharp')({ create: { width: 3840, height: 2160, channels: 4, background: '#3478f6' } }).png().toFile(original);
  const before = fs.readFileSync(original);
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'f2b', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'), CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'),
      CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    const wait = async (expr, label) => {
      for (const end = Date.now() + 40000; Date.now() < end;) { if (await c.eval(expr).catch(() => false)) return; await sleep(150); }
      throw Error('Timeout ' + label);
    };
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('typeof selectSession === "function"', 'boot');
    const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'codeagent', opts: { cwd: work, title: '大图附件回归', codeagentAccount: 'personal' } })})`);
    assert(created?.id, JSON.stringify(created));
    await c.eval(`selectSession(${JSON.stringify(created.id)})`);
    const bar = `.floating-input-bar[data-session-id="${created.id}"]`;
    const box = bar + ' .floating-input-box';
    await wait(`document.querySelector(${JSON.stringify(box)})?.offsetParent`, 'composer');
    await c.eval(`window.__f2bCarrier=document.createElement('input');__f2bCarrier.type='file';__f2bCarrier.className='f2b-carrier';__f2bCarrier.hidden=true;document.body.appendChild(__f2bCarrier)`);
    const doc = await c.send('DOM.getDocument');
    const carrier = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.f2b-carrier' });
    await c.send('DOM.setFileInputFiles', { nodeId: carrier.nodeId, files: [original] });
    const checks = [];
    for (const mode of ['paste', 'drop', 'picker']) {
      await c.eval(`(()=>{const b=document.querySelector(${JSON.stringify(box)});b.innerHTML='';b.focus();b.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      if (mode === 'picker') {
        // CDP 截获原生文件选择器，真实点击附件按钮，再向实际 file input 提供文件。
        await c.send('Page.setInterceptFileChooserDialog', { enabled: true });
        const p = await c.eval(`(()=>{const r=document.querySelector(${JSON.stringify(bar + ' .composer-attach')}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
        const picker = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: bar + ' .composer-attachment-picker' });
        await c.send('DOM.setFileInputFiles', { nodeId: picker.nodeId, files: [original] });
      } else {
        await c.eval(`(()=>{const dt=new DataTransfer();dt.items.add(__f2bCarrier.files[0]);const b=document.querySelector(${JSON.stringify(box)});b.dispatchEvent(${mode === 'paste'
          ? "new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})"
          : "new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})"});})()`);
      }
      await wait(`document.querySelector(${JSON.stringify(box + ' .fi-paste-chip[data-kind=image]')})`, mode + ' resized chip');
      const result = await c.eval(`(()=>{const b=document.querySelector(${JSON.stringify(box)}),chip=b.querySelector('.fi-paste-chip'),p=readContenteditablePlainText(b).trim();return{path:p,label:chip.dataset.label,size:require('electron').nativeImage.createFromPath(p).getSize()}})()`);
      assert.notEqual(result.path, original);
      assert.match(result.label, /已自动缩放/);
      assert.deepEqual(result.size, { width: 2000, height: 1125 });
      assert(!result.path.includes('已自动缩放'));
      assert(before.equals(fs.readFileSync(original)), 'original unchanged');
      checks.push({ mode, ...result }); console.log('PASS ' + mode);
    }
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'attachments.png'), Buffer.from(shot.data, 'base64'));
    await c.eval(`window.__f2bSent=[];{const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,p,...args)=>{if(channel==='session:send-prompt')__f2bSent.push(p.text);return invoke(channel,p,...args)}}`);
    const p = await c.eval(`(()=>{const r=document.querySelector(${JSON.stringify(bar + ' .floating-input-send')}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
    await wait('__f2bSent.length===1', 'send prompt');
    assert.equal((await c.eval('__f2bSent'))[0], checks[2].path);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ checks, sentPathVerified: true, originalUnchanged: true, realModelTested: false }, null, 2));
    console.log('PASS send prompt: resized path only; original unchanged');
    // 先收起自己创建的 CLI，等 PTY 退出后再关闭 Electron，避免关闭窗口与原生终端析构交叠。
    await c.eval(`ipcRenderer.invoke('close-session',${JSON.stringify(created.id)})`);
    await sleep(2500);
  } finally { c?.close(); if (hub) await gracefulQuit(hub); }
})().catch(error => { console.error(error.stack); if (error.logTail) console.error(error.logTail); process.exitCode = 1; });

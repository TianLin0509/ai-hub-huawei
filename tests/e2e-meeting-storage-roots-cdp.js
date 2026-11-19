'use strict';
// 升级后找回旧会议（2026-11-19）：隐藏窗口的真实 Hub + 真实会议后端，隔离数据目录里摆好「上次数据目录」里的旧会议，
// 设置里换成一个这次建不出来的目录（启动回退默认目录），打开会议页看历史列表、材料位置和打开文件夹按钮。
// 不连公司、不调模型，不碰生产 Hub。用法：node tests/e2e-meeting-storage-roots-cdp.js [输出目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || 'artifacts/meeting-storage-roots-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  fs.mkdirSync(out, { recursive: true });
  let hub, c; const result = { passed: false, checks: [] };
  const record = () => fs.writeFileSync(path.join(out, 'meeting-storage-roots-cdp.json'), JSON.stringify(result, null, 2));
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-roots-ui-')), dataDir = path.join(root, 'data'), work = path.join(root, 'work'), welink = path.join(root, 'welink-disabled.js');
    for (const p of [dataDir, work, path.join(root, 'personal'), path.join(root, 'scan')]) fs.mkdirSync(p);
    fs.writeFileSync(path.join(work, '.aiwork-root'), ''); fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
    fs.writeFileSync(welink, 'process.stdout.write(JSON.stringify({authenticated:false,loggedIn:false}));');
    // 旧版本的数据：助理数据目录曾设在 custom，里面有一场带录像和截图的会议；这次设置指向一个建不出来的目录。
    const defaultDir = path.join(dataDir, 'company-assistant'), custom = path.join(root, '会议资料 D');
    // 用真实的会议服务按旧版本的写法生成一场已结束的会议，再写上纪要和录像大小。
    const { MeetingCompanion } = require('../core/company-assistant/meeting');
    const maker = new MeetingCompanion({ dir: custom, workspace: path.join(custom, 'workspace'), changed() {}, sessionBusy: () => false }, { powerSaveBlocker: false, meetingAsr: { status: () => ({ ready: false }), close() {} } });
    maker.tools = { start: async () => {}, bind() {}, close() {}, unbind() {} }; maker.start = () => {}; maker.tick = async () => {};
    const made = maker.create({ title: '上周方案评审（旧版本）' }); maker.control(made.id, 'stop'); const id = made.id;
    const old = maker.load(id); old.summary = '## 决定\n- 旧纪要还在'; old.startedAt = Date.parse('2026-11-12T02:00:00Z'); maker.save(old); maker.close();
    // 同一场在默认目录也有一份较旧的副本（迁移复制过）：页面要显示自定义目录里较新的那份，并提示另一份。
    const newCopy = path.join(custom, 'workspace', 'meetings', id), oldCopy = path.join(defaultDir, 'workspace', 'meetings', id);
    fs.mkdirSync(oldCopy, { recursive: true }); for (const f of fs.readdirSync(newCopy)) if (fs.statSync(path.join(newCopy, f)).isFile()) fs.copyFileSync(path.join(newCopy, f), path.join(oldCopy, f)); // fs.cpSync 在中文路径上会让 Node 直接退出（127）
    fs.writeFileSync(path.join(oldCopy, 'meeting.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(oldCopy, 'meeting.json'), 'utf8')), title: '旧副本', summary: '旧副本纪要' }), 'utf8');
    for (const f of fs.readdirSync(oldCopy)) fs.utimesSync(path.join(oldCopy, f), new Date('2026-11-12T03:00:00Z'), new Date('2026-11-12T03:00:00Z'));
    fs.writeFileSync(path.join(root, 'blocked'), 'file'); fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(path.join(defaultDir, 'settings.json'), JSON.stringify({ dataRoot: path.join(root, 'blocked', 'sub'), dataRootActive: custom }), 'utf8');
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'meeting storage roots', ...(process.env.HUB_ELECTRON_EXE ? { executablePath: process.env.HUB_ELECTRON_EXE } : {}), extraEnv: {
      ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(root, 'missing-cli.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline fixture' }, foreign: { ok: false, error: 'offline fixture' } }),
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: welink,
    } }); result.hubPid = hub.pid; result.root = root; record();
    c = await connectFirstPage(hub); await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const q = s => `document.querySelector(${JSON.stringify(s)})`;
    const until = async (expr, label) => { for (const end = Date.now() + 30000; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(150); } throw Error('timeout ' + label); };
    const click = async selector => {
      await until(`(()=>{const e=${q(selector)};return e&&!e.disabled&&e.getBoundingClientRect().width>0;})()`, selector);
      const point = await c.eval(`(()=>{const r=${q(selector)}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const shot = async name => { await _waitMs(200); const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64')); };
    await until(`!!${q('#btn-company-meeting')}`, 'meeting nav'); await click('#btn-company-meeting');
    await click('[data-m="more"] > summary');
    await until(`${q('[data-m="history"]')}?.options.length===2`, 'old meeting in history');
    const options = await c.eval(`Array.from(${q('[data-m="history"]')}.options).map(o=>o.textContent)`);
    assert.match(options[1], /上周方案评审（旧版本）/); result.checks.push({ history: options });
    const storage = await c.eval(`${q('[data-m="storage-text"]')}.textContent + '；' + ${q('[data-m="storage-note"]')}.textContent`);
    assert.equal(await c.eval(`${q('[data-m="storage-note"]')}.getBoundingClientRect().height>0`), true, 'note visible');
    assert.ok(storage.includes(path.join(defaultDir, 'workspace', 'meetings')), 'shows current folder');
    assert.match(storage, /另有 1 场在以前的数据目录/); assert.match(storage, /启用失败/); result.checks.push({ storage });
    assert.equal(await c.eval(`${q('[data-act="open-folder"]')}.getBoundingClientRect().width>0`), true, 'open-folder button visible');
    await shot('more-menu-1440');
    // 选中旧会议：纪要从原来的目录读出来。
    await c.eval(`(()=>{const s=${q('[data-m="history"]')};s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(`(${q('[data-m="summary"]')}?.textContent||'').includes('旧纪要还在')`, 'old minutes rendered: ' + await c.eval(`${q('[data-m="message"]')}?.textContent`)); result.checks.push({ minutes: 'rendered from old folder' });
    const copyNote = await c.eval(`${q('[data-m="storage-note"]')}.textContent`);
    assert.ok(copyNote.includes(oldCopy) && copyNote.includes('较旧'), 'copy note: ' + copyNote); result.checks.push({ copyNote });
    await shot('old-meeting-1440');
    // 删除：第一个确认框写明另一份，第二个确认框默认「只删显示的这份」。
    const dialogButton = label => `Array.from(document.querySelectorAll('button.hub-button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.getBoundingClientRect().width>0)`;
    const clickText = async label => { await until(`!!${dialogButton(label)}`, label); await c.eval(`${dialogButton(label)}.click()`); };
    await until(`${q('[data-act="delete-meeting"]')}?.disabled===false`, 'delete enabled'); await c.eval(`${q('[data-act="delete-meeting"]')}.click()`);
    await until(`document.body.innerText.includes('下一步再选要不要一起删')`, 'first confirm mentions copy');
    await clickText('删除这场会议');
    await until(`document.body.innerText.includes('另一份也删吗')`, 'second confirm');
    const second = await c.eval(`document.body.innerText`); assert.ok(second.includes(oldCopy), 'second confirm lists copy');
    await shot('delete-copy-confirm-1440');
    await clickText('只删显示的这份');
    await until(`(${q('[data-m="message"]')}?.textContent||'').includes('另一份仍在')`, 'kept message: ' + await c.eval(`${q('[data-m="message"]')}?.textContent`));
    assert.equal(fs.existsSync(newCopy), false, 'shown copy deleted'); assert.ok(fs.existsSync(path.join(oldCopy, 'meeting.json')), 'other copy kept');
    await until(`${q('[data-m="history"]')}?.options.length===1`, 'history empty after delete');
    result.checks.push({ delete: 'shown copy removed, older copy kept and hidden' });
    result.passed = true;
  } catch (error) { result.error = error.stack || String(error); result.logTail = error.logTail || (hub?.log ? hub.log().slice(-30).join('\n') : ''); process.exitCode = 1; }
  finally { record(); try { c?.close?.(); } catch {} if (hub) await gracefulQuit(hub).catch(() => {}); }
  console.log(JSON.stringify({ passed: result.passed, error: result.error?.split('\n')[0], out }));
})();

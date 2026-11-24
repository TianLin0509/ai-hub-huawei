'use strict';
// 部门 API key（网关）设置界面（2026-11-24 三审整改）：隔离真实 Electron、隐藏窗口、1440×900。
// 读设置的 IPC 在页面里替换成「8 项都选了网关、网关可用」的数据，手填模型的检测也替换成假结果；不碰真实网关和 key。
// 核对：日常功能页一屏不滚动；⚙ Agent 弹窗（720px）出了保存状态后 ⓘ 仍完整可见；手填模型成功的提示写回弹窗自己，不写到设置页。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const out = path.resolve(process.env.GW_UI_OUTPUT || path.join(os.tmpdir(), 'feature-gateway-ui'));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-gateway-ui-')), data = path.join(root, 'data');
  fs.mkdirSync(data);
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const result = { ok: false, checks: [], shots: [] };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'hidden', label: 'feature-gateway-ui', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      AI_HUB_CODEAGENT_COMMAND: path.resolve('tests/fixtures/help-ask-fake/codeagent.cmd'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async expr => { for (let i = 0; i < 150; i++) { const v = await c.eval(expr); if (v) return v; await sleep(200); } throw Error('等待失败：' + expr); };
    const shot = async name => { await sleep(250); const file = path.join(out, `20261124-gw-ui-${name}-1440x900.png`); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); };
    await wait(`typeof window.__hubOpenConfigModal==='function' && !!window.__featureAgents && document.readyState==='complete'`);
    // 页面内替换读设置与手填检测：8 项会话功能都选了部门 key，网关可用。
    await c.eval(`(() => {
      const ipc = require('electron').ipcRenderer, real = ipc.invoke.bind(ipc);
      const gw = { kind: 'api-gateway', label: '部门 API key（网关）', available: true, reason: '', defaultModel: 'glm-5.3-flash', allowCustom: true,
        models: [{ id: 'glm-5.3-flash', label: 'glm-5.3-flash' }, { id: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash' }] };
      const fake = st => ({ ...st, backends: [...st.backends.filter(b => b.kind !== 'api-gateway'), gw],
        features: st.features.map(f => f.kinds.includes('api-gateway') ? { ...f, choice: { kind: 'api-gateway', model: '' }, selected: { kind: 'api-gateway', model: '' }, warning: '' } : f) });
      window.__gwCustomCalls = [];
      ipc.invoke = async (channel, req) => {
        if (channel === 'feature-agents:get') return fake(await real(channel, req));
        if (channel === 'feature-agents:custom-model') { window.__gwCustomCalls.push(req); return { ...fake(await real('feature-agents:get')), checked: { model: req.model, firstMs: 1200 } }; }
        return real(channel, req);
      };
      return true; })()`);
    await c.eval('window.__hubOpenConfigModal()');
    await c.eval(`document.querySelector('#cfg-tab-agents').click()`);
    await c.eval('window.__featureAgents.refresh()'); // 打开设置时的读取可能早于上面的替换，这里按替换后的数据重画一次
    await wait(`document.querySelectorAll('#cfg-feature-agents [data-fa-row]').length===7 && document.querySelectorAll('#cfg-feature-agents [data-fa-backend]')[1].value==='api-gateway'`);
    const layout = await c.eval(`(() => { const p=document.querySelector('#config-main-view'); return { h:p.clientHeight, sh:p.scrollHeight, rowHints:document.querySelectorAll('#cfg-feature-agents .fa-row .fa-hint').length,
      gw:Array.from(document.querySelectorAll('#cfg-feature-agents [data-fa-backend]')).filter(s => s.value==='api-gateway').length }; })()`);
    assert.ok(layout.sh <= layout.h + 2, `日常功能页一屏：${JSON.stringify(layout)}`);
    assert.equal(layout.rowHints, 0, '8 项都选网关也不逐行挂提示');
    result.checks.push(`日常功能页 ${layout.gw} 项选部门 key 后仍一屏（clientHeight ${layout.h} / scrollHeight ${layout.sh}），行内 0 条提示`);
    await shot('settings-all-gateway');
    // 关掉设置弹窗（保留在 DOM 里隐藏，正好检验写错容器的问题），打开 PPT 的 ⚙ Agent 弹窗。
    await c.eval(`document.getElementById('config-modal').classList.add('hidden')`);
    await c.eval(`window.__featureAgents.open(['ppt','pptMap','pptMake','pptImgtext'], document.body)`);
    await wait(`document.querySelectorAll('.fa-popup [data-fa-row]').length===4`);
    // 保存状态出一条长消息：ⓘ 仍完整在弹窗内、看得见。
    await c.eval(`(() => { const m=document.querySelector('.fa-popup [data-fa-message]'); m.textContent='已保存，下次任务生效（这是一条故意写长的保存状态，用来检验底部说明里的 ⓘ 不会被挤掉）'; return true; })()`);
    const info = await c.eval(`(() => { const i=document.querySelector('.fa-popup .fa-foot i'), p=document.querySelector('.fa-popup').getBoundingClientRect(), r=i.getBoundingClientRect();
      const hit=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return { w:r.width, inside:r.left>=p.left && r.right<=p.right, visible:hit===i, popupW:p.width }; })()`);
    assert.ok(info.w > 4 && info.inside && info.visible, `ⓘ 可见不裁切：${JSON.stringify(info)}`);
    result.checks.push(`720px 弹窗出长保存状态后 ⓘ 完整可见（宽 ${info.w.toFixed(1)}px，弹窗 ${info.popupW}px）`);
    await shot('popup-info-visible');
    // 手填模型：在弹窗里的「PPT 找页」行选「手填模型名…」，填名字，检测通过后提示写在弹窗自己的状态栏。
    await c.eval(`(() => { const row=document.querySelector('.fa-popup [data-fa-row="ppt"]'), sel=row.querySelector('[data-fa-model]'); sel.value='__custom__'; sel.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    await wait(`!document.querySelector('.fa-popup [data-fa-row="ppt"] [data-fa-custom]').hidden`);
    await c.eval(`(() => { const row=document.querySelector('.fa-popup [data-fa-row="ppt"]'); row.querySelector('[data-fa-custom-input]').value='my-model-1'; row.querySelector('[data-fa-custom-check]').click(); return true; })()`);
    await wait(`(document.querySelector('.fa-popup [data-fa-message]')?.textContent||'').includes('my-model-1')`);
    const msg = await c.eval(`({ popup: document.querySelector('.fa-popup [data-fa-message]').textContent, title: document.querySelector('.fa-popup [data-fa-message]').title,
      settings: document.querySelector('#cfg-feature-agents [data-fa-message]')?.textContent || '', calls: window.__gwCustomCalls })`);
    assert.match(msg.popup, /已连通（首字 1\.2 秒），下次提问起用 my-model-1/); assert.equal(msg.title, msg.popup);
    assert.equal(msg.settings, '', '提示没写到隐藏的设置页');
    assert.deepEqual(msg.calls, [{ feature: 'ppt', model: 'my-model-1' }]);
    result.checks.push('⚙ Agent 弹窗里手填模型成功，提示写回弹窗自己的状态栏（带悬停全文），设置页状态栏为空');
    await shot('popup-custom-ok');
    result.ok = true;
  } catch (error) {
    result.error = error.stack || error.message;
    try { if (c) { const file = path.join(out, '20261124-gw-ui-failure-1440x900.png'); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); } } catch {}
  } finally {
    try { c?.close?.(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(out, '20261124-gw-ui-result.json'), JSON.stringify(result, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  console.log(result.ok ? 'GUI PASS: ' + result.checks.join('；') : 'GUI FAIL: ' + result.error);
  process.exitCode = result.ok ? 0 : 1;
}
main();

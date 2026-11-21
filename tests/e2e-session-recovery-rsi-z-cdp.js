'use strict';
// Isolated Hub, synthetic history and injected IPC failures; no real CLI/account.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = process.env.HUB_E2E_ARTIFACT_DIR || path.resolve('artifacts/rsi-z');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
async function port() {
  const server = net.createServer();
  return new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', () => {
    const p = server.address().port; server.close(() => resolve(p));
  }); });
}
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-recovery-z-'));
  fs.mkdirSync(out, { recursive: true });
  const steps = []; let hub, c;
  const until = async (expression, label) => {
    const end = Date.now() + 60000;
    while (Date.now() < end) { try { if (await c.eval(expression)) return; } catch {} await sleep(250); }
    throw new Error('timeout: ' + label);
  };
  const shot = async name => { const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(tmp, 'data'), port: await port(), label: 'rsi-z-recovery', windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_E2E_FAKE_HOME: '1', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', CODEX_HOME: '' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until("typeof sessions !== 'undefined' && !!window.WorkspaceController", 'renderer ready');
    await c.eval(`(() => {
      window.__zInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      window.__zResumes = 0;
      ipcRenderer.invoke = async (channel, ...args) => {
        if (channel === 'resume-session') { window.__zResumes++; return null; }
        if (channel === 'session:open-status') return { available: true };
        if (channel === 'assistant:phone-session-prompts') return [];
        if (channel === 'parse-session-transcript' && args[0].hubSessionId === 'rsi-z-history') return { turns: [
          { id: 'z-user', role: 'user', text: '请保留这条测试历史', kind: 'codeagent' },
          { id: 'z-answer', role: 'assistant', text: '这是恢复前已保存的回答。', kind: 'codeagent' }
        ] };
        return window.__zInvoke(channel, ...args);
      };
      sessions.set('rsi-z-history', { id: 'rsi-z-history', title: '恢复失败演示', kind: 'codeagent', status: 'dormant', cwd: ${j(tmp)},
        ccSessionId: '11111111-1111-4111-8111-111111111111', transcriptPath: ${j(path.join(tmp, 'synthetic.jsonl'))} });
      return true;
    })()`);
    await c.eval("selectSession('rsi-z-history').then(() => true)");
    await until("!!document.querySelector('.session-resume-pending.failed')", 'null resume failure');
    await c.eval("document.querySelector('dialog[open] .hub-button-primary')?.click(); true");
    const status = await c.eval("({ pending: sessions.get('rsi-z-history')._resumePending, requests: window.__zResumes, copy: document.querySelector('.session-resume-pending').textContent })");
    assert.equal(status.pending, false); assert.equal(status.requests, 1); assert.match(status.copy, /查看已有历史/);
    steps.push({ step: 'null resume is actionable', ...status });
    await shot('01-resume-failure');
    await c.eval("[...document.querySelectorAll('.session-resume-pending button')].find(b => b.textContent === '查看已有历史').click(); true");
    await until("document.querySelector('#msg-overlay')?.textContent.includes('这是恢复前已保存的回答')", 'saved history');
    assert.equal(await c.eval('window.__zResumes'), 1, 'reading history does not wake a writer');
    await shot('02-preserved-history'); steps.push({ step: 'history visible without starting CLI', ok: true });
    await c.eval(`(() => {
      window.__zMarkedParse = marked.parse;
      marked.parse = text => { if (String(text).includes('渲染异常示例')) throw new Error('synthetic parser error'); return window.__zMarkedParse(text); };
      mountSessionTurnCard('rsi-z-history', { id: 'z-broken', role: 'assistant', text: '渲染异常示例：这段原文仍然可见。', kind: 'codeagent' });
      mountSessionTurnCard('rsi-z-history', { id: 'z-empty', role: 'assistant', text: '  ', kind: 'codeagent' });
      mountSessionTurnCard('rsi-z-history', { id: 'z-after', role: 'assistant', text: '下一条回答继续显示。', kind: 'codeagent' });
      return true;
    })()`);
    await until("!!document.querySelector('.turn-render-error')", 'render fallback');
    const rendered = await c.eval("document.querySelector('#msg-overlay').textContent");
    assert.match(rendered, /原始记录仍保留/); assert.match(rendered, /这条消息没有正文/); assert.match(rendered, /下一条回答继续显示/);
    await shot('03-card-fallback');
    await c.eval(`(() => { marked.parse = window.__zMarkedParse;
      mountSessionTurnCard('rsi-z-history', { id: 'z-broken', role: 'assistant', text: '渲染异常示例：这段原文仍然可见。', kind: 'codeagent' }); return true; })()`);
    assert.equal(await c.eval("!!document.querySelector('.turn-render-error')"), false, 'same message can recover on refresh');
    steps.push({ step: 'broken and empty cards visible; same-content retry recovers', ok: true });
    await c.eval(`(() => { showDormantResumePlaceholder(sessions.get('rsi-z-history'), new Error(require('../core/archive-temp-run').nativeLoadMessage(
      new Error('Failed to load native module: conpty.node'), {execPath:'D:/AIHub/AI Hub Community.exe'}))); return true; })()`);
    const native = await c.eval("document.querySelector('.session-resume-pending.failed').textContent");
    assert.match(native, /完整安装包/); await shot('04-native-component-repair');
    steps.push({ step: 'existing native module repair steps remain visible', ok: true });
    await c.eval("[...document.querySelectorAll('.session-resume-pending button')].find(b => b.textContent.startsWith('新建会话')).click(); true");
    await until("document.getElementById('new-session-menu')?.style.display === 'flex'", 'launch center');
    assert.equal(await c.eval("sessions.get('rsi-z-history').status"), 'dormant');
    await shot('05-new-session-preserves-original');
    steps.push({ step: 'new-session form opens while original remains dormant', ok: true });
    fs.writeFileSync(path.join(out, 'e2e-report.json'), JSON.stringify({ ok: true, synthetic: true, steps }, null, 2));
    console.log('PASS ' + JSON.stringify(steps));
  } catch (error) {
    if (c) await shot('failure').catch(() => {});
    fs.writeFileSync(path.join(out, 'e2e-report.json'), JSON.stringify({ ok: false, error: error.stack, steps, hubLog: hub?.getLogs?.() }, null, 2));
    throw error;
  } finally { if (c) await c.close().catch(() => {}); if (hub) await gracefulQuit(hub); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// 隔离 Hub + 注入未完成 IPC，真实等待 90 秒并用鼠标点击恢复按钮；不启动真实 CLI。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve('artifacts/20261123-wake-r9');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-r9-'));
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const value = server.address().port; server.close(() => resolve(value));
  }); });
  let hub, c;
  const steps = [];
  const until = async (expression, label, timeout = 30_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await c.eval(expression)) return; await sleep(200); }
    throw new Error('等待超时：' + label);
  };
  const click = async selector => {
    const point = await c.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect();
      if (!r.width || !r.height) throw new Error('按钮不可见'); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const screenshot = async name => {
    const result = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, '20261123-wake-r9-' + name + '.png'), Buffer.from(result.data, 'base64'));
  };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, label: 'wake-r9', windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_E2E_FAKE_HOME: '1', CODEX_HOME: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until("typeof sessions !== 'undefined' && !!window.WorkspaceController", '界面就绪');
    await c.eval(`(() => {
      window.__wakeOriginalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      window.__wakeRequests = 0;
      window.__wakeRetryChecks = 0;
      ipcRenderer.invoke = (channel, ...args) => {
        if (channel === 'session:open-status') {
          if (args[1]?.reconcile) window.__wakeRetryChecks++;
          return Promise.resolve({ available: true });
        }
        if (channel === 'resume-session') { window.__wakeRequests++; return new Promise(resolve => { window.__wakeFinish = resolve; }); }
        if (channel === 'assistant:phone-session-prompts') return Promise.resolve([]);
        if (channel === 'parse-session-transcript' && args[0]?.hubSessionId === 'wake-r9') return Promise.resolve({ turns: [] });
        return window.__wakeOriginalInvoke(channel, ...args);
      };
      sessions.set('wake-r9', { id: 'wake-r9', title: '超时恢复验证', kind: 'codeagent', status: 'dormant', cwd: ${JSON.stringify(root)} });
      scheduleSessionListRender();
      return true;
    })()`);
    await until("!!document.querySelector('[data-session-id=\"wake-r9\"]')", '侧栏会话');
    const started = Date.now();
    await click('[data-session-id="wake-r9"]');
    await until("!!document.querySelector('.session-resume-spinner')", '开始唤醒');
    console.log('已开始真实 90 秒等待，隔离窗口保持隐藏');
    await until("document.querySelector('.session-resume-pending')?.textContent.includes('唤醒没有完成')", '90 秒超时出路', 105_000);
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs >= 89_000 && elapsedMs < 105_000, String(elapsedMs));
    const status = await c.eval("({ text: document.querySelector('.session-resume-pending').textContent, spinner: !!document.querySelector('.session-resume-spinner'), pending: sessions.get('wake-r9')._resumePending, requests: window.__wakeRequests })");
    assert.equal(status.spinner, false); assert.equal(status.pending, false); assert.equal(status.requests, 1);
    assert.equal(status.text, '唤醒没有完成重试新开会话接着聊');
    await screenshot('01-timeout'); steps.push({ step: '真实 90 秒超时停止转圈', elapsedMs, ...status });
    await click('.session-resume-actions button:last-child');
    await until("document.getElementById('new-session-menu')?.style.display === 'flex'", '原新建入口');
    assert.equal(await c.eval("sessions.get('wake-r9').status"), 'dormant');
    await click('#new-session-close');
    await click('[data-session-id="wake-r9"]');
    assert.equal(await c.eval("document.querySelector('.session-resume-pending')?.textContent"), '唤醒没有完成重试新开会话接着聊');
    await click('.session-resume-actions button:first-child');
    await until("!!document.querySelector('.session-resume-spinner')", '重试等待');
    assert.equal(await c.eval('window.__wakeRequests'), 1, '重试未重复发送启动请求');
    assert.equal(await c.eval('window.__wakeRetryChecks'), 1, '重试先核对原进程状态');
    await c.eval(`(() => {
      const session = { ...sessions.get('wake-r9'), status: 'idle' };
      ipcRenderer.emit('session-created', {}, { session });
      window.__wakeFinish(session);
      return true;
    })()`);
    await until("sessions.get('wake-r9')?.status === 'idle' && !document.querySelector('.session-resume-pending')", '迟到成功接回');
    assert.equal(await c.eval('window.__wakeRequests'), 1);
    await screenshot('02-success');
    steps.push({ step: '新建入口保留原会话；重试不重复启动；迟到成功移除提示', ok: true });
    console.log('PASS ' + JSON.stringify(steps));
    fs.writeFileSync(path.join(out, '20261123-wake-r9-e2e.json'), JSON.stringify({ ok: true, synthetic: true, steps }, null, 2));
  } catch (error) {
    if (c) await screenshot('failure').catch(() => {});
    fs.writeFileSync(path.join(out, '20261123-wake-r9-e2e.json'), JSON.stringify({ ok: false, error: error.stack, steps }, null, 2));
    throw error;
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

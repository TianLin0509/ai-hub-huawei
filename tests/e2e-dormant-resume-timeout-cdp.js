'use strict';

// 隔离 Hub + 注入未完成 IPC，真实等待 90 秒并用鼠标点击恢复按钮；不启动真实 CLI。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve('artifacts/20261123-wake-exit-codex');
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
      window.__wakeState = 'pending';
      window.__wakeHistoryReads = 0;
      ipcRenderer.invoke = (channel, ...args) => {
        if (channel === 'session:open-status') {
          return Promise.resolve({ available: true });
        }
        if (channel === 'resume-session:status') return Promise.resolve({ canRetry: window.__wakeState === 'ready' });
        if (channel === 'resume-session') {
          window.__wakeRequests++;
          window.__wakeState = 'pending';
          return new Promise((resolve, reject) => { window.__wakeFinish = resolve; window.__wakeFail = reject; });
        }
        if (channel === 'assistant:phone-session-prompts') return Promise.resolve([]);
        if (channel === 'parse-session-transcript' && args[0]?.hubSessionId === 'wake-r9') {
          window.__wakeHistoryReads++; return Promise.resolve({ turns: [] });
        }
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
    assert.equal(await c.eval("[...document.querySelectorAll('.session-resume-actions button')].filter(b => b.getBoundingClientRect().width > 0).map(b => b.textContent).join('|')"), '查看已有历史|在原目录新建会话');
    assert.equal(await c.eval('document.documentElement.scrollHeight <= innerHeight'), true, '1440×900 一屏可用');
    await screenshot('01-timeout'); steps.push({ step: '真实 90 秒超时停止转圈', elapsedMs, ...status });
    await click('.session-resume-actions button:last-child');
    await until("document.getElementById('new-session-menu')?.style.display === 'flex'", '原新建入口');
    assert.equal(await c.eval("sessions.get('wake-r9').status"), 'dormant');
    await click('#new-session-close');
    await click('[data-session-id="wake-r9"]');
    await click('.session-resume-actions button:nth-child(2)');
    await until("window.__wakeHistoryReads > 0 && !document.getElementById('msg-overlay').classList.contains('hidden')", '超时后查看已有历史');
    assert.equal(await c.eval('window.__wakeRequests'), 1, '查看历史不重复启动');
    await c.eval(`(() => {
      const session = { ...sessions.get('wake-r9'), status: 'idle' };
      ipcRenderer.emit('session-created', {}, { session });
      window.__wakeFinish(session);
      return true;
    })()`);
    await until("sessions.get('wake-r9')?.status === 'idle' && !document.querySelector('.session-resume-pending')", '迟到成功更新状态');
    assert.equal(await c.eval("document.getElementById('msg-overlay').classList.contains('hidden')"), false, '迟到成功不抢走历史界面');
    assert.equal(await c.eval('window.__wakeRequests'), 1);
    await screenshot('02-success');
    steps.push({ step: '超时可看历史、原目录新建；在途不提供假重试；迟到成功不抢历史界面', ok: true });
    // 明确失败后，再用真实按钮确认确实发出了新的唤醒请求。
    await c.eval(`(() => {
      sessions.get('wake-r9').status = 'dormant';
      _pendingDormantResumes.delete('wake-r9');
      window.__wakeState = 'ready';
      return true;
    })()`);
    await click('[data-session-id="wake-r9"]');
    await until('window.__wakeRequests === 2', '第二轮唤醒开始');
    await c.eval("window.__wakeState = 'ready'; window.__wakeFail(new Error('模拟启动失败')); true");
    await until("document.querySelector('.session-resume-pending.failed') && !document.querySelector('.session-resume-actions button:first-child').hidden", '失败后提供真正重试');
    await screenshot('03-failure');
    await click('.session-resume-actions button:first-child');
    await until('window.__wakeRequests === 3', '重试确实发出新请求');
    await c.eval(`(() => {
      const session = { ...sessions.get('wake-r9'), status: 'idle' };
      ipcRenderer.emit('session-created', {}, { session }); window.__wakeFinish(session); return true;
    })()`);
    await until("sessions.get('wake-r9').status === 'idle' && !document.querySelector('.session-resume-pending')", '新请求成功');
    assert.equal(await c.eval('window.__wakeRequests'), 3);
    steps.push({ step: '明确失败后点重试，确实发出新请求并成功接回', ok: true });
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

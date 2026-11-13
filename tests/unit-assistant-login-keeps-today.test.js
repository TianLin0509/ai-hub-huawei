'use strict';
// 登录过期或 CLI 超时的一轮，不能把今天已取到的数据写成空的。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');

test('登录过期、CLI 超时各一轮之后，早上的快照仍在', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-wipe-'));
  let mode = 'ok', clock = Date.parse('2026-11-06T10:00:00+08:00');
  const conv = { conversation_info: [{ target_account: 'z00123', native_name: '周工', group_id: '0', recent_conversation_type: 'CHAT_TYPE_P2P_MSG' }] };
  const hist = { resultCode: 0, respData: { chatInfo: [{ msgId: '10001', sender: 'z00123', content: '方案你看下', contentType: 'TEXT', serverSendTime: clock - 60000 }], msgTotalCount: 1, maxMsgId: 10001 } };
  const welinkRun = async args => {
    const c = args.slice(0, 2).join(' ');
    if (c === 'auth status') {
      if (mode === 'timeout') throw Object.assign(new Error('welink-cli 超过 30 秒没返回：auth status'), { code: 'WELINK_TIMEOUT' });
      return { code: 0, stdout: mode === 'expired' ? 'User Token: EXPIRED\nUID: u1\n' : 'User Token: VALID\nUID: u1\n', stderr: '' };
    }
    if (c === 'auth login') return { code: 0, stdout: 'Please scan the QR code', stderr: '' };
    if (c === 'im query-recent-conversation') return { code: 0, stdout: JSON.stringify(conv), stderr: '' };
    if (c === 'im query-history-message') return { code: 0, stdout: JSON.stringify(hist), stderr: '' };
    if (c === 'meeting query-list') return { code: 0, stdout: JSON.stringify({ code: 200, data: { total: 1, page: 1, size: 30, data: [{ meetingId: 'm1', subject: '方案评审', meetingStartTime: clock + 3600000, meetingEndTime: clock + 7200000 }] } }), stderr: '' };
    if (c === 'calendar list') return { code: 0, stdout: 'No events found.', stderr: '' };
    if (c === 'mail list') return { code: 0, stdout: JSON.stringify({ mails: [] }), stderr: '' };
    if (c === 'onebox user-info') return { code: 0, stdout: JSON.stringify({ email: 'mail-sample-user', name: '我' }), stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const a = new CompanyAssistant({ dataDir: dir, now: () => clock, noTimer: true, noTools: true, noPrewarm: true, bus: new NoticeBus(), welinkGate: { run: (_a, exec) => exec() }, welinkRun,
    getSession: () => null, createSession: async () => null, sendPrompt: async () => ({ ok: true }), roomCommand: ['x'] });
  try {
    fs.mkdirSync(a.dir, { recursive: true });
    // 只需要一个存在的 welink-cli 文件名（welinkRun 已注入，不会真的运行它）。
    const placeholder = path.join(dir, 'welink-cli.exe');
    fs.writeFileSync(placeholder, '');
    a.setSettings({ email: 'mail-sample-user', cliPath: placeholder });
    await a.refresh({ force: true });
    const before = a.status();
    assert.equal(before.counts.meetings, 1);
    assert.equal(before.counts.messages, 1);
    for (const m of ['expired', 'timeout']) {
      mode = m; clock += 30 * 60000;
      await a.refresh({ force: true }).catch(() => {});
      const after = a.status();
      assert.deepEqual(after.counts, before.counts, m);
      assert.equal(after.refreshedAt, before.refreshedAt, m + '：refreshedAt 只记成功的一轮');
      assert.doesNotThrow(() => a.sourceContext('msg:z00123:10001'), m);
    }
    assert.equal(a.snapshot().login.ok, true);
  } finally { a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

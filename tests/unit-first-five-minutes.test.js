'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const prep = require('../core/first-run-prep');
const history = require('../core/app-update/release-history');

function updates(t, { seen = '', result, archived, count = 3, features = {}, target = 'company' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-five-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'app-update'));
  for (const [name, data] of [['last-result.json', result], ['last-result.json.seen', archived]]) {
    if (data !== undefined) fs.writeFileSync(path.join(dir, 'app-update', name), typeof data === 'string' ? data : JSON.stringify(data));
  }
  const nodes = [], values = new Map(seen ? [['hub:whatsNew:lastSeenVersion', seen]] : []);
  const element = () => ({ className: '', innerHTML: '', style: {}, setAttribute() {}, addEventListener() {}, before() {},
    remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); } });
  const host = { prepend: node => nodes.push(node) };
  const document = { readyState: 'complete', createElement: element, getElementById: () => null,
    querySelector: () => host, head: { append() {} }, body: { appendChild: node => nodes.push(node) } };
  const entries = Array.from({ length: count }, (_, i) => ({ version: `1.0.${count - i}`, notes: [`改动 ${i}`] }));
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/whats-new.js'), 'utf8'), {
    document, window, localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    setTimeout: () => 1, clearTimeout() {}, require: name => {
      if (name === '../core/distribution') return { updateConfig: {}, editionVersion: `1.0.${count}`, target, featureEnabled: key => features[key] !== false };
      if (name === '../core/app-update/release-history') return { entriesSince: history.entriesSince, loadHistory: () => entries };
      if (name === '../core/data-dir') return { getHubDataDir: () => dir };
      return require(name);
    },
  });
  return { unread: window.__whatsNew.hasUnread(), notice: nodes.find(n => n.className === 'wn-notice'), values, dir };
}

test('缺已读记录时用有效升级来源提示，支持已消费的 .seen 与旧结果格式', t => {
  const result = { ok: true, from: '1.0.0', version: '1.0.3' };
  for (const name of ['result', 'archived']) {
    const f = updates(t, { [name]: result });
    assert.equal(f.unread, true); assert.match(f.notice.innerHTML, /已更新到 v1.0.3/);
    assert.equal(fs.existsSync(path.join(f.dir, 'app-update', name === 'result' ? 'last-result.json' : 'last-result.json.seen')), true);
  }
  for (const data of [undefined, '{', { ...result, ok: false }, { ...result, from: '1.0.3' }, { ...result, from: '1.0.4' },
    { ...result, from: 'invalid' }, { ok: true, version: '1.0.3' }]) {
    const f = updates(t, { result: data });
    assert.equal(f.unread, false); assert.equal(f.values.get('hub:whatsNew:lastSeenVersion'), '1.0.3');
  }
  assert.equal(updates(t, { result: { ...result, ok: false }, archived: result }).unread, false, '失败的新结果不沿用旧成功记录');
  assert.equal(updates(t, { result: { from: '1.0.0' } }).unread, true, '旧结果有来源版本即可回溯');
  assert.equal(updates(t, { result: { ...result, version: '1.0.2' } }).unread, true, '后续手动安装新版本仍保留可靠来源');
  assert.equal(updates(t, { seen: '1.0.3', result }).unread, false, '已读记录优先');
});

test('跨三个版本才显示固定导览，功能关闭后不在导览中出现', t => {
  assert.doesNotMatch(updates(t, { seen: '1.0.0', count: 2 }).notice.innerHTML, /这段时间新增了/);
  const f = updates(t, { seen: '1.0.0' });
  assert.match(f.notice.innerHTML, /这段时间新增了：助理整理工作信息；会议留存录音、原话和纪要；会议室自动抢订；PPT 找原页；帖子看发文和热帖；考勤看工时；还有桌宠、号池和/);
  assert.match(f.notice.innerHTML, /可选功能/);
  const trimmed = updates(t, { seen: '1.0.0', features: { companyAssistant: false, companyForum: false, companyAttendance: false, hubPet: false } });
  assert.doesNotMatch(trimmed.notice.innerHTML, /助理|会议|PPT|论坛|考勤|桌宠|可选功能/);
  const other = updates(t, { seen: '1.0.0', target: 'other' });
  assert.doesNotMatch(other.notice.innerHTML, /助理|会议|PPT|论坛|考勤|号池/);
});

test('准备摘要兼容旧记录，黄色、失败、等待计数，可选未安装不计数', () => {
  assert.equal(prep.pendingCount(null), null);
  assert.equal(prep.pendingCount({ at: 1 }), null);
  assert.equal(prep.pendingCount({ at: 1, problems: ['login'] }), 1);
  const rows = Object.fromEntries(['ok', 'warn', 'bad', 'hold', 'off'].map(status => [status, { status }]));
  assert.equal(prep.pendingCount({ at: 1, rows }), 3);
});

test('局部同步保留其他准备结果和待处理项，不会把历史警告丢掉', async () => {
  let saved;
  const old = { rows: { clock: { id: 'clock', status: 'warn' }, disk: { id: 'disk', status: 'bad' } }, problems: ['disk', 'login'] };
  await prep.createPrep({ isCompany: true, deps: {
    discover: async () => {}, codeagentFile: () => 'fake', envCheck: async () => ({ items: [{ id: 'codeagent', status: 'ok' }] }),
    loginState: async () => 'ready', readModels: async () => ({ skipped: true }), proxyEnabled: () => false,
    readState: () => old, saveState: state => { saved = state; },
  } }).run('changed');
  assert.equal(saved.rows.clock.status, 'warn'); assert.equal(saved.rows.disk.status, 'bad');
  assert.deepEqual(saved.problems, ['disk']); assert.equal(prep.pendingCount(saved), 2);
});

'use strict';
// Real signed 2.1.1 -> 2.1.2 helper upgrade, no browser jobs or network.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { CompanyAssistant } = require('../core/company-assistant/service');
const component = require('../core/company-assistant/room-component');
const { stageRuntime } = require('../core/company-assistant/room-component/build-runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-upgrade-'));
const bundle = path.join(root, 'old/core/company-assistant/room-component');
const original = path.resolve(__dirname, '../core/company-assistant/room-component');
const oldBundle = process.env.ROOM_UPGRADE_BASE_BUNDLE;
const out = path.resolve(process.env.ROOM_UPGRADE_OUT || path.join(__dirname, '../artifacts/room-upgrade.json'));
const result = { root, checks: [] };
let a;
(async () => {
  try {
    assert.ok(oldBundle, 'ROOM_UPGRADE_BASE_BUNDLE must point to an official signed 2.1.1 bundle');
    assert.ok(process.env.MSZ_SOURCE, 'MSZ_SOURCE required');
    const oldManifest = component.manifest(path.join(oldBundle, 'control.json'));
    assert.equal(oldManifest.version, '2.1.1');
    assert.ok(component.verified(path.join(oldBundle, oldManifest.code.file), oldManifest.code));
    fs.mkdirSync(bundle, { recursive: true });
    for (const f of ['baseline.json', 'control.json', oldManifest.code.file]) fs.copyFileSync(path.join(oldBundle, f), path.join(bundle, f));
    stageRuntime({ appDir: path.join(root, 'old'), source: path.join(process.env.MSZ_SOURCE, 'release/v2.1.0/MishuTerminator-2.1.0.exe') });
    a = new CompanyAssistant({ dataDir: path.join(root, 'data'), noTimer: true, noTools: true, roomBundle: bundle, roomProcesses: async () => [], roomEnv: { MSZ_HUB_TEST_INSTANCE: 'room-upgrade-' + process.pid } });
    const home = a.rooms.home(); fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ 主题: '升级前的会议', 优先会议室: ['保留会议室'], 抢订设置: { 最大重试次数: 8 }, 会后动作: { 模式: '不动作', 小鲁班ID: '保留接收人' } }));
    fs.writeFileSync(path.join(home, 'booking_history.json'), JSON.stringify([{ 状态: '成功', 日期: '2026-10-28', 会议室: '历史会议室' }]));
    fs.mkdirSync(path.join(home, 'browser_profile')); fs.writeFileSync(path.join(home, 'browser_profile', 'fixture-preserve'), 'existing profile marker');
    await a.rooms.ensure(); const before = a.rooms.helper(); assert.equal(before.version, '2.1.1');
    a.rooms.deps.roomBundle = original;
    await a.rooms.reconnect(); const after = a.rooms.helper();
    assert.equal(after.version, '2.1.2'); assert.notEqual(after.pid, before.pid); assert.equal(after.running, false);
    assert.equal(after.rules.主题, '升级前的会议'); assert.deepEqual(after.rules.优先会议室, ['保留会议室']);
    assert.equal(after.preferences.抢订设置.最大重试次数, 8); assert.equal(after.preferences.会后动作.小鲁班ID, '保留接收人');
    assert.equal(after.history[0].会议室, '历史会议室'); assert.equal(fs.readFileSync(path.join(home, 'browser_profile', 'fixture-preserve'), 'utf8'), 'existing profile marker');
    result.checks.push('real signed idle 2.1.1 helper replaced with 2.1.2 after exact cached executable identity check', 'rules, advanced settings, post-action recipient, original history and browser profile preserved', 'upgraded helper remains stopped; no booking is triggered');
    result.before = { pid: before.pid, version: before.version }; result.after = { pid: after.pid, version: after.version }; result.ok = true;
  } catch (e) { result.ok = false; result.error = e.stack; process.exitCode = 1; }
  finally {
    if (a) {
      const helper = a.rooms.helper();
      if (helper?.pid) { try { await component.stopManagedHelper(helper, a.settings().rooms.exePath); } catch (e) { result.teardownError = e.message; } }
      a.close();
    }
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  }
})();

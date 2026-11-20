'use strict';
// CodeAgent 自己的完成提醒（反馈 1ce04c14；11-20 三档）：默认 auto＝Hub 回执或桌宠在提醒时关；只改子进程环境副本，用户自己设过的不覆盖。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../core/codeagent-cli-notify');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-notify-'));
const pet = obj => fs.writeFileSync(path.join(dir, 'hub-pet.json'), JSON.stringify(obj));
const envFor = () => m.applyCliNotifyEnv({ PATH: 'x' }, { dataDir: dir });
try {
  // 全新数据目录：默认 auto，桌宠设置也没有＝回执默认交给桌宠/小卡，Hub 会提醒 → 关 CodeAgent 的
  assert.strictEqual(m.getMode(dir), 'auto');
  assert.deepStrictEqual(m.state(dir), { mode: 'auto', hubNotifies: true, suppress: true });
  assert.strictEqual(envFor().OPENTUI_NOTIFICATIONS, '0');

  // Hub 回执关了、桌宠也没开：auto 不关，免得两边都不提醒
  pet({ notifyMode: 'off', enabled: false });
  assert.strictEqual(m.state(dir).suppress, false);
  assert.ok(!('OPENTUI_NOTIFICATIONS' in envFor()));
  // 回执关了但桌宠开着：算 Hub 在提醒
  pet({ notifyMode: 'off', enabled: true });
  assert.strictEqual(m.state(dir).suppress, true);
  // 右下角小卡：Hub 在提醒
  pet({ notifyMode: 'popup', enabled: false });
  assert.strictEqual(m.state(dir).suppress, true);

  // 总是关 / 保留
  pet({ notifyMode: 'off', enabled: false });
  m.setMode('hub', dir);
  assert.strictEqual(envFor().OPENTUI_NOTIFICATIONS, '0');
  m.setMode('own', dir);
  pet({ notifyMode: 'pet', enabled: true });
  assert.ok(!('OPENTUI_NOTIFICATIONS' in envFor()));
  assert.throws(() => m.setMode('loud', dir));

  // 11-19 首版文件只存 own：true→own，false→auto
  fs.writeFileSync(path.join(dir, m.FILE), JSON.stringify({ own: true }));
  assert.strictEqual(m.getMode(dir), 'own');
  fs.writeFileSync(path.join(dir, m.FILE), JSON.stringify({ own: false }));
  assert.strictEqual(m.getMode(dir), 'auto');

  // 用户自己设过就照用户的（大小写不同也算）
  const user = m.applyCliNotifyEnv({ OPENTUI_NOTIFICATION_PROTOCOL: 'osc9' }, { suppress: true });
  assert.ok(!('OPENTUI_NOTIFICATIONS' in user));
  const lower = m.applyCliNotifyEnv({ opentui_notifications: '1' }, { suppress: true });
  assert.ok(!('OPENTUI_NOTIFICATIONS' in lower));
  // 空值等于没设
  const empty = m.applyCliNotifyEnv({ opentui_notifications: ' ' }, { suppress: true });
  assert.deepStrictEqual(empty, { OPENTUI_NOTIFICATIONS: '0' });
  console.log('unit-codeagent-cli-notify ok');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

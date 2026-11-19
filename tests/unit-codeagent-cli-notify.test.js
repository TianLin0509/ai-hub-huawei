'use strict';
// CodeAgent 自己的完成提醒默认关（反馈 1ce04c14）：只改子进程环境副本，用户自己设过的不覆盖。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../core/codeagent-cli-notify');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-notify-'));
try {
  assert.strictEqual(m.getCliNotify(dir), false, '没有文件时默认只留 Hub 的');
  const env = { PATH: 'x' };
  m.applyCliNotifyEnv(env, { own: false });
  assert.strictEqual(env.OPENTUI_NOTIFICATIONS, '0');
  const own = { PATH: 'x' };
  m.applyCliNotifyEnv(own, { own: true });
  assert.ok(!('OPENTUI_NOTIFICATIONS' in own), '勾上后不关 CodeAgent 的');
  const user = { OPENTUI_NOTIFICATION_PROTOCOL: 'osc9' };
  m.applyCliNotifyEnv(user, { own: false });
  assert.ok(!('OPENTUI_NOTIFICATIONS' in user), '用户自己设过就照用户的');
  const lower = { opentui_notifications: '1' };
  m.applyCliNotifyEnv(lower, { own: false });
  assert.ok(!('OPENTUI_NOTIFICATIONS' in lower), '大小写不同也算用户设过');
  assert.strictEqual(m.setCliNotify(true, dir), true);
  assert.strictEqual(m.getCliNotify(dir), true);
  assert.strictEqual(m.setCliNotify(false, dir), false);
  assert.strictEqual(m.getCliNotify(dir), false);
  console.log('unit-codeagent-cli-notify ok');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

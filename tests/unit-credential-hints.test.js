'use strict';
// N8（2026-11-23）：要输账号密码 / Key 的地方旁边有 ⓘ，写明存在哪、有没有加密、发给谁——按实际存储如实写。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const hints = require('../renderer/credential-hints');
const { iconHintHtml } = require('../renderer/launch-field-hint');
const vault = require('../core/claude-mailbox-vault');

test('iconHintHtml renders the shared ⓘ icon with an escaped hover text, empty text renders nothing', () => {
  const html = iconHintHtml('标题\n含 "引号" 与 <尖括号> & 符号');
  assert.match(html, /^<span class="field-hint-icon" tabindex="0" role="img" data-tip-side="top" data-hub-tip-focus="1"/);
  assert.ok(html.includes('title="标题\n含 &quot;引号&quot; 与 &lt;尖括号&gt; &amp; 符号"'));
  assert.ok(!/<尖括号>/.test(html));
  assert.equal(iconHintHtml(''), '');
});

test('hint texts match the real storage: encrypted ones name DPAPI and the file, unencrypted ones say so', () => {
  const data = path.join('D:', 'hubdata');
  const mail = hints.mailboxSecret(data);
  assert.ok(mail.includes(path.join(data, vault.FILE)));
  assert.match(mail, /DPAPI/);
  const gw = hints.gatewayKey(data);
  assert.ok(gw.includes(path.join(data, 'api-gateway', 'gateway.json')));
  assert.match(gw, /DPAPI/);
  const own = hints.ownApiKey(data);
  assert.ok(own.includes(path.join(data, 'config.json')));
  assert.match(own, /DPAPI/);
  assert.match(own, /safeStorage/);
  assert.match(own, /config\.json\.bak/);
  assert.match(own, /加密与保存成功后清除明文字段/);
  assert.match(own, /按读取迁移，未读取的历史快照保留原状/);
  assert.match(own, /保存并继续/);
  assert.match(own, /lan-pool\/settings\.json/);
  assert.match(own, /旧明文快照迁移失败仍可恢复/);
  assert.match(own, /新建快照加密失败则停止启动/);
  assert.match(own, /connection.json/);
  assert.match(own, /auth.json.*明文/);
  const att = hints.attendanceLogin();
  assert.match(att, /不读取、不保存、不外传密码/);
  assert.match(att, /Partitions\\company-forum/);
  assert.match(att, /没有另外加密/);
  const room = hints.roomLogin(path.join('D:', 'room'));
  assert.ok(room.includes(path.join('D:', 'room', 'browser_profile')));
  assert.match(room, /不读取、不保存、不外传密码/);
});

test('password inputs in the mailbox forms carry the ⓘ, plain fields do not', () => {
  const { mailboxHtml } = require('../renderer/account-workspace-view');
  const esc = s => String(s);
  const html = mailboxHtml({ profileId: 'p1' }, { accounts: {} }, esc, { mode: 'mail', profileId: 'p1', mail: {} });
  const labels = html.split('<label>').slice(1);
  const pwd = labels.filter(l => /type="password"/.test(l));
  assert.ok(pwd.length >= 2);
  for (const l of pwd) assert.match(l, /field-hint-icon/);
  for (const l of labels.filter(l => !/type="password"/.test(l))) assert.doesNotMatch(l, /field-hint-icon/);
});

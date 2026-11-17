'use strict';
// 关掉的可选功能收起左侧导航入口（2026-11-18 用户反馈「建议关闭了的功能可以隐藏左侧菜单」）。
// 从没在「可选功能」里选过的新用户照旧看到全部入口；选过之后，关着的那几项不再显示。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createOptionalFeatures, FILE } = require('../core/optional-features');

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'of-nav-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('新用户（没选过）：全部关着但导航入口都保留', t => {
  const of = createOptionalFeatures({ dataDir: tmp(t), logger: {} });
  for (const id of ['assistant', 'forum', 'attendance', 'w3']) { assert.equal(of.get(id), false); assert.equal(of.navHidden(id), false, id); }
});

test('用户亲手关掉一项：只收起这一项；开着的、没碰过的照常显示；重开后恢复', t => {
  const dir = tmp(t);
  const of = createOptionalFeatures({ dataDir: dir, logger: {} });
  of.set('forum', true); of.set('forum', false); of.set('w3', true); of.set('tray', true);
  assert.equal(of.navHidden('forum'), true);
  assert.equal(of.navHidden('w3'), false, '开着的不藏');
  assert.equal(of.navHidden('attendance'), false, '没碰过的不藏（只开了托盘，不连累其他入口）');
  of.set('attendance', false); // 「还没开启」页上点「不用，收起左侧入口」
  assert.equal(of.navHidden('attendance'), true);
  const again = createOptionalFeatures({ dataDir: dir, logger: {} });
  assert.equal(again.navHidden('forum'), true, '重启后仍收起'); assert.equal(again.navHidden('w3'), false);
  again.set('forum', true);
  assert.equal(again.navHidden('forum'), false, '重新开启后入口回来');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')).navHidden, ['attendance']);
});

test('老文件（没有 navHidden 字段）：升级后入口都在，开关值照旧', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ assistant: true, forum: false, attendance: false, w3: false, tray: false }));
  const of = createOptionalFeatures({ dataDir: dir, logger: {} });
  assert.equal(of.get('assistant'), true);
  for (const id of ['assistant', 'forum', 'attendance', 'w3']) assert.equal(of.navHidden(id), false, id);
});

test('界面：主进程清单里 navHidden 的项，在 <html> 上记下并由 CSS 藏对应按钮', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/optional-features.js'), 'utf8');
  for (const id of ['btn-company-assistant', 'btn-company-forum', 'btn-company-attendance', 'btn-company-w3']) assert.match(src, new RegExp('#' + id));
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  for (const id of ['assistant', 'forum', 'attendance', 'w3']) assert.ok(main.includes(`navHidden: optionalFeatures.navHidden('${id}')`), id);
});

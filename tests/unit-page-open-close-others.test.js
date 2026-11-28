'use strict';
// 分身、员工助手、广场这类「自己监听 body 上别的 *-page-open 就关掉自己」的页面，打开时必须先把所有整页关掉，
// 否则从社区/PPT 页点过去会被自己的监听当场关回首页（2026-11-28 黄区真机：社区页点「员工助手」没反应）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const hooksIn = name => {
  const at = src.indexOf(['require(', "'./", name, "')"].join(''));
  assert.ok(at > 0, '找不到 ' + name);
  const list = src.slice(at, at + 1500).match(/for \(const key of \[([^\]]+)\]/);
  assert.ok(list, name + ' 没有关其它页的清单');
  return new Set(list[1].split(',').map(s => s.trim().replace(/'/g, '')));
};

for (const name of ['avatar-page', 'weclaw-page', 'skill-plaza-page']) {
  test(`${name} 打开时会关掉社区、PPT、门户等整页`, () => {
    const hooks = hooksIn(name);
    for (const h of ['__communityHide', '__companyPptHide', '__companyW3Hide', '__companyForumHide', '__companyAttendanceHide', '__welinkBlackboardHide']) {
      assert.ok(hooks.has(h), `${name} 缺 ${h}`);
    }
  });
}

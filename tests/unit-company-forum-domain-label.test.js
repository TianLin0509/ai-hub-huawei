'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../renderer/company-forum-page.js'), 'utf8');
const line = src.split('\n').find(l => l.includes("const from = "));
const labelFor = data => new Function('data', line + ' return from;')(data);

test('域名已自动找到时，来源说明不再写「还不知道」', () => {
  for (const domainFrom of ['default', 'cache', 'welink', 'assistant-email', 'forum-settings', 'settings', 'email']) {
    assert.notEqual(labelFor({ domain: 'corp.example', domainFrom }), '还不知道', domainFrom);
  }
});

test('确实没有域名时才写「还不知道」', () => {
  assert.equal(labelFor({ domain: '', domainFrom: '' }), '还不知道');
});

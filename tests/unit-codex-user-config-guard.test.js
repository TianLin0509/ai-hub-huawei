'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isHubOwnedCodexHome, repairHubCodexConfigText, repairUserCodexConfigFile } = require('../core/codex-user-config-guard');

const HUB_TAIL = '\n[notice]\nhide_full_access_warning = true\nhide_rate_limit_model_nudge = true\n\n[windows]\nsandbox = "unelevated"\n';

test('只有 Hub 数据目录下的 CODEX_HOME 算 Hub 自己的', () => {
  const hub = path.join(os.tmpdir(), 'hub-data');
  assert.equal(isHubOwnedCodexHome(path.join(hub, 'codex-api-profile'), hub), true);
  assert.equal(isHubOwnedCodexHome(null, hub), false, '未指定 = 用户全局 ~/.codex');
  assert.equal(isHubOwnedCodexHome(path.join(os.homedir(), '.codex'), hub), false);
  assert.equal(isHubOwnedCodexHome(hub + '-other', hub), false, '同前缀的兄弟目录不算');
});

test('粘行 [windows]sandbox 拆开并还原为 elevated', () => {
  const broken = '[windows]sandbox = "unelevated"\n\n[notice]\nhide_full_access_warning = true\nhide_rate_limit_model_nudge = true\n';
  const r = repairHubCodexConfigText(broken);
  assert.equal(r.changed, true);
  assert.match(r.text, /^\[windows\]\nsandbox = "elevated"\n/);
});

test('键粘在上一条键值后面也拆开', () => {
  const r = repairHubCodexConfigText('[notice]\nfoo = 1hide_full_access_warning = true\n');
  assert.equal(r.text, '[notice]\nfoo = 1\nhide_full_access_warning = true\n');
});

test('点号键 / 内联表 / 表头带注释 / notice 点号键：删掉 Hub 追加的重复块', () => {
  for (const head of ['model = "gpt-5"\nwindows.sandbox = "elevated"\n', 'windows = { sandbox = "elevated" }\n', '[windows] # mine\nsandbox = "elevated"\n']) {
    const r = repairHubCodexConfigText(head + HUB_TAIL);
    assert.equal(r.changed, true, head);
    assert.equal((r.text.match(/^\[windows\]$/mg) || []).length, 0, head);
    assert.match(r.text, /hide_rate_limit_model_nudge = true/, '不冲突的 [notice] 块保留');
  }
  const r = repairHubCodexConfigText('notice.hide_full_access_warning = true\n' + HUB_TAIL);
  assert.equal((r.text.match(/^\[notice\]$/mg) || []).length, 0);
  assert.match(r.text, /^\[windows\]\nsandbox = "unelevated"$/m);
});

test('正常文件、合法相似写法一字不改', () => {
  const ok = [
    'model = "gpt-5"\n' + HUB_TAIL,
    '[notice.model_migrations]\n"gpt-5" = "gpt-5.1"\n' + HUB_TAIL,
    'my_sandbox = "unelevated"\n',
    '# 注释 sandbox = "unelevated"\n',
    '[windows]\nsandbox = "elevated"\r\n',
    '[notice]\r\nhide_full_access_warning = true\r\n',
  ];
  for (const text of ok) assert.deepEqual(repairHubCodexConfigText(text), { text, changed: false, fixes: [] }, text);
});

test('写文件前留备份，文件不存在时不建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-guard-'));
  try {
    const file = path.join(dir, 'config.toml');
    assert.deepEqual(repairUserCodexConfigFile(file, { logger: {} }), { changed: false, fixes: [], error: null });
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, '[windows]sandbox = "unelevated"\n');
    const r = repairUserCodexConfigFile(file, { logger: {} });
    assert.equal(r.changed, true);
    assert.equal(fs.readFileSync(r.backup, 'utf8'), '[windows]sandbox = "unelevated"\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '[windows]\nsandbox = "elevated"\n');
    assert.equal(repairUserCodexConfigFile(file, { logger: {} }).changed, false, '修好后再跑不动');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

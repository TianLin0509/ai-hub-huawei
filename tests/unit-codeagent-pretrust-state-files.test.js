'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureCodeAgentProjectTrusted, toClaudeProjectKey } = require('../core/claude-project-trust.js');
const { detectTrustDialogInLines } = require('../core/claude-trust-dialog.js');

function setup(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-'));
  const configDir = path.join(home, '.cac');
  const work = path.join(home, 'work');
  fs.mkdirSync(configDir); fs.mkdirSync(work);
  const inner = path.join(configDir, '.cac.json');
  const root = path.join(home, '.cac.json');
  if (files.includes('inner')) fs.writeFileSync(inner, '{"numStartups":1}');
  if (files.includes('root')) fs.writeFileSync(root, '{"numStartups":2}');
  const trusted = f => {
    const projects = JSON.parse(fs.readFileSync(f, 'utf8')).projects || {};
    return projects[toClaudeProjectKey(work)]?.hasTrustDialogAccepted === true;
  };
  const run = () => ensureCodeAgentProjectTrusted(work, { configDir, stateFileName: '.cac.json', homeDir: home });
  return { home, inner, root, trusted, run };
}

test('状态文件只在用户目录根下（1.2615.02.02）：信任写到根下，不再报文件缺失', t => {
  const s = setup(['root']);
  t.after(() => fs.rmSync(s.home, { recursive: true }));
  const r = s.run();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.trusted(s.root), true);
  assert.strictEqual(fs.existsSync(s.inner), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(s.root, 'utf8')).numStartups, 2);
});

test('状态文件在配置目录里（1.2615.02.03）：照常写', t => {
  const s = setup(['inner']);
  t.after(() => fs.rmSync(s.home, { recursive: true }));
  assert.strictEqual(s.run().ok, true);
  assert.strictEqual(s.trusted(s.inner), true);
  assert.strictEqual(fs.existsSync(s.root), false);
});

test('两处都有：两处都写', t => {
  const s = setup(['inner', 'root']);
  t.after(() => fs.rmSync(s.home, { recursive: true }));
  s.run();
  assert.strictEqual(s.trusted(s.inner), true);
  assert.strictEqual(s.trusted(s.root), true);
});

test('两处都没有：不凭空创建，报文件缺失交给调用方等待', t => {
  const s = setup([]);
  t.after(() => fs.rmSync(s.home, { recursive: true }));
  assert.strictEqual(s.run().reason, 'state-missing');
  assert.strictEqual(fs.existsSync(s.root), false);
});

test('绿区真机信任框原文：光标在信任行时直接回车', () => {
  const lines = [
    'Accessing workspace:',
    "Quick safety check: Is this a project you created or one you trust? If not, review what's in this folder first",
    'These will apply without asking. Only proceed if you trust this configuration.',
    'Detected security risks (review each item before trusting):',
    '> Yes, I trust this folder',
    '  No, exit',
    'Select option ↑ ↓ | Scroll risks Ctrl+↑ ↓ | Confirm Enter | No, exit Esc',
  ];
  assert.deepStrictEqual(detectTrustDialogInLines(lines, { cursorOnTrustIsEnough: true }).keys, ['\r']);
});

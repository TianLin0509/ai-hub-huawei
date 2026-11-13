'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const models = require('../core/codeagent-models');
const picker = require('../core/codeagent-model-picker');
const probe = require('../core/codeagent-model-probe');
const { createSessionWithModelPolicy } = require('../main/session-model-creation');
const { runAsk, buildArgs, sessionModel } = require('../main/ask-aside/service');

const TARGET = 'GLM-5.2-Auto(Volcano-MaaS)';
const SECOND = 'GLM-5.3-Auto(Baidu-MaaS)';
const CC = '0f1d0937-bf2e-4347-9348-56b3a37ff7bc';
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parenthesized-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function json(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }

test('company model ids preserve parentheses while refusing control and shell characters', () => {
  for (const id of [TARGET, SECOND, 'DeepSeek-V4.1[1m]', 'GLM-5.2', 'GLM-5.2-Auto/' + 'x'.repeat(80)]) {
    assert.equal(models.isSafeModelId(id), true, id);
    assert.equal(models.normalizeModel(id), id);
    assert.equal(probe.cleanModelId(id), id);
  }
  for (const id of ['not a model', 'GLM-5.2 Auto', '--model', '-GLM-5.2', 'GLM-5.2" --tools all', 'GLM-5.2;whoami', 'GLM-5.2&whoami',
    'GLM-5.2|whoami', 'GLM-5.2%PATH%', 'GLM-5.2`whoami', 'GLM-5.2$(whoami)', 'GLM-5.2\n',
    '\rGLM-5.2', 'GLM-5.2\tAuto', 'GLM-5.2\0', 'GLM-5.2\x7f']) {
    assert.equal(models.isSafeModelId(id), false, JSON.stringify(id));
    assert.equal(buildArgs(CC, { model: id }).includes('--model'), false, JSON.stringify(id));
  }
  assert.equal(models.isSafeModelId('G'.repeat(97)), false);
  assert.equal(buildArgs(CC, { model: 'G'.repeat(101) }).includes('--model'), false);
});

test('account catalogs and legacy configuration scans retain the exact parenthesized model ids', t => {
  const dataDir = temp(t), configDir = path.join(dataDir, 'account'); fs.mkdirSync(configDir);
  json(path.join(configDir, '.cac.json'), { enterpriseModelOptionsCache: [
    { value: TARGET, contextWindow: 200000 }, { value: SECOND }, { value: 'GLM-5.2&invalid' },
  ] });
  const catalog = models.configuredModels(configDir);
  assert.equal(catalog.authoritative, true);
  assert.deepEqual(catalog.models, [TARGET, SECOND]);
  models.recordMenu(dataDir, [TARGET, SECOND], { key: 'personal', complete: true });
  assert.deepEqual(models.modelOptions(dataDir, { configDir }).map(row => row.id), [TARGET, SECOND]);
  assert.deepEqual(models.contextWindowFor(configDir, [TARGET]), { window: 200000, source: 'account' });
  const legacyDir = path.join(dataDir, 'legacy'); fs.mkdirSync(legacyDir);
  json(path.join(legacyDir, '.cac.json'), { tieredModelConfig: { [TARGET]: {}, [SECOND]: {} }, history: { model: 'GLM-99.9-Auto(History)' } });
  assert.deepEqual(models.configuredModels(legacyDir).models, [TARGET, SECOND]);
  const textScan = new Set();
  models.scanModelNamesInText(JSON.stringify({ modelOptions: [TARGET, SECOND] }), textScan);
  assert.deepEqual([...textScan], [TARGET, SECOND]);
});

test('menu targeting and explicit session creation keep the chosen model instead of defaulting', () => {
  const parsed = picker.parsePicker([
    'Select model', '模型名称  Credit消耗系数',
    '❯ 1. GLM-5.2-WX-Auto default ✓', `  2. ${TARGET}  1x`, `  3. ${SECOND}  1x`,
    'Navigate ↑ ↓ | Select enter | Back esc',
  ]);
  assert.ok(parsed);
  assert.equal(parsed.rows[picker.findTarget(parsed, TARGET)].label, TARGET);
  assert.equal(parsed.rows[picker.findTarget(parsed, SECOND)].label, SECOND);
  let received;
  const result = createSessionWithModelPolicy({ kind: 'codeagent', opts: { model: TARGET, codeagentModelPick: true },
    create: (kind, opts) => { received = { kind, opts }; return { id: 'new-session' }; } });
  assert.equal(result.id, 'new-session');
  assert.equal(received.opts.model, TARGET);
  assert.equal(received.opts.fixedModel, TARGET);
  assert.equal(received.opts.modelPinSource, 'user');
});

test('ask-aside follows the parenthesized current model and quotes it in the Windows command', async t => {
  const dir = temp(t); json(path.join(dir, 'settings.json'), { model: TARGET });
  assert.equal(sessionModel({}, dir), TARGET);
  assert.equal(sessionModel({ currentModel: { id: SECOND } }, dir), SECOND);
  for (const model of [TARGET, SECOND]) {
    let call;
    const spawnFn = (file, args, opts) => {
      call = { file, args, opts };
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on('finish', () => setImmediate(() => { child.stdout.write('answer'); child.emit('close', 0); }));
      return child;
    };
    await runAsk({ config: { command: 'codeagent', configDir: dir }, cwd: dir, ccSessionId: CC,
      question: 'question', model, spawnFn, platform: 'win32', env: {} });
    assert.equal(call.opts.windowsHide, true);
    assert.equal(call.opts.windowsVerbatimArguments, true);
    assert.ok(call.args.at(-1).includes(`--model "${model}"`));
    const argv = buildArgs(CC, { model });
    assert.equal(argv[argv.indexOf('--model') + 1], model);
  }
});

test('real hidden Windows cmd passes a parenthesized model as one CLI argument', { skip: process.platform !== 'win32' }, async t => {
  const dir = temp(t), cli = path.join(dir, 'fake-cli.cjs'), cmd = path.join(dir, 'fake-cli.cmd');
  fs.writeFileSync(cli, "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),input:text})));\n");
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  for (const model of [TARGET, SECOND]) {
    for (const input of ['stdin', 'arg']) {
      const result = await runAsk({ config: { command: cmd, configDir: dir }, cwd: dir, ccSessionId: CC,
        question: 'question (keep together)', model, mode: { input }, timeoutMs: 10000 });
      const captured = JSON.parse(result.answer);
      assert.equal(captured.args[captured.args.indexOf('--model') + 1], model);
      assert.equal(captured.args.filter(arg => arg === model).length, 1);
      assert.equal(captured.args.includes('--no-session-persistence'), true);
      if (input === 'arg') assert.ok(captured.args.at(-1).includes('question (keep together)'));
      else assert.ok(captured.input.includes('question (keep together)'));
    }
  }
});

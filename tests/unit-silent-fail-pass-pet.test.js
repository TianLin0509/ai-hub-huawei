'use strict';
// 按钮静默失败收尾（2026-11-21）：
// 1. 命令行安装区「打开放行页」：以前不管放没放行都直接重装一次，打不开时只看到「安装又失败一次」；
//    现在没放行就不重装，在按钮旁写原因和下一步。
// 2. 桌宠设置：以前保存失败一律吞掉（写盘失败只记日志），开关看着变了、重启又回去；现在在开关旁写「没存上」的原因和下一步。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const view = require('../renderer/cli-install-view');
const { saveFailureText } = require('../renderer/hub-pet/pet-save-status');
const { createSettingsStore } = require('../core/hub-pet/settings');
const { mountPetSettingsTab } = require('../renderer/hub-pet/pet-settings-tab');

test('放行页：放行成功才自动重试安装；打不开、被关掉、超时都不重试，并说清原因与下一步', () => {
  assert.deepEqual(view.passOutcome({ passed: true }), { retry: true, note: '' });
  const thrown = view.passOutcome(null, new Error('No handler registered'));
  assert.equal(thrown.retry, false);
  assert.match(thrown.note, /放行页没打开：No handler registered/);
  assert.match(thrown.note, /再点一次「打开放行页」/);
  assert.match(view.passOutcome(null).note, /没有收到结果/);
  assert.match(view.passOutcome({ passed: false, error: '放行页地址无效' }).note, /放行页没打开：放行页地址无效/);
  assert.match(view.passOutcome({ passed: false, timedOut: true }).note, /3 分钟还没放行/);
  const closed = view.passOutcome({ passed: false, closed: true });
  assert.equal(closed.retry, false);
  assert.match(closed.note, /还没放行成功，所以这次没有重试安装/);
});

test('放行页：没放行的原因显示在「打开放行页」按钮旁，并做转义', () => {
  const state = { available: true, catalog: [], tools: { claude: { phase: 'error', error: '下载被拦', blocked: 'https://m.example/x.tgz' } } };
  const html = view.installBlockHtml('claude', state, { passNote: '放行页没打开：<坏>' });
  const at = html.indexOf('data-cli-action="open-pass"');
  const note = html.indexOf('cli-install-pass-note');
  assert.ok(at > 0 && note > at, '原因紧跟在放行按钮那一段后面');
  assert.match(html, /role="alert">放行页没打开：&lt;坏&gt;</);
  assert.doesNotMatch(view.installBlockHtml('claude', state), /cli-install-pass-note/, '没有原因时不多一行');
  // 已经不被拦了（例如重试后成功），旧原因不再显示
  assert.doesNotMatch(view.installBlockHtml('claude', { ...state, tools: { claude: { phase: 'idle' } } }, { passNote: 'x' }), /cli-install-pass-note/);
});

test('放行页：启动中心安装弹窗按 passOutcome 决定是否重装，不再吞掉错误', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-api-settings.js'), 'utf8');
  const handler = src.slice(src.indexOf('[data-cli-action="open-pass"]'), src.indexOf('[data-cli-action="cancel"]'));
  assert.match(handler, /cliView\.passOutcome\(opened, failure\)/);
  assert.match(handler, /if \(outcome\.retry\) return void runInstall/);
  assert.doesNotMatch(handler, /catch \(_\) \{\}/);
});

test('桌宠设置写盘失败：设置库记下原因，成功写一次就清掉', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-save-'));
  const blocker = path.join(root, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');   // dataDir 是个文件 → mkdir/写入必失败
  const bad = createSettingsStore({ dataDir: blocker, logger: { warn() {} } });
  assert.equal(bad.lastSaveError(), null);
  bad.update({ enabled: true });
  const err = bad.lastSaveError();
  assert.ok(err && err.message, '记下了失败原因');
  assert.equal(bad.get().enabled, true, '内存里已生效');
  const good = createSettingsStore({ dataDir: path.join(root, 'ok'), logger: { warn() {} } });
  good.update({ enabled: true });
  assert.equal(good.lastSaveError(), null);
  assert.ok(fs.existsSync(good.file));
});

test('桌宠设置「没存上」的说法：调用失败、没回结果、写盘失败各有原因和下一步；存好了不说话', () => {
  assert.equal(saveFailureText({ settings: {} }, null), '');
  assert.match(saveFailureText(null, new Error('boom')), /没存上：boom。开关已恢复成原来的样子，请再点一次/);
  assert.match(saveFailureText(null, null), /没有收到保存结果/);
  const disk = saveFailureText({ settings: {}, saveError: { code: 'ENOSPC', message: 'no space' } }, null);
  assert.match(disk, /已生效，但没存进设置文件：磁盘空间满了。重启 Hub 后会恢复原样/);
  assert.match(saveFailureText({ saveError: { code: 'EPERM' } }, null), /没有写入权限/);
  assert.match(saveFailureText({ saveError: { code: 'EXDEV', message: 'cross-device' } }, null), /cross-device/);
});

test('桌宠设置分页：开关保存失败时，原因写在这个开关那一行（替换说明小字），开关回到原值', async () => {
  const small = { textContent: '原说明', classList: { added: [], add(...c) { this.added.push(...c); } }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const row = { querySelector: sel => (sel === 'small' ? small : null) };
  const toggle = { closest: sel => (sel.includes('.pet-tab-half') ? row : null) };
  const queried = [];
  let onChange = null;
  const container = { innerHTML: '', classList: { add() {} }, isConnected: true,
    addEventListener(k, f) { if (k === 'change') onChange = f; },
    querySelector: sel => { queried.push(sel); return sel === 'input[data-pet="walk"]' ? toggle : null; } };
  const data = { available: true, settings: { enabled: true, mode: 'gentle', role: '01-cat', walk: true }, roles: [], modes: [] };
  const ipc = { on() {}, invoke: async ch => {
    if (ch === 'hub-pet:set-settings') throw new Error('设置服务没响应');
    return ch === 'hub-pet:get-settings' ? data : { roles: [], state: { phase: 'idle' } };
  } };
  const tab = mountPetSettingsTab(container, { ipcRenderer: ipc, window: {}, document: { activeElement: null } });
  await tab.refresh();
  const input = { dataset: { pet: 'walk' }, checked: false, closest: sel => (sel === 'input[data-pet]' ? input : null) };
  onChange({ target: input });
  await new Promise(r => setTimeout(r, 10));
  assert.ok(queried.includes('input[data-pet="walk"]'), '按触发的开关找那一行');
  assert.match(small.textContent, /没存上：设置服务没响应/);
  assert.ok(small.classList.added.includes('bad'));
  assert.equal(small.attrs.role, 'alert');
  assert.match(container.innerHTML, /data-pet="walk" checked/, '重画后开关仍是原来的「开」');
});

test('Hub 配置里的桌宠设置：保存不再吞错误，失败写进本块的提示行', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub-pet', 'hub-settings.js'), 'utf8');
  assert.doesNotMatch(src, /hub-pet:set-settings', patch\)\); \} catch \(_\) \{\}/);
  assert.match(src, /saveFailureText\(result, failure\)/);
  assert.match(src, /id="cfg-hub-pet-save-error" role="alert" hidden/);
  assert.match(src, /id="cfg-notify-mode-save-error" role="alert" hidden/);
});

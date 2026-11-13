'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelUiController, modelPickerIdText } = require('../renderer/model-ui.js');

test('Codex native picker recognizes a configured custom model only for an explicit local catalog', () => {
  const { parseCodexModelPicker } = require('../renderer/model-ui');
  const screen = 'Select Model and Effort\n› 1. Internal/Case-Sensitive (current)\n  2. Team.Custom\n';
  assert.equal(parseCodexModelPicker(screen), null);
  const parsed = parseCodexModelPicker(screen, ['Internal/Case-Sensitive', 'Team.Custom']);
  assert.equal(parsed.highlighted.value, 'Internal/Case-Sensitive');
  assert.deepEqual(parsed.entries.map(row => row.value), ['Internal/Case-Sensitive', 'Team.Custom']);
});

test('local session model popup reads its own IPC catalog instead of an official or company-model fallback', async () => {
  const elements = [], calls = [];
  const document = {
    createElement() {
      const el = { children: [], dataset: {}, style: {}, ownerDocument: document, addEventListener() {}, setAttribute() {},
        appendChild(child) { this.children.push(child); }, getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 200, height: 20 }) };
      el.classList = { add() {} };
      Object.defineProperty(el, 'innerHTML', { get() { return this.markup; }, set(value) { this.markup = value; this.children = []; } });
      elements.push(el); return el;
    },
    body: { appendChild() {} },
  };
  const session = { kind: 'codex', companyRoute: 'local', currentModel: { id: 'Internal/Case-Sensitive' } };
  const controller = createModelUiController({ document, sessions: new Map([['local', session]]),
    ipcRenderer: { invoke: async (channel, args) => { calls.push([channel, args]); return { ok: true, models: [{ id: 'Internal/Case-Sensitive', label: 'Internal/Case-Sensitive' }] }; } },
    terminalPanelEl: {}, getActiveSessionId: () => 'local', escapeHtml: String, setTimeoutFn() {},
    refreshModelCatalog: () => assert.fail('local route must not load the official or company catalog'),
  });
  await controller.showModelPicker(document.createElement('span'), 'local');
  assert.deepEqual(calls, [['session:local-models', { sessionId: 'local' }]]);
  assert.equal(elements.filter(el => el.dataset.modelId).length, 1);
  assert.equal(elements.find(el => el.dataset.modelId)?.dataset.modelId, 'Internal/Case-Sensitive');
});

test('model picker hides ids that repeat the label, ignoring case', () => {
  assert.equal(modelPickerIdText({ label: 'Example-Model', id: 'Example-Model' }), '');
  assert.equal(modelPickerIdText({ label: 'EXAMPLE-MODEL', id: 'example-model' }), '');
});

test('model picker keeps distinct model ids', () => {
  assert.equal(modelPickerIdText({ label: 'Example Model', id: 'example-model' }), 'example-model');
  assert.equal(modelPickerIdText({ label: 'Example Model', id: 'example-model-v2' }), 'example-model-v2');
});

test('upgrade requirements take precedence over a repeated id', () => {
  assert.equal(modelPickerIdText({
    label: 'EXAMPLE-MODEL', id: 'example-model', disabled: true, upgradeTo: '2.1.280',
  }), '需 2.1.280+');
  assert.equal(modelPickerIdText({
    label: 'Example Model', id: 'example-model', disabled: true, upgradeTo: '2.1.280',
  }), '需 2.1.280+');
});

test('rendered model rows omit repeated id spans and retain distinct ids and upgrade hints', async () => {
  // Exercise the menu markup with minimal DOM interfaces; no Electron process is started.
  const document = {
    createElement() {
      const element = {
        children: [], dataset: {}, style: {}, className: '', ownerDocument: document,
        addEventListener() {}, setAttribute() {},
        appendChild(child) { this.children.push(child); },
        getBoundingClientRect() { return { top: 0, bottom: 20, left: 0, width: 200, height: 20 }; },
      };
      element.classList = { add(name) { element.className += ` ${name}`; } };
      Object.defineProperty(element, 'innerHTML', {
        get() { return this.markup; },
        set(value) { this.markup = value; this.children = []; },
      });
      return element;
    },
    body: { children: [], appendChild(child) { this.children.push(child); } },
  };
  const options = [
    { label: 'Example-Model', id: 'example-model' },
    { label: 'Friendly Model', id: 'distinct-model' },
    { label: 'Blocked-Model', id: 'blocked-model', disabled: true, upgradeTo: '2.1.280' },
  ];
  const session = { kind: 'codeagent', currentModel: { id: 'example-model' } };
  const controller = createModelUiController({
    document,
    ipcRenderer: { invoke: async () => ({ options }) },
    sessions: new Map([['test-session', session]]),
    terminalPanelEl: {},
    getActiveSessionId: () => 'test-session',
    escapeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    setTimeoutFn() {},
  });
  await controller.showModelPicker(document.createElement('span'), 'test-session');
  const rows = document.body.children[0].children.filter(child => child.dataset.modelId);
  assert.equal(rows.length, 3);
  assert.match(rows[0].innerHTML, /model-picker-label">Example-Model<\/span>/);
  assert.doesNotMatch(rows[0].innerHTML, /model-picker-id/);
  assert.match(rows[1].innerHTML, /model-picker-id">distinct-model<\/span>/);
  assert.match(rows[2].innerHTML, /model-picker-id">需 2\.1\.280\+<\/span>/);
  assert.match(rows[2].className, /disabled/);
  assert.match(rows[2].title, /需要 Claude Code 2\.1\.280\+/);
});

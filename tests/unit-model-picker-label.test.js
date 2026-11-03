'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelUiController, modelPickerIdText } = require('../renderer/model-ui.js');

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

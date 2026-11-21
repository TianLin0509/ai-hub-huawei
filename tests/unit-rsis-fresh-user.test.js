'use strict';
// 全新用户（什么都没配）首次走常用路径时发现的问题（2026-11-21 隔离 Hub 实测）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const { cleanIpcError } = require('../renderer/ipc-error-text');
const { connectionState } = require('../renderer/company-assistant-connection');

test('群聊创建失败不再露出 Electron 的 IPC 前缀', () => {
  const raw = "Error invoking remote method 'create-meeting': Error: 未找到 CodeAgent CLI。请从首页「安装说明」安装";
  assert.equal(cleanIpcError(raw), '未找到 CodeAgent CLI。请从首页「安装说明」安装');
  assert.equal(cleanIpcError(new Error(raw)), '未找到 CodeAgent CLI。请从首页「安装说明」安装');
  assert.equal(cleanIpcError('普通原因'), '普通原因');
  const src = read('renderer/meeting-create-modal.js');
  const body = src.slice(src.indexOf('function _showError('), src.indexOf('function _clearError('));
  assert.match(body, /cleanIpcError\(text\)/, '_showError 要先去掉 IPC 前缀');
});

test('WeLink 全盘查找期间仍给一键安装，不让人干等一两分钟', () => {
  const searching = connectionState({ cliFound: false, cliInstallAvailable: true, cliSearch: { state: 'searching', stage: 'disk' } });
  assert.equal(searching.kind, 'searching');
  assert.equal(searching.action, 'install-cli');
  assert.equal(searching.label, '一键安装');
  // 没有一键安装的版本：查找中照旧只显示进度
  const noInstaller = connectionState({ cliFound: false, cliInstallAvailable: false, cliSearch: { state: 'searching' } });
  assert.equal(noInstaller.action, '');
  // 正在安装时不重复给按钮
  assert.equal(connectionState({ cliFound: false, cliInstallAvailable: true, cliSearch: { state: 'searching' }, cliInstall: { phase: 'downloading' } }).action, '');
});

test('没有 CodeAgent 时「所在区域」不再一直显示「正在识别…」', () => {
  const src = read('renderer/company-api-settings.js');
  const body = src.slice(src.indexOf('function zoneHtml('), src.indexOf('function zoneHtml(') + 1600);
  assert.match(body, /missing\.includes\('codeagentVersion'\)/);
  assert.match(body, /没找到 CodeAgent，没法自动识别区域/);
  // 新文案有英文
  const en = read('core/i18n/locales/en/residual.json');
  assert.ok(en.includes('没找到 CodeAgent，没法自动识别区域'), '英文译文缺失');
});

test('深色主题下 API key 卡不再是白底白字', () => {
  const dark = ":root:is([data-theme='dark'],[data-theme='frost'])";
  const community = read('renderer/community.css');
  assert.ok(community.includes(`${dark} .api-gw-card.rec {`), '首页「用 API key 开始」卡缺深色底');
  const cards = read('renderer/styles/launch-model-cards.css');
  assert.ok(cards.includes(`${dark} .session-model-card[data-state="suggest"] {`), '启动中心「用部门 API key」卡缺深色底');
  assert.ok(cards.includes(`${dark} .gw-inline {`), '启动中心就地配置区缺深色底');
});

test('「自有 API」底栏贴底，保存按钮不用滚动才看得见', () => {
  const css = read('renderer/styles/company-api-settings.css');
  assert.match(css, /#company-api-dialog footer\{position:sticky;bottom:0/);
});

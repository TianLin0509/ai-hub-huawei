'use strict';
// 界面语言底座（2026-11-20）：默认中文时一切原样；English 时按词典整句、句式翻译；主进程对话框/菜单包装。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshI18n(dict) {
  delete require.cache[require.resolve('../core/i18n')];
  const i18n = require('../core/i18n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-i18n-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(dict));
  i18n.loadDictionaries(dir);
  return { i18n, dir };
}

const DICT = {
  '启动中心': 'Launch Center',
  '准备恢复': 'Preparing to restore',
  '已恢复 {0}/{1} 个会话；{2} 项已续作。': 'Restored {0}/{1} sessions; {2} resumed.',
  '{0}：{1}': '{0}: {1}',
  '失败：{0}': 'Failed: {0}',
};

test('默认中文：translate 与 t 原样返回', () => {
  const { i18n } = freshI18n(DICT);
  assert.strictEqual(i18n.getLanguage(), 'zh-CN');
  assert.strictEqual(i18n.translate('启动中心'), '启动中心');
  assert.strictEqual(i18n.t('已恢复 {0}/{1} 个会话；{2} 项已续作。', 1, 2, 0), '已恢复 1/2 个会话；0 项已续作。');
});

test('English：整句、保留首尾空白、句式与嵌套翻译', () => {
  const { i18n } = freshI18n(DICT);
  i18n.setLanguage('en');
  assert.strictEqual(i18n.translate('  启动中心\n'), '  Launch Center\n');
  assert.strictEqual(i18n.translate('已恢复 3/5 个会话；1 项已续作。'), 'Restored 3/5 sessions; 1 resumed.');
  assert.strictEqual(i18n.translate('报告.md：准备恢复'), '报告.md: Preparing to restore');
  assert.strictEqual(i18n.translate('失败：准备恢复'), 'Failed: Preparing to restore', '更长的字面优先');
  assert.strictEqual(i18n.translate('没有词条的中文'), '没有词条的中文');
  assert.strictEqual(i18n.translate('plain english'), 'plain english');
  assert.strictEqual(i18n.t('已恢复 {0}/{1} 个会话；{2} 项已续作。', 1, 2, 0), 'Restored 1/2 sessions; 0 resumed.');
});

test('漏翻回调只在英文且含中文时触发；切回中文即停', () => {
  const { i18n } = freshI18n(DICT);
  const misses = [];
  i18n.setMissHook(t => misses.push(t));
  i18n.translate('没有词条');
  i18n.setLanguage('en');
  i18n.translate('没有词条');
  i18n.translate('启动中心');
  i18n.setLanguage('zh-CN');
  i18n.translate('又一个');
  assert.deepStrictEqual(misses, ['没有词条']);
});

test('语言取值：只认 en，其余一律中文；监听器收到切换', () => {
  const { i18n } = freshI18n(DICT);
  assert.strictEqual(i18n.normalizeLanguage('en-US'), 'en');
  assert.strictEqual(i18n.normalizeLanguage('zh-TW'), 'zh-CN');
  assert.strictEqual(i18n.normalizeLanguage(undefined), 'zh-CN');
  const seen = [];
  i18n.onLanguageChange(l => seen.push(l));
  i18n.setLanguage('en'); i18n.setLanguage('en'); i18n.setLanguage('zh-CN');
  assert.deepStrictEqual(seen, ['en', 'zh-CN']);
});

test('主进程包装：对话框参数、菜单模板按当前语言翻译', () => {
  const { i18n } = freshI18n({ '确定': 'OK', '退出 AI Hub': 'Quit AI Hub', '打开': 'Open' });
  delete require.cache[require.resolve('../main/i18n-main')];
  const m = require('../main/i18n-main');
  const opts = { message: '确定', buttons: ['确定', '取消'] };
  assert.deepStrictEqual(m.translateOptions(opts), opts, '中文模式不改');
  i18n.setLanguage('en');
  assert.deepStrictEqual(m.translateOptions(opts), { message: 'OK', buttons: ['OK', '取消'] });
  assert.deepStrictEqual(m.translateMenuTemplate([{ label: '退出 AI Hub', submenu: [{ label: '打开' }] }]),
    [{ label: 'Quit AI Hub', submenu: [{ label: 'Open' }] }]);
  let got = null;
  const fakeElectron = { dialog: { showMessageBox(win, o) { got = [win, o]; } }, BrowserWindow: function BW() {} };
  m.patchElectron(fakeElectron);
  const win = new fakeElectron.BrowserWindow();
  fakeElectron.dialog.showMessageBox(win, { message: '确定' });
  assert.strictEqual(got[0], win);
  assert.strictEqual(got[1].message, 'OK');
  fakeElectron.dialog.showMessageBox({ message: '确定' });
  assert.strictEqual(got[0].message, 'OK');
});

test('设置读写：缺省中文，保存只动 ui.language、保留其他配置', () => {
  delete require.cache[require.resolve('../main/i18n-main')];
  const m = require('../main/i18n-main');
  let stored = { proxy: { http: 'x' }, ui: { card_font_size: 16 } };
  const hubConfig = { readConfigJsonForUpdate: () => JSON.parse(JSON.stringify(stored)), saveConfig: c => { stored = c; } };
  assert.strictEqual(m.readSavedLanguage(hubConfig), 'zh-CN');
  m.saveLanguage(hubConfig, 'en');
  assert.deepStrictEqual(stored, { proxy: { http: 'x' }, ui: { card_font_size: 16, language: 'en' } });
  assert.strictEqual(m.readSavedLanguage(hubConfig), 'en');
  assert.strictEqual(m.readSavedLanguage({ readConfigJsonForUpdate: () => { throw new Error('坏文件'); } }), 'zh-CN');
});

test('抽取：模板串变句式、HTML 切段、注释与日志不算', () => {
  const ex = require('../scripts/i18n-extract.js');
  const src = [
    "// 注释里的中文",
    "console.warn('日志里的中文');",
    "el.innerHTML = `<p title=\"提示 ${a}\">待送达 ${n} 条，最早 ${esc(x ? '刚刚' : '很久')}</p>`;",
    "const s = '共 ' + n + ' 条';",
  ].join('\n');
  const texts = ex.extractJs(src, 'x.js').map(e => e.text);
  assert.ok(texts.includes('待送达 {0} 条，最早 {1}'), texts.join(' | '));
  assert.ok(texts.includes('提示 {0}'));
  assert.ok(texts.includes('刚刚') && texts.includes('很久'));
  assert.ok(texts.includes('共') && texts.includes('条'));
  assert.ok(!texts.some(t => t.includes('注释') || t.includes('日志')));
});

test('多行提示：整段查不到时逐行翻，没词条的行原样保留', () => {
  const { i18n } = freshI18n(DICT);
  i18n.setLanguage('en');
  assert.strictEqual(i18n.translate('启动中心\n失败：准备恢复\n没有词条的中文'), 'Launch Center\nFailed: Preparing to restore\n没有词条的中文');
  assert.strictEqual(i18n.translate('没有词条\n也没有'), '没有词条\n也没有');
  i18n.setLanguage('zh-CN');
  assert.strictEqual(i18n.translate('启动中心\n准备恢复'), '启动中心\n准备恢复');
});

'use strict';
// 启动中心字段说明（2026-11-22：说明做成悬停提醒，不喧宾夺主）：纯说明进 ⓘ 悬停卡，要处理的提示留在原位。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hint = require('../renderer/launch-field-hint');
const { placement } = require('../renderer/hub-tooltip');

function fakeDocument() {
  const doc = {
    createElement(tag) {
      const attrs = {};
      const el = { tagName: tag.toUpperCase(), ownerDocument: doc, children: [], dataset: {}, hidden: false, className: '', text: '',
        setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
        hasAttribute(k) { return k in attrs; }, removeAttribute(k) { delete attrs[k]; },
        appendChild(child) { child.parent = el; el.children.push(child); return child; },
        querySelector(sel) {
          const m = sel.match(/^:scope > (?:\.([\w-]+)|(span))$/);
          return el.children.find(c => m && (m[1] ? c.className === m[1] : c.tagName === 'SPAN')) || null;
        },
        get title() { return attrs.title || ''; },
        set textContent(v) { el.text = String(v); el.children = []; },
        get textContent() { return el.text + el.children.map(c => c.textContent).join(''); },
      };
      return el;
    },
  };
  return doc;
}

test('info 说明：原说明行隐藏但文字保留，标签后出现 ⓘ，悬停卡优先放上方、键盘可聚焦', () => {
  const doc = fakeDocument();
  const field = doc.createElement('label'), label = field.appendChild(doc.createElement('span')), note = doc.createElement('div');
  label.textContent = '运行方式';
  hint.setFieldHint(note, 'PTY：一直开着真实终端。', { label: hint.fieldLabel(field) });
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, 'PTY：一直开着真实终端。', '文字仍在原元素里，aria-describedby 与旧断言照常');
  const icon = label.querySelector(':scope > .field-hint-icon');
  assert.ok(icon && !icon.hidden);
  assert.equal(icon.title, 'PTY：一直开着真实终端。');
  assert.equal(icon.getAttribute('aria-label'), '说明：PTY：一直开着真实终端。');
  assert.equal(icon.dataset.tipSide, 'top');
  assert.equal(icon.dataset.hubTipFocus, '1');
  assert.equal(icon.tabIndex, 0);
  assert.equal(label.textContent, '运行方式', '图标不带文字，标签读出来不变');
});

test('warn / error / status：留在原位显示，标签上的 ⓘ 收起；改标签文字不丢图标', () => {
  const doc = fakeDocument();
  const field = doc.createElement('label'), label = field.appendChild(doc.createElement('span')), note = doc.createElement('div');
  hint.setFieldHint(note, '自动挑号：按会话数分配。', { label: hint.fieldLabel(field) });
  hint.setLabelText(label, '账号');
  const icon = label.querySelector(':scope > .field-hint-icon');
  assert.ok(icon, 'setLabelText 保留图标');
  for (const level of ['warn', 'error', 'status']) {
    hint.setFieldHint(note, '当前账号不可用，请到「账号」页登录。', { level, label });
    assert.equal(note.hidden, false, level);
    assert.equal(note.dataset.hintLevel, level);
    assert.equal(icon.hidden, true, level + ' 时不重复显示 ⓘ');
  }
  hint.setFieldHint(note, '', { level: 'error', label });
  assert.equal(note.hidden, true, '没有文字就不占位');
});

test('悬停中更新说明只改暂存值，离开时由 hub-tooltip 还原成 title', () => {
  const doc = fakeDocument();
  const label = doc.createElement('span');
  const icon = hint.setIconHint(label, '旧说明');
  icon.setAttribute('data-hub-tip', '旧说明'); icon.removeAttribute('title');
  hint.setIconHint(label, '新说明', { tone: 'risk' });
  assert.equal(icon.getAttribute('data-hub-tip'), '新说明');
  assert.equal(icon.hasAttribute('title'), false);
  assert.equal(icon.dataset.tone, 'risk');
});

test('悬停卡位置：prefer=top 先放上方，不盖住标签下的下拉框；贴近顶部时翻到下方', () => {
  const view = { width: 1440, height: 900 }, card = { width: 300, height: 80 };
  const icon = { left: 700, right: 713, top: 400, bottom: 413, width: 13, height: 13 };
  assert.equal(placement(icon, card, view, 'top').side, 'top');
  assert.equal(placement(icon, card, view).side, 'bottom', '其他元素照旧优先下方');
  assert.equal(placement({ ...icon, top: 30, bottom: 43 }, card, view, 'top').side, 'bottom');
});

test('启动中心接线：运行方式、权限模式、账号、消费通道、pi 的纯说明都走字段说明规则', () => {
  const wc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workspace-controller.js'), 'utf8');
  assert.match(wc, /fieldHint\.setFieldHint\(note, lowOverheadNote \+ \(runMode === 'serve'/); // 低开销模式（P1 L2）在说明前补一句
  // 2026-11-26：权限说明另拼一段（档位说明 + 仅本次 + 已开会话怎么换档 + 灰掉的原因），不再直接用下方小字。
  assert.match(wc, /fieldHint\.setIconHint\(fieldHint\.fieldLabel\(field\), hint, \{ tone/);
  assert.match(wc, /fieldHint\.setFieldHint\(accountNote, text, \{ level/);
  assert.match(wc, /fieldHint\.setFieldHint\(routeNote,/);
  assert.match(wc, /fieldHint\.setIconHint\(text, detail\)/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', 'one-screen.css'), 'utf8');
  assert.match(css, /\.field-hint-icon::before \{ content: 'i'; \}/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'launch-config-layout.js'), 'utf8'), /head\.replace\('<\/div>', hintIcon \+ '<\/div>'\)/);
});

test('改标签文字时原位换文字节点，不把 ⓘ 摘下再挂回（键盘焦点不丢，Codex 审 R29）', () => {
  const hint = require('../renderer/launch-field-hint.js');
  const events = [];
  const text = v => ({ textContent: v, remove() { events.push('remove-text'); label.childNodes.splice(label.childNodes.indexOf(this), 1); } });
  const icon = { classList: { contains: c => c === hint.ICON_CLASS }, className: hint.ICON_CLASS, remove() { events.push('remove-icon'); } };
  const label = {
    childNodes: [text('运行方式'), icon],
    querySelector: () => icon, children: [icon],
    ownerDocument: { createTextNode: v => text(v) },
    insertBefore(node, ref) { events.push('insert'); this.childNodes.splice(this.childNodes.indexOf(ref), 0, node); },
    appendChild() { events.push('append-icon'); }, set textContent(v) { events.push('set-textContent'); },
  };
  hint.setLabelText(label, '运行方式');
  assert.deepEqual(events, [], '文字没变什么都不动');
  hint.setLabelText(label, '账号');
  assert.deepEqual(events, ['remove-text', 'insert']);
  assert.equal(label.childNodes[1], icon);
  assert.equal(label.childNodes[0].textContent, '账号');
});

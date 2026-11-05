'use strict';
// 公司版导航默认是图标栏；「设置」菜单里的「导航显示文字」切宽版并记在本机。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installHwShell, installHwRailPref, HW_RAIL_PREF_KEY } = require('../renderer/coldwhite-shell');

class El {
  constructor(id = '', className = '') { this.id = id; this.className = className; this.children = []; this.dataset = {}; this.attrs = {}; this.style = {}; this.listeners = {}; this.textContent = ''; this.width = 0; }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  insertBefore(node, ref) { node.parent = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, node); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  getBoundingClientRect() { return { width: this.width }; }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.all().find(n => n.id === sel.slice(1)) || null;
    if (sel.startsWith('.')) return this.all().find(n => n.className.split(' ').includes(sel.slice(1))) || null;
    return null;
  }
}
function fakeDoc(store = new Map()) {
  const html = new El('html'), body = new El('body'), rail = new El('scene-rail'), nav = new El('', 'rail-navigation');
  const menu = new El('options-menu', 'options-menu'), divider = new El('', 'options-divider'), settings = new El('options-settings', 'options-item');
  rail.append(nav); menu.append(new El('options-suspend-idle', 'options-item'), divider, settings); body.append(rail, menu); html.append(body);
  const timers = [];
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const doc = {
    documentElement: html, body,
    getElementById: id => html.querySelector('#' + id),
    createElement: () => new El(),
    defaultView: { localStorage: storage, setTimeout: fn => timers.push(fn) },
  };
  return { doc, html, rail, menu, divider, store, timers };
}

test('company shell defaults to the icon rail and adds the wide-rail menu item before the divider', () => {
  const { doc, html, rail, menu, divider } = fakeDoc();
  rail.width = 46;
  assert.equal(installHwShell(doc, 'company'), true);
  assert.equal(html.dataset.hwShell, '1');
  assert.equal(html.dataset.hwRail, 'narrow');
  assert.equal(html.dataset.hwRailPref, undefined);
  const item = menu.querySelector('#options-rail-wide');
  assert.ok(item, 'menu item exists');
  assert.equal(menu.children.indexOf(item) + 1, menu.children.indexOf(divider));
  assert.equal(item.getAttribute('aria-checked'), 'false');
});

test('toggling the menu item switches to wide, remembers it locally, and re-measures the rail', () => {
  const { doc, html, rail, menu, store, timers } = fakeDoc();
  rail.width = 46;
  installHwShell(doc, 'company');
  const item = menu.querySelector('#options-rail-wide');
  rail.width = 224; // CSS 把槽位放宽后的实际宽度
  item.click();
  assert.equal(html.dataset.hwRailPref, 'wide');
  assert.equal(store.get(HW_RAIL_PREF_KEY), '1');
  assert.equal(item.getAttribute('aria-checked'), 'true');
  assert.equal(menu.style.display, 'none');
  assert.equal(html.dataset.hwRail, 'wide', 'measured immediately, not only by ResizeObserver');
  assert.equal(timers.length, 1, 'one follow-up measurement after the transition');
  rail.width = 46;
  item.click();
  timers.at(-1)();
  assert.equal(html.dataset.hwRailPref, undefined);
  assert.equal(store.get(HW_RAIL_PREF_KEY), '0');
  assert.equal(html.dataset.hwRail, 'narrow');
});

test('a saved wide choice is applied at startup, and installing twice adds one item', () => {
  const { doc, html, menu } = fakeDoc(new Map([[HW_RAIL_PREF_KEY, '1']]));
  installHwShell(doc, 'company');
  installHwRailPref(doc);
  assert.equal(html.dataset.hwRailPref, 'wide');
  assert.equal(menu.children.filter(n => n.id === 'options-rail-wide').length, 1);
});

test('non-company builds keep their own rail and menu untouched', () => {
  const { doc, html, menu } = fakeDoc();
  assert.equal(installHwShell(doc, 'public'), false);
  assert.equal(html.dataset.hwShell, undefined);
  assert.equal(menu.querySelector('#options-rail-wide'), null);
});

test('broken storage falls back to the icon rail instead of throwing', () => {
  const { doc, html } = fakeDoc();
  doc.defaultView.localStorage = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  installHwShell(doc, 'company');
  assert.equal(html.dataset.hwRailPref, undefined);
});

test('stylesheet: icon rail is the default slot and the wide slot only applies with the saved preference', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles/hw-shell.css'), 'utf8');
  assert.match(css, /:root\[data-hw-shell\]:not\(\[data-display-mode="phone"\]\)[^{]*\{\s*--hub-rail-slot: var\(--display-rail-width, 64px\)/);
  for (const m of css.matchAll(/--hub-rail-slot: var\(--display-rail-width, (248|232)px\)/g)) {
    const selector = css.slice(css.lastIndexOf('}', m.index) + 1, m.index);
    assert.match(selector, /data-hw-rail-pref="wide"/, `${m[1]}px slot must be gated by the wide preference`);
  }
  assert.match(css, /data-hw-rail="narrow"[^{]*cw-current[^{]*::before\s*\{[^}]*background: var\(--hw-brand\)/, 'current page shows the blue bar in the icon rail');
});

test('navigation icons are one solid family: no outline strokes or unfilled shapes', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles/hw-shell.css'), 'utf8');
  const icons = [...css.matchAll(/--shell-ico-([a-z]+): url\("data:image\/svg\+xml,([^"]*)"\)/g)];
  assert.ok(icons.length >= 13, 'all navigation icons found');
  for (const [, name, svg] of icons) {
    assert.doesNotMatch(svg, /stroke/, `${name} must not be drawn with strokes`);
    assert.doesNotMatch(svg, /fill=%22none%22/, `${name} must not have unfilled shapes`);
  }
});

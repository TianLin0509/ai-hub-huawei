'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '../renderer/styles/hw-shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
function property(rule, name) {
  assert.ok(rule, 'scoped rail rule exists');
  const hit = rule.body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
  assert.ok(hit, `${name} exists`);
  return hit[1].trim();
}
const narrow = rules.find(r => r.selector === ':root[data-hw-shell][data-hw-rail="narrow"]');
const island = rules.find(r => r.selector.includes(':not([data-display-mode="phone"])') && r.selector.endsWith('#scene-rail:is(:hover,:has(:focus-visible))'));
const buttons = rules.find(r => r.selector.includes('.rail-utilities #btn-options)') && r.body.includes('flex-direction: column'));
const labels = rules.find(r => r.selector.endsWith('> .rail-utility-label') && r.body.includes('order: 2'));
// Evaluate only arithmetic from the actual CSS declarations. This catches
// clipping regressions while keeping the default 64px dimensions unchanged.
function pixels(value, slot) {
  value = value.replace(/var\((--[\w-]+)\)/g, (_, key) => String(key === '--hub-rail-slot' ? slot : pixels(property(narrow, key), slot)))
    .replace(/px/g, '').replace(/calc\(/g, '(');
  assert.match(value, /^[\d\s.,()+*/\-minaxclp]+$/);
  return Function('min', 'max', 'clamp', `return (${value})`)(Math.min, Math.max, (a, b, c) => Math.max(a, Math.min(b, c)));
}
test('custom narrow rails contain the full button and label', () => {
  for (const slot of [36, 40, 44, 48, 52, 64, 88, 112]) {
    const width = pixels(property(island, 'width'), slot);
    const button = pixels(property(buttons, 'width'), slot);
    const label = pixels(property(labels, 'width'), slot);
    assert.ok(button + 2 <= width, `${slot}px rail contains its ${button}px button and padding`);
    assert.ok(label <= button, 'label stays within the clickable button');
    assert.ok(8 + width <= slot, 'island stays within the allocated rail slot');
  }
});
test('default 64px navigation keeps its previous geometry', () => {
  assert.equal(pixels(property(island, 'width'), 64), 46);
  assert.equal(pixels(property(buttons, 'width'), 64), 44);
  assert.equal(pixels(property(labels, 'width'), 64), 42);
});

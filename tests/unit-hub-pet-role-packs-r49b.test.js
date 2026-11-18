'use strict';
// r49b：拟人形象（鲸鱼娘、Claude 娘、GPT 娘）下载包。发布前核对：目录与包的字节数、SHA-256；包能过客户端校验；
// 四姿态 400 像素；有动画的两个带打字 5 帧与 5 段待机小动作；每个包带完整署名（作者、协议、作者原话、改动说明、协议全文）；
// 设置页卡片显示「形象来源与授权」，装好前给一句话、装好后给全文。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../core/hub-pet/role-packs');
const { ROLES } = require('../core/hub-pet/state');
const { mountPetSettingsTab } = require('../renderer/hub-pet/pet-settings-tab');

const DIR = path.join(__dirname, '..', 'tools', 'hub-pet-packs');
const FRAME = 400;
const PACKS = {
  '19-whale-maid': { name: '鲸鱼娘', anim: true, authors: ['上善无形', 'ZipZipPipe', 'PC2005-cloud / dsh-pet'] },
  '21-claude-girl': { name: 'Claude 娘', anim: true, authors: ['ZipZipPipe', 'ApprenTice', 'Houraiji9 / ai-pet-7in1'] },
  '23-gpt-girl': { name: 'GPT 娘', anim: false, authors: ['ZipZipPipe', 'ZipZipPipe-character-pack'] },
};

function webpSize(buf) {
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
  throw new Error('未知 WebP 头 ' + kind);
}
const catalog = JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8'));

test('三个拟人形象列在内置角色清单与在线目录里，目录顶层为 1.2.0、带一句话署名，并各有缩略图', () => {
  const c = R.validateCatalog(catalog);
  assert.equal(c.version, '1.2.0');
  for (const [id, want] of Object.entries(PACKS)) {
    assert.equal(ROLES.find(r => r.id === id)?.name, want.name, id);
    const entry = c.packs.find(p => p.id === id);
    assert.equal(entry?.version, '1.2.0', id);
    assert.match(entry.credit, /ZipZipPipe/);
    assert.match(entry.credit, /CC BY-NC-SA 4\.0/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'assets', 'hub-pet', 'thumbs', id + '.webp')), id + ' 缩略图');
  }
});

for (const [id, want] of Object.entries(PACKS)) {
  test(`${id}：字节数与哈希对得上，四姿态 400 像素，署名完整`, () => {
    const entry = catalog.packs.find(p => p.id === id);
    const raw = fs.readFileSync(path.join(DIR, entry.file));
    assert.equal(raw.length, entry.bytes);
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), entry.sha256);
    assert.ok(raw.length <= 1.6 * 1024 * 1024, '单包不超过约 1.6 MB');
    const p = R.validatePack(JSON.parse(raw.toString('utf8')));
    assert.equal(p.name, want.name);
    for (const pose of ['idle', 'typing', 'happy', 'sleep']) assert.deepEqual(webpSize(p.buffers[pose + '.webp']), [FRAME, FRAME], pose);
    if (want.anim) {
      assert.deepEqual(p.meta.sequences, ['typing', 'idle-life']);
      assert.deepEqual(p.meta.clipped, { typing: Array.from({ length: 20 }, (_, i) => i + 5) });
      for (const seq of ['typing', 'idle-life']) assert.deepEqual(webpSize(p.buffers[`seq-${seq}.webp`]), [FRAME * 5, FRAME * 5], seq);
    } else assert.deepEqual(p.meta.sequences, []);
    const c = p.meta.credit;
    assert.deepEqual(c.authors.map(a => a.name), want.authors);
    assert.match(c.license.name, /CC BY-NC-SA 4\.0/);
    assert.ok(c.terms.length >= 1 && c.terms.every(t => t.quote && t.url.startsWith('https://')));
    assert.match(c.changes, /400×400/);
    assert.match(c.legal, /^Attribution-NonCommercial-ShareAlike 4\.0 International/);
    assert.match(c.legal, /Section 3 -- License Conditions/);
  });
}

test('署名信息只收纯文本与 https 网址，类型不对或超长整包拒收；没有署名的老包照常通过', () => {
  const ok = { summary: '作者甲。CC BY-NC-SA 4.0', authors: [{ name: '甲', role: '原设计', url: 'https://example.com/a' }], license: { name: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' } };
  assert.equal(R.validateCredit(ok).authors[0].name, '甲');
  for (const bad of [
    'x', [], { authors: [] },
    { ...ok, authors: [{ name: '甲', url: 'javascript:alert(1)' }] },
    { ...ok, authors: [{ name: '甲', url: 'http://example.com' }] },
    { ...ok, terms: [{ quote: 1 }] },
    { ...ok, legal: 'x'.repeat(40001) },
    { ...ok, authors: Array.from({ length: 9 }, () => ({ name: '甲' })) },
  ]) assert.throws(() => R.validateCredit(bad), /署名/);
  const meta = R.validateMeta({ poses: ['idle'] });
  assert.equal(meta.credit, undefined);
});

test('装好的形象把全文交给设置页；没装的只给目录里的一句话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r49b-'));
  try {
    const store = R.createRolePackStore({ assetsDir: path.join(dir, 'assets'), dataDir: path.join(dir, 'data'), logger: { warn() {} } });
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, '23-gpt-girl-1.2.0.json'), 'utf8'));
    store.install(raw);
    const gpt = store.listRoles().find(r => r.id === '23-gpt-girl');
    assert.equal(gpt.credit.full, true);
    assert.match(gpt.credit.legal, /ShareAlike/);
    const whale = store.listRoles().find(r => r.id === '19-whale-maid');
    assert.equal(whale.installed, false);
    assert.equal(whale.credit, null, '没查过目录、也没装：没有署名可给');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('设置页：有署名的卡片带「形象来源与授权」按钮，点开的浮层按纯文本列出作者、原话与协议全文', async () => {
  // 极简 DOM：只实现 showCredit 用到的接口
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.className = ''; this._text = ''; this.listeners = {}; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    append(...n) { this.children.push(...n); }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(k, f) { this.listeners[k] = f; }
    remove() { body.children = body.children.filter(c => c !== this); }
    focus() {}
  }
  const body = new Node('body');
  const document = { activeElement: null, body, createElement: t => new Node(t), querySelector: () => body.children.find(c => c.className === 'pet-credit-mask') || null };
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, '21-claude-girl-1.2.0.json'), 'utf8'));
  const credit = { ...R.validateCredit(raw.meta.credit), full: true };
  const roles = [{ id: '21-claude-girl', name: 'Claude 娘', installed: true, credit }, { id: '01-cat', name: '小猫', installed: true, bundled: true, credit: null }];
  let onClick = null;
  const container = { innerHTML: '', classList: { add() {} }, isConnected: true, addEventListener(k, f) { if (k === 'click') onClick = f; }, querySelector: () => null };
  const data = { available: true, settings: { enabled: true, mode: 'gentle', role: '01-cat' }, roles, modes: [] };
  const ipc = { on() {}, invoke: async ch => (ch === 'hub-pet:get-settings' ? data : { roles, state: { phase: 'idle' } }) };
  const tab = mountPetSettingsTab(container, { ipcRenderer: ipc, window: {}, document });
  await tab.refresh();
  const html = container.innerHTML;
  assert.match(html, /data-pet="credit" data-id="21-claude-girl">形象来源与授权</);
  assert.equal((html.match(/data-pet="credit"/g) || []).length, 1, '没有署名的自带形象不显示');
  const btn = { disabled: false, dataset: { pet: 'credit', id: '21-claude-girl' } };
  onClick({ target: { closest: sel => (sel === '[data-pet]' ? btn : null) } });
  const mask = document.querySelector();
  assert.ok(mask, '浮层已打开');
  const text = mask.textContent;
  for (const s of ['Claude 娘 · 形象来源与授权', 'ZipZipPipe', 'ApprenTice', 'Houraiji9', '作者原话', '协议全文', 'https://github.com/Houraiji9/ai-pet-7in1', 'Attribution-NonCommercial-ShareAlike 4.0 International']) assert.ok(text.includes(s), s);
  mask.listeners.click({ target: mask });
  assert.equal(document.querySelector(), null, '点遮罩关闭');
});

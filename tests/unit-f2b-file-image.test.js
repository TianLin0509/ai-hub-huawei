'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareImageFile } = require('../main/ipc/app-utility-handlers');
const { prepareFilePaths, bindFileAttachments, insertAttachments } = require('../renderer/file-attachments');
const { createTerminalInputController } = require('../renderer/terminal-input-controller');

function image(width, height) {
  return { isEmpty: () => false, getSize: () => ({ width, height }),
    resize: size => image(size.width, size.height), toPNG: () => Buffer.from(`${width}x${height}`) };
}
function setup(width = 3840, height = 2160) {
  const original = 'D:\\source\\大图.png';
  const files = new Map([[original, Buffer.from('original bytes')]]);
  let seq = 0;
  const deps = { path: path.win32, imageDir: 'D:\\hub\\images',
    nativeImage: { createFromBuffer: () => image(width, height) },
    fs: { mkdirSync() {}, readFileSync: name => files.get(name), writeFileSync: (name, data) => files.set(name, data) },
    crypto: { randomBytes: () => Buffer.from(String(++seq)) }, logger: { info() {}, warn() {} } };
  const calls = [];
  const ipcRenderer = { invoke: async (channel, p) => {
    calls.push(channel); assert.equal(channel, 'prepare-image-file'); return prepareImageFile(deps, p);
  } };
  const node = () => ({ dataset: {}, style: {}, listeners: {}, classList: { add() {}, remove() {} },
    addEventListener(type, fn) { this.listeners[type] = fn; }, appendChild() {}, dispatchEvent() {}, click() { this.clicked = true; } });
  const input = node(), output = [];
  const document = { createElement: node, body: { appendChild() {} },
    execCommand: (_command, _ui, value) => { output.push(value); return true; } };
  const controller = createTerminalInputController({ document, window: {}, ipcRenderer,
    clipboard: { readImage: () => ({ isEmpty: () => true }) }, terminalCache: new Map(),
    webUtils: { getPathForFile: file => file.path }, requestAnimationFrameFn() {}, setTimeoutFn() {}, clearTimeoutFn() {} });
  return { original, files, deps, calls, ipcRenderer, node, input, output, document, controller };
}
function checkScaled(f) {
  assert.deepEqual(f.calls, ['prepare-image-file']);
  assert.equal(f.output.length, 1);
  assert.notEqual(f.output[0], f.original);
  assert.equal(f.files.get(f.output[0]).toString(), '2000x1125');
  assert.equal(f.files.get(f.original).toString(), 'original bytes');
}

test('资源管理器文件粘贴：发缩小副本，原图不写回', async () => {
  const f = setup(); f.controller.attachContenteditablePasteImage(f.input);
  await f.input.listeners.paste({ preventDefault() {}, clipboardData: { files: [{ path: f.original }] } });
  checkScaled(f);
});
for (const mode of ['drop', 'change']) test(`${mode === 'drop' ? '拖入图片' : '附件按钮选择'}：发缩小副本，原图不写回`, async () => {
  const f = setup(), target = f.node(), button = f.node();
  const picker = bindFileAttachments({ document: f.document, target, button, filePath: file => file.path,
    onError: error => { throw error; }, onFiles: async paths => {
      const items = await prepareFilePaths(f.ipcRenderer, paths);
      insertAttachments(f.input, items, { insertText: text => f.output.push(text) });
    } });
  if (mode === 'drop') await target.listeners.drop({ dataTransfer: { types: ['Files'], files: [{ path: f.original }] }, preventDefault() {}, stopPropagation() {} });
  else {
    button.listeners.click(); assert.equal(picker.clicked, true);
    picker.files = [{ path: f.original }]; await picker.listeners.change(); assert.equal(picker.value, '');
  }
  checkScaled(f);
});

test('2000 边界小图与普通文件保留路径，竖图等比缩小；失败不返回原图', async () => {
  const f = setup(2000, 1000);
  assert.deepEqual(await prepareFilePaths(f.ipcRenderer, [f.original, 'D:\\source\\a.txt']),
    [{ path: f.original, resized: false }, { path: 'D:\\source\\a.txt', resized: false }]);
  assert.equal(f.files.size, 1);
  const tall = setup(1200, 5000);
  assert.deepEqual(prepareImageFile(tall.deps, tall.original).to, { width: 480, height: 2000 });
  f.deps.fs.writeFileSync = () => { throw Error('disk full'); };
  f.deps.nativeImage.createFromBuffer = () => image(4000, 3000);
  await assert.rejects(prepareFilePaths(f.ipcRenderer, [f.original]), /Cannot prepare image/);
  f.deps.nativeImage.createFromBuffer = () => ({ isEmpty: () => true });
  // 解不出来的图照原样附上（不能因为缩放让以前能附的图附不上）。
  assert.deepEqual(prepareImageFile(f.deps, f.original), { path: f.original, resized: false });
  f.deps.nativeImage.createFromBuffer = () => { throw Error('should not decode gif'); };
  const gif = f.original.replace(/\.[^.\/]+$/, '.gif');
  assert.deepEqual(prepareImageFile(f.deps, gif), { path: gif, resized: false });
});

test('生产 composer 的附件选择和拖入接入共用模块，缩放提示不进入实际发送正文', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.match(src, /bindFileAttachments\(\{ document, target: composer, button: attachBtn/);
  assert.match(src, /prepareFilePaths\(ipcRenderer, paths\)/);
  assert.match(src, /captureAttachmentTarget\(inputBox/);
  assert.match(src, /attachBtn.hidden = false/);
  const chips = require('../renderer/composer-paste-chips');
  const id = chips.registerPaste('D:\\hub\\scaled.png', { kind: 'image', label: '大图.png · 已自动缩放' });
  assert.equal(chips.expandPasteMarkers(`${id}`), 'D:\\hub\\scaled.png');
});

test('英文模式的 CSS 附件标签通过现有词典翻译，文件名和发送路径保留原文', t => {
  const i18n = require('../core/i18n');
  const prior = i18n.getLanguage(); t.after(() => i18n.setLanguage(prior));
  i18n.setLanguage('en');
  let inserted;
  t.mock.method(require('../renderer/composer-paste-chips'), 'insertPasteChip', (_input, text, options) => { inserted = { text, label: options.meta.label }; });
  insertAttachments({}, [{ path: 'D:\\hub\\scaled.png', originalPath: 'D:\\source\\大图.png', resized: true,
    from: { width: 3840, height: 2160 }, to: { width: 2000, height: 1125 } }], { chips: true });
  assert.deepEqual(inserted, { text: 'D:\\hub\\scaled.png', label: '大图.png · Automatically resized' });
});

test('审核四项：真实隐藏 Electron 的像素尺寸、方向、异步目标与群聊拖入', async t => {
  const os = require('node:os'), sharp = require('sharp');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-f2b-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await sharp({ create: { width: 4000, height: 2400, channels: 4, background: '#3478f6' } }).png().toFile(path.join(root, 'retina@2x.png'));
  await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#ff0000' } })
    .withMetadata({ orientation: 6 }).jpeg().toFile(path.join(root, 'exif6.jpg'));
  const raw = Buffer.alloc(8 * 4 * 3);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
    const i = (y * 8 + x) * 3; raw[i] = x * 30; raw[i + 1] = y * 70; raw[i + 2] = 150;
  }
  for (let n = 1; n <= 8; n++) {
    const jpg = await sharp(raw, { raw: { width: 8, height: 4, channels: 3 } }).withMetadata({ orientation: n }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
    // Exercise big-endian TIFF as well as sharp's little-endian output.
    if (n % 2 === 0) {
      const exif = jpg.indexOf(Buffer.from('Exif\0\0')) + 6;
      const length = jpg.readUInt16BE(exif - 8) - 8;
      // A minimal big-endian IFD, padded to the original APP1 size.
      const metadata = Buffer.alloc(length);
      metadata.write('MM', 0); metadata.writeUInt16BE(42, 2); metadata.writeUInt32BE(8, 4);
      metadata.writeUInt16BE(1, 8); metadata.writeUInt16BE(0x0112, 10); metadata.writeUInt16BE(3, 12);
      metadata.writeUInt32BE(1, 14); metadata.writeUInt16BE(n, 18);
      metadata.copy(jpg, exif);
    }
    await fs.promises.writeFile(path.join(root, `orientation-${n}.jpg`), jpg);
    await sharp(jpg).rotate().png().toFile(path.join(root, `upright-${n}.png`));
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/f2b-file-image-electron.cjs'), root],
    { cwd: path.resolve(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  const rows = JSON.parse(fs.readFileSync(path.join(root, 'results.json'), 'utf8'));
  await t.test('@2x 4000×2400 按物理像素缩到 2000×1200', () => {
    assert.equal(rows.retina.resized, true);
    assert.deepEqual(rows.retina.from, { width: 4000, height: 2400 });
    assert.deepEqual(rows.retina.output, { width: 2000, height: 1200 });
  });
  await t.test('EXIF=6 输出竖图 1000×2000；八种方向逐像素核对', () => {
    assert.equal(rows.exif.resized, true);
    assert.deepEqual(rows.exif.output, { width: 1000, height: 2000 });
  });
  await t.test('粘贴后切焦点：文件与位图各只写原输入框一次，不抢焦点', () => {
    for (const row of rows.dom.filter(row => 'bitmap' in row)) {
      assert.equal(row.calls, 1); assert.equal(row.b, 'B draft'); assert.equal(row.active, 'b');
      assert.equal((row.a.match(/prepared\.png/g) || []).length, 1);
      assert.equal(row.aChips, row.resized ? 1 : 0); assert.equal(row.bChips, 0);
    }
  });
  await t.test('群聊 native drop 走缩放；异步切群的 paste/drop 只回原群草稿', () => {
    for (const row of rows.dom.filter(row => row.mode)) {
      assert.equal(row.calls, 1); assert.equal(row.active, 'b'); assert.equal(row.b, 'B draft');
      if (row.switchRoom) {
        assert.equal(row.text, 'B room draft'); assert.equal(row.chips, 0);
        assert.match(row.drafts.A, /scaled\.png$/); assert.equal(row.drafts.B, undefined);
      } else {
        assert.equal(row.chips, 1); assert.match(row.text, /scaled\.png$/);
        if (row.mode === 'drop') assert.match(row.text, /^A draft\n\nD:/);
      }
    }
  });
});

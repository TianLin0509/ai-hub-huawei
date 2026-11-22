'use strict';

// Hidden, isolated Electron; synthetic DOM file events, real nativeImage.
// No system clipboard, credentials, production Hub, or model requests.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.argv[2], repo = path.resolve(__dirname, '../..');
app.setPath('userData', path.join(root, 'electron-profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const rows = {};
  const { prepareImageFile } = require('../../main/ipc/app-utility-handlers');
  const deps = { fs, path, nativeImage, crypto: require('node:crypto'), imageDir: path.join(root, 'copies'), logger: { info() {}, warn() {} } };
  for (const [key, name] of [['retina', 'retina@2x.png'], ['exif', 'exif6.jpg']]) {
    const source = path.join(root, name), before = fs.readFileSync(source);
    const result = prepareImageFile(deps, source);
    assert(before.equals(fs.readFileSync(source)));
    rows[key] = { ...result, output: nativeImage.createFromPath(result.path).getSize() };
  }
  // Exact pixel placement for all eight TIFF orientations, both byte orders.
  const { decodeImageFile } = require('../../core/image-file-orientation');
  for (let n = 1; n <= 8; n++) {
    const actual = decodeImageFile(nativeImage, fs.readFileSync(path.join(root, `orientation-${n}.jpg`)));
    const expected = nativeImage.createFromPath(path.join(root, `upright-${n}.png`));
    assert.deepEqual(actual.getSize(), expected.getSize(), `orientation ${n} dimensions`);
    const a = actual.toBitmap(), b = expected.toBitmap();
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) assert(Math.abs(a[i] - b[i]) <= 3, `orientation ${n} pixel ${i}`);
  }
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  await window.loadURL('about:blank');
  rows.dom = await window.webContents.executeJavaScript(`(async () => {
    const path = require('node:path'), repo = ${JSON.stringify(repo)};
    const { createTerminalInputController } = require(path.join(repo, 'renderer/terminal-input-controller'));
    const chips = require(path.join(repo, 'renderer/composer-paste-chips'));
    const tick = () => new Promise(resolve => setTimeout(resolve, 30));
    const results = [];
    window.__hubToast = () => {};
    const make = tag => document.createElement(tag);
    const caret = input => { input.focus(); const r = document.createRange(); r.selectNodeContents(input); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); };
    for (const bitmap of [false, true]) for (const resized of [false, true]) {
      document.body.innerHTML = '<div id="a" contenteditable="true">A draft</div><div id="b" contenteditable="true">B draft</div>';
      const a = document.getElementById('a'), b = document.getElementById('b');
      let release, calls = 0;
      const prepared = new Promise(resolve => { release = resolve; });
      const ipcRenderer = { invoke: async () => { calls++; return prepared; } };
      const controller = createTerminalInputController({ document, window, ipcRenderer,
        clipboard: { readImage: () => ({ isEmpty: () => !bitmap }) }, terminalCache: new Map(),
        webUtils: { getPathForFile: () => bitmap ? '' : 'D:/fixture with spaces/photo.png' } });
      controller.attachContenteditablePasteImage(a, { collapseLongText: true });
      caret(a);
      const dt = new DataTransfer(); dt.items.add(new File(['fixture'], 'photo.png', { type: 'image/png' }));
      a.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      caret(b);
      release({ path: 'D:/fixture with spaces/prepared.png', originalPath: 'D:/fixture with spaces/photo.png', resized,
        from: { width: 4000, height: 2400 }, to: { width: 2000, height: 1200 } });
      await tick();
      results.push({ bitmap, resized, calls, a: chips.expandPasteMarkers(a.innerText), b: b.innerText,
        aChips: a.querySelectorAll('.fi-paste-chip').length, bChips: b.querySelectorAll('.fi-paste-chip').length,
        active: document.activeElement.id });
    }
    // Group composer reuses one DOM node: changing the room must save to A's
    // draft and leave B's draft and selection untouched, for paste and drop.
    for (const mode of ['paste', 'drop']) for (const switchRoom of [false, true]) {
      document.body.innerHTML = '<div id="row"><div id="g" contenteditable="true">A draft</div></div><div id="toolbar"></div><div id="b" contenteditable="true">B draft</div>';
      const input = document.getElementById('g'), b = document.getElementById('b');
      input.style.whiteSpace = 'pre-wrap';
      let meeting = { id: 'A', groupChat: true }, release, calls = 0;
      const drafts = {};
      const prepared = new Promise(resolve => { release = resolve; });
      const ipcRenderer = { invoke: async () => { calls++; return prepared; } };
      const onOtherTarget = (id, items) => { drafts[id] = items.map(item => item.path).join('\\n'); };
      if (mode === 'drop') {
        require(path.join(repo, 'renderer/group-composer-tools')).mountGroupComposerTools({
          toolbar: document.getElementById('toolbar'), input, getMeeting: () => meeting, ipcRenderer,
          droppedFilePath: () => 'D:/fixture with spaces/photo.png', onOtherTarget,
          onDraft: id => { drafts[id] = chips.expandPasteMarkers(input.innerText); }, onError: error => { throw error; } });
      } else {
        const controller = createTerminalInputController({ document, window, ipcRenderer,
          clipboard: { readImage: () => ({ isEmpty: () => true }) }, terminalCache: new Map(),
          webUtils: { getPathForFile: () => 'D:/fixture with spaces/photo.png' } });
        controller.attachContenteditablePasteImage(input, { collapseLongText: true,
          getTargetId: () => meeting.id, onOtherTarget });
      }
      caret(input);
      const dt = new DataTransfer(); dt.items.add(new File(['fixture'], 'photo.png', { type: 'image/png' }));
      input.dispatchEvent(mode === 'drop' ? new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
        : new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (switchRoom) { meeting = { id: 'B', groupChat: true }; input.textContent = 'B room draft'; }
      caret(b);
      release({ path: 'D:/fixture with spaces/scaled.png', originalPath: 'D:/fixture with spaces/photo.png', resized: true,
        from: { width: 4000, height: 2400 }, to: { width: 2000, height: 1200 } });
      await tick();
      results.push({ mode, switchRoom, calls, text: chips.expandPasteMarkers(input.innerText), drafts,
        chips: input.querySelectorAll('.fi-paste-chip').length, active: document.activeElement.id, b: b.innerText });
    }
    return results;
  })()`);
  window.destroy();
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(rows, null, 2));
  app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });

'use strict';

// 复制图片时剪贴板常同时带一段「只有空白」的 text/plain 或 text/html（Office、IM、网页 <img> 都会）。
// 这段空白不能当文本粘贴：否则输入框只多几个换行，图片路径却没有插入。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalInputController } = require('../renderer/terminal-input-controller');

const IMAGE_PATH = 'D:\\hub-data\\images\\20261104032659-dbd96d.png';

async function paste({ plain = '', html = '', imageOnClipboard = true }) {
  const listeners = {};
  const inserted = [];
  const invoked = [];
  const inputEl = {
    dataset: {},
    addEventListener: (type, fn) => { listeners[type] = fn; },
    dispatchEvent() {},
  };
  const document = {
    createElement: () => ({ style: {}, dataset: {} }),
    body: { appendChild() {} },
    execCommand: (cmd, _ui, value) => { if (cmd === 'insertText') inserted.push(value); return true; },
  };
  const window = {
    // 与未渲染文档一致：innerText 退化为 textContent，标签之间的空白全部保留。
    DOMParser: class {
      parseFromString(source) {
        const textContent = String(source).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
        return { body: { textContent } };
      }
    },
  };
  const controller = createTerminalInputController({
    document,
    window,
    ipcRenderer: { invoke: async channel => { invoked.push(channel); return IMAGE_PATH; } },
    clipboard: { readImage: () => ({ isEmpty: () => !imageOnClipboard }), readText: () => plain },
    terminalCache: new Map(),
    EventCtor: class { constructor(type) { this.type = type; } },
    requestAnimationFrameFn: () => {},
    setTimeoutFn: () => {},
    clearTimeoutFn: () => {},
  });
  controller.attachContenteditablePasteImage(inputEl);
  let prevented = false;
  await listeners.paste({
    preventDefault: () => { prevented = true; },
    clipboardData: {
      files: [],
      items: [],
      getData: type => (type === 'text/plain' ? plain : type === 'text/html' ? html : ''),
    },
  });
  return { inserted, invoked, prevented };
}

test('只有换行的 text/plain + 图片：插入图片路径，不插入空白', async () => {
  const result = await paste({ plain: '\n\n\n\n\n\n\n' });
  assert.deepEqual(result.inserted, [IMAGE_PATH]);
  assert.deepEqual(result.invoked, ['save-clipboard-image']);
  assert.equal(result.prevented, true);
});

test('只包一张 <img> 的 text/html + 图片：插入图片路径，不插入空白', async () => {
  const html = '<html>\n<body>\n<!--StartFragment-->\n<p>\n<img src="x.png">\n</p>\n<!--EndFragment-->\n</body>\n</html>\n';
  assert.deepEqual((await paste({ html })).inserted, [IMAGE_PATH]);
});

test('零宽字符、NBSP 和对象占位符也不算文本', async () => {
  assert.deepEqual((await paste({ plain: ' \u00a0\u200b\ufeff\ufffc\r\n' })).inserted, [IMAGE_PATH]);
});

test('有实际文字时仍按文字粘贴，不另存图片', async () => {
  const result = await paste({ plain: '表格里的文字' });
  assert.deepEqual(result.inserted, ['表格里的文字']);
  assert.deepEqual(result.invoked, []);
});

test('剪贴板没有图片时，空白文本照常粘贴', async () => {
  const result = await paste({ plain: '   ', imageOnClipboard: false });
  assert.deepEqual(result.inserted, ['   ']);
  assert.deepEqual(result.invoked, []);
});

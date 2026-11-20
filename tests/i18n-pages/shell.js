// shell 组（renderer/index.html 静态面板）的英文截图界面。
const click = (id) => `document.getElementById('${id}')?.click()`;
const esc = "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))";
module.exports = {
  'shell-launch': { open: click('btn-new-more'), wait: 1200, close: esc },
  'shell-search': { open: click('btn-global-search'), wait: 1500, close: "document.getElementById('search-modal-close')?.click();" + esc },
  'shell-theme': { open: click('btn-theme'), wait: 800, close: click('btn-theme') },
  'shell-options': { open: click('btn-options'), wait: 800, close: click('btn-options') },
  'shell-more': { open: click('btn-toolbar-more'), wait: 800, close: click('btn-toolbar-more') },
  'shell-accounts': { open: click('btn-rail-accounts'), wait: 1500, close: click('btn-home') },
};

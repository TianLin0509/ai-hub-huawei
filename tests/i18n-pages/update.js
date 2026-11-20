'use strict';
// update 组（更新提示、版本选择、新版说明、错误卡片、环境检测、反馈）的英文截图界面。错误卡片用假报错触发，不连真实会话。
const closeDialog = sel => `document.querySelectorAll('${sel}').forEach(d => d.open && d.close())`;
const toast = (msg, opts) => `(() => { window.HubErrorCard.showErrorToast(${JSON.stringify(msg)}, ${JSON.stringify(opts || {})}); })()`;
const expandToast = (msg, opts) => `(async () => { ${toast(msg, opts)}; await new Promise(r => setTimeout(r, 500)); document.querySelector('#hub-err-toast [data-hub-err-toast="detail"]')?.click(); })()`;
const closeToast = "document.getElementById('hub-err-toast')?.remove()";
module.exports = {
  'update-panel': { open: 'window.__appUpdate && window.__appUpdate.open()', wait: 6000, close: closeDialog('dialog') },
  'version-picker': { open: "document.getElementById('options-versions')?.click()", wait: 12000, close: closeDialog('dialog.vp-dialog') },
  'whats-new': { open: 'window.__whatsNew && window.__whatsNew.open()', wait: 1500, close: closeDialog('dialog') },
  'env-check': { open: 'window.__envCheck && window.__envCheck.open()', wait: 15000, close: closeDialog('dialog') },
  'env-components': { open: 'window.__componentCenter && window.__componentCenter.open()', wait: 6000, close: closeDialog('dialog') },
  'env-details': { open: "(async () => { window.__envCheck && window.__envCheck.open(); await new Promise(r => setTimeout(r, 1500)); document.querySelector('[data-ec-tab=\"environment\"]')?.click(); })()", wait: 15000, close: closeDialog('dialog') },
  'error-toast': {
    open: toast('CLI 已退出，消息未发送', { area: 'session', resendText: 'hello', terminalTail: ['Error: spawn claude ENOENT'], ms: 60000 }),
    wait: 1200, close: closeToast,
  },
  'error-card': {
    open: expandToast('Error: connect ECONNREFUSED 127.0.0.1:8080', { area: 'company-proxy', ms: 60000 }),
    wait: 1500, close: closeToast,
  },
  'feedback': { open: 'window.__hubFeedback && window.__hubFeedback.open()', wait: 2500, close: closeDialog('dialog') },
  'feedback-mine': { open: 'window.__hubFeedback && window.__hubFeedback.openMine()', wait: 2000, close: closeDialog('dialog') },
};

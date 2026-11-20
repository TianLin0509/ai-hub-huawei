'use strict';
// launch 组（启动中心、首页、外观、可选功能）的英文截图界面。首页即 main，设置弹窗即 settings，均在主脚本里。
const openAppearance = tab => `(async () => { document.getElementById('options-appearance')?.click(); await new Promise(r => setTimeout(r, 900)); document.querySelector('#appearance-dialog [data-tab="${tab}"]')?.click(); })()`;
const closeAppearance = "document.getElementById('appearance-dialog')?.close()";
module.exports = {
  'launch-center': { open: "document.getElementById('btn-new')?.click()", wait: 1500, close: "document.getElementById('new-session-close')?.click()" },
  'launch-group': { open: "document.getElementById('btn-new')?.click(); setTimeout(() => document.getElementById('launch-intent-group')?.click(), 400)", wait: 1800, close: "document.getElementById('new-session-close')?.click()" },
  'launch-web': { open: "document.getElementById('btn-new')?.click(); setTimeout(() => document.getElementById('launch-intent-web')?.click(), 400)", wait: 1800, close: "document.getElementById('new-session-close')?.click()" },
  'appearance-packs': { open: openAppearance('packs'), wait: 1800, close: closeAppearance },
  'appearance-individual': { open: openAppearance('individual'), wait: 1800, close: closeAppearance },
  'appearance-icons': { open: openAppearance('icons'), wait: 1800, close: closeAppearance },
  'appearance-online': { open: openAppearance('online'), wait: 1800, close: closeAppearance },
  'optional-features': { open: 'window.__optionalFeatures && window.__optionalFeatures.open()', wait: 1500, close: "document.querySelector('.optional-features-dialog')?.close()" },
};

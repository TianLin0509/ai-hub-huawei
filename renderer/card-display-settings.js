'use strict';

const {
  DEFAULT_CARD_FONT_SIZE,
  normalizeCardDisplayConfig,
} = require('../core/card-display-config.js');

const CARD_FONT_STACKS = Object.freeze({
  system: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
  yahei: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  mono: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace',
});

function codeFontScale(cardFontSize) {
  return (cardFontSize / DEFAULT_CARD_FONT_SIZE).toFixed(3);
}

function applyCardDisplaySettings(document, config = {}) {
  const normalized = normalizeCardDisplayConfig(config);
  const root = document && document.documentElement;
  if (root && root.style && typeof root.style.setProperty === 'function') {
    root.style.setProperty('--card-content-font-size', `${normalized.cardFontSize}px`);
    root.style.setProperty('--card-content-font-family', CARD_FONT_STACKS[normalized.cardFontFamily]);
    // 代码块字号跟着正文字号等比缩放（2026-11-19 反馈：代码字号固定、调不大）。
    // 用「正文字号 / 默认字号」做倍率，没调过字号的用户代码块仍是原来的大小。
    root.style.setProperty('--card-code-scale', codeFontScale(normalized.cardFontSize));
  }
  if (root && root.dataset) root.dataset.cardOpenAt = normalized.cardOpenAt;
  return normalized;
}

module.exports = {
  CARD_FONT_STACKS,
  applyCardDisplaySettings,
  codeFontScale,
};

'use strict';

const CARD_FONT_SIZE_MIN = 13;
const CARD_FONT_SIZE_MAX = 22;
// 对话正文默认字号：公司版按 8 档字号用 16，其余 15。只决定「没设置过」时的值，用户在显示参数里调过的照旧。
const DEFAULT_CARD_FONT_SIZE = require('./distribution').target === 'company' ? 16 : 15;
const DEFAULT_CARD_FONT_FAMILY = 'system';
const CARD_FONT_FAMILY_IDS = Object.freeze(['system', 'yahei', 'serif', 'mono']);

function normalizeCardFontSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CARD_FONT_SIZE;
  return Math.min(CARD_FONT_SIZE_MAX, Math.max(CARD_FONT_SIZE_MIN, parsed));
}

function normalizeCardFontFamily(value) {
  const id = String(value || '').trim().toLowerCase();
  return CARD_FONT_FAMILY_IDS.includes(id) ? id : DEFAULT_CARD_FONT_FAMILY;
}

function normalizeCardDisplayConfig(config = {}) {
  return {
    cardFontSize: normalizeCardFontSize(config.cardFontSize),
    cardFontFamily: normalizeCardFontFamily(config.cardFontFamily),
  };
}

module.exports = {
  CARD_FONT_SIZE_MIN,
  CARD_FONT_SIZE_MAX,
  DEFAULT_CARD_FONT_SIZE,
  DEFAULT_CARD_FONT_FAMILY,
  CARD_FONT_FAMILY_IDS,
  normalizeCardFontSize,
  normalizeCardFontFamily,
  normalizeCardDisplayConfig,
};

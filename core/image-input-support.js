'use strict';
// 成员能不能看图（图片输入）。界面只给「确定能看」的成员打 🖼 标记；拿不准的不标。
// modelLacksVision 是唯一的「这个模型看不了图」判断：ACP 会话发图前的拦截（acp-attachments.js、acp-session.js）
// 和小队的看图标记共用，名单只在这里改。公司 CodeAgent 背后的模型因人而异、能力未公开，默认不标。

// 已知不能看图的模型（以模型名开头匹配）。
const NON_VISION_MODEL = /^(deepseek-v4|deepseek-flash|deepseek-chat|deepseek-reasoner|deepseek-coder|glm-5\.2|qwen3\.7-max|qwen3-coder)/i;
// 后端本身支持图片输入、且默认模型都能看图的。
const VISION_KINDS = new Set(['claude', 'codex', 'gemini']);
// 后端默认模型就是不能看图的。
const NON_VISION_KINDS = new Set(['deepseek', 'deepseek-acp', 'deepseek-claude']);
const OWN_MODEL = /claude|opus|sonnet|haiku|fable|gpt|^o\d|codex|gemini|^default$|^auto$/i;

function modelLacksVision(model) {
  return NON_VISION_MODEL.test(String(model || '').trim());
}

// 返回 true（能看图）、false（看不了）、null（不确定，不标）。
function imageInputSupport({ kind = '', model = '' } = {}) {
  const k = String(kind || '').replace(/-resume$/, '');
  const m = String(model || '').trim();
  if (m && modelLacksVision(m)) return false;
  if (NON_VISION_KINDS.has(k)) return false;
  // Claude / Codex / Gemini 后端也能接第三方模型：模型名认不出是自家模型时不标。
  if (VISION_KINDS.has(k)) return !m || OWN_MODEL.test(m) ? true : null;
  return null;
}

module.exports = { NON_VISION_MODEL, modelLacksVision, imageInputSupport };

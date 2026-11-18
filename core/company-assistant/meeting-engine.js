'use strict';
// 会议伴侣用哪个终端（CodeAgent / Claude Code / Codex）配哪个模型（2026-11-08）。
// 自动档先用账号明确保存且仍可选的默认模型；没有明确配置时再按公司对照评测优先级挑选。
// 用户在「更多」里手动选了就用他选的。没有任何组合可用时退回 CodeAgent + 账号默认模型（老行为）。
const LABEL = { codeagent: 'CodeAgent', claude: 'Claude Code', codex: 'Codex' };
const FAMILY_LABEL = { glm: 'GLM', ds: 'DeepSeek', native: '账号默认模型' };
// 优先级：harness:family。依据公司对照评测 Q-1108-26（两场模拟会议 × 三档，DeepSeek 评委；CodeAgent+GLM 取 Q-1108-21）：
// - 同一模型下 GLM 每轮 30–75 秒，DeepSeek 85–160 秒，纪要分数接近 → GLM 在前；
// - Claude Code + GLM 每轮最快（快速档约 30 秒）、纪要 33/34、26/27，CodeAgent 同源同参数紧随；Codex + GLM 分数相当但每轮慢一倍；
// - Codex + DeepSeek 138 轮里 48 轮断流/503/超时，排最后。改顺序只改这里。
const GLM_FIRST = ['claude:glm', 'codeagent:glm', 'codex:glm', 'codeagent:ds', 'claude:ds', 'claude:native', 'codex:native', 'codex:ds'];
const PRIORITY = { fast: GLM_FIRST, normal: GLM_FIRST, deep: ['claude:glm', 'codex:glm', 'codeagent:glm', 'codeagent:ds', 'claude:ds', 'claude:native', 'codex:native', 'codex:ds'] };
function family(id) {
  const s = String(id || '');
  if (/glm/i.test(s)) return 'glm';
  if (/deepseek/i.test(s)) return 'ds';
  return s ? 'other' : 'native';
}
// available：{ codeagent: [{id,label}], claude: [{id,label}] | null, codex: … }；null 表示没装或没接上模型。
function engines(available = {}) {
  const out = [];
  for (const harness of Object.keys(LABEL)) {
    for (const m of available[harness] || []) {
      const fam = family(m.id);
      out.push({ id: `${harness}|${m.id}`, harness, model: m.id, family: fam, label: `${LABEL[harness]} · ${m.id ? (m.label || m.id) : FAMILY_LABEL.native}` });
    }
  }
  return out;
}
// 账号明确保存的默认模型优先；必须仍在该账号的模型清单内，不猜别的客户端有同样权限。
function accountDefault({ dataDir, personalDir, fsModule } = {}) {
  const known = require('../codeagent-model-route').personalModels({ dataDir, personalDir, ...(fsModule ? { fsModule } : {}) });
  return known.written && known.defaultModel && !known.configMismatch ? `codeagent|${known.defaultModel}` : '';
}
function rank(list, speed, preferred = '') {
  const order = PRIORITY[speed] || PRIORITY.normal;
  const score = e => {
    if (preferred && e.id.toLowerCase() === preferred.toLowerCase()) return -1;
    const i = order.indexOf(`${e.harness}:${e.family}`);
    return i < 0 ? order.length : i;
  };
  return [...list].sort((a, b) => score(a) - score(b));
}
function recommended(available, speed, preferred = '') { return rank(engines(available), speed, preferred)[0] || null; }
// m.engine：用户手选的组合 id；旧会议的「快速档模型」仍按 CodeAgent 用。
function choose(m, available, speed = m.speed || 'normal', preferred = '') {
  const list = engines(available);
  if (m.engine) {
    const hit = list.find(e => e.id === m.engine);
    if (!hit) throw new Error('所选的会议 AI 已不可用（终端没装或模型已下线），请在「更多」里重新选择');
    return hit;
  }
  if (speed === 'fast' && m.fastModel) return { id: `codeagent|${m.fastModel}`, harness: 'codeagent', model: m.fastModel, family: family(m.fastModel), label: `${LABEL.codeagent} · ${m.fastModel}` };
  return recommended(available, speed, preferred) || { id: 'codeagent|', harness: 'codeagent', model: '', family: 'native', label: LABEL.codeagent };
}
module.exports = { LABEL, PRIORITY, family, engines, rank, recommended, choose, accountDefault };

'use strict';

/*
 * Semantic workflow templates.
 * Templates only prefill the editable serial-workflow form. They never lock it:
 * callers may freely change steps, assignees, names, and prompts afterwards.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WorkflowTemplates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const REVIEW_RESULT_CONTRACT = [
    '最后严格输出四行：',
    'RESULT: PASS 或 FAIL',
    'BLOCKERS: 无，或列出必须修复的问题',
    'VERIFIED: 实际执行的验证及结果',
    'NEXT: 无，或下一步建议',
  ].join('\n');
  const AUTHOR_RESULT_CONTRACT = '最终四行：\nPROGRESS: 完成内容\nVERIFIED: 实际验证命令和结果\nRISK: 残余风险\nREPORT: 报告路径或无';

  const TASK_PRESETS = [
    { id: 'task-safe-resume', name: '续跑', desc: '先校准当前状态，再继续未完成项', minMembers: 2, recommended: true },
    { id: 'task-review-verify', name: '审查', desc: '缺陷、回归、验证分步审查后收口', minMembers: 2 },
    { id: 'task-feature-delivery', name: '功能', desc: '范围与验收、实现、验证串行交付', minMembers: 2 },
    { id: 'task-root-cause-fix', name: '修 Bug', desc: '并行诊断、最小修复、独立回归', minMembers: 2 },
    { id: 'task-research-decision', name: '调研', desc: '支持证据、反证、缺失信息、决策', minMembers: 2 },
    // 开发场景的默认工作流。**通用**：prompt 里不出现任何项目名或绝对路径，
    // 全部走仓库内相对路径 —— 群聊的工作目录就是项目根，所以 .agents/AUTHOR.md 对任何项目都成立。
    // 项目差异沉淀在各自仓库的 .agents/ 里，改流程只改那几个 .md，不用回来动 Hub。
    { id: 'dev-task', name: '开发任务', desc: '实现与独立验证合并', minMembers: 2, recommended: true },

  ];

  const TEMPLATES = [
    {
      id: 'review-plan-build-finalize',
      name: '审视 → 方案 → 落地 → 终审',
      desc: '2–3 个 AI 先并行审视，再由单个 AI 收敛、落地和终审',
      minMembers: 2,
      recommended: true,
    },
    {
      id: 'three-agent-two-improvements',
      name: '三 AI · 两点优化接力',
      desc: '每一棒先修前序问题，再落地两个不重复优化点',
      minMembers: 2,
    },
    {
      id: 'fast-review-loop',
      name: '快速实现闭环',
      desc: '1 个执行者 + 1–2 个评审；FAIL 回修，PASS 立即结束',
      minMembers: 2,
    },
    {
      id: 'parallel-review-synthesis',
      name: '多审一决',
      desc: '2–3 个 AI 独立给意见，再由 1 个 AI 裁决收口',
      minMembers: 2,
    },
  ];

  function getTemplateMeta(templateId) {
    return TASK_PRESETS.concat(TEMPLATES).find(t => t.id === templateId) || null;
  }

  // 开发场景开在工作根（默认工作目录）时，prompt 前面加一段「先定位项目根」。
  // 项目库是建群那一刻从 Hub 拿到的快照：已整理项目的中文名 → 绝对路径，按活跃时间排序。
  // 绝对路径只在这里**运行时**拼进去，Hub 源码里仍然一个项目名、一条路径都没有。
  function buildProjectLocatorPrompt(projects) {
    const list = (Array.isArray(projects) ? projects : [])
      .filter(p => p && typeof p.path === 'string' && p.path.trim())
      .map(p => `- ${String(p.name || '').trim() || p.path} → ${p.path.trim()}`);
    const lines = [
      '【先定位项目根】当前工作目录是工作根，不是任何项目的根。先根据我的任务判断它属于哪个项目，',
      '从下面的项目库里选出项目根并切换过去，之后「本仓库」一律指它，所有相对路径都以它为准。',
    ];
    if (list.length) {
      lines.push('项目库（按最近活跃排序）：');
      lines.push(...list);
    } else {
      lines.push('项目库目前是空的：完成 project-prep 后登记正式目录。不得把扫描发现的目录当作项目库项目。');
    }
    lines.push('判断不了属于哪个项目就先问我一句，不要猜，也不要在工作根下乱翻。');
    return lines.join('\n');
  }

  function normalizeStepConfigs(steps, stepConfigs) {
    return (steps || []).map((_step, index) => {
      const item = Array.isArray(stepConfigs) && stepConfigs[index] && typeof stepConfigs[index] === 'object'
        ? stepConfigs[index]
        : {};
      const out = {
        name: typeof item.name === 'string' ? item.name : '',
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
      };
      if (item.after === 'end' || item.after === 'next') out.after = item.after;
      // timeoutMs 是可选的按步超时。loop-engine 会读它（缺省 10 分钟，钳位 1–30 分钟），
      // 但这里以前只保留 name/prompt，模板填的值在归一化时被吃掉，引擎永远读到 undefined。
      // 只在是有限正数时保留，避免把 NaN/字符串塞进去让引擎的 clamp 退回默认值。
      const t = Number(item.timeoutMs);
      if (Number.isFinite(t) && t > 0) out.timeoutMs = t;
      return out;
    });
  }

  function buildSerialStepPrompt(goal, stepConfig, index, total) {
    const cfg = stepConfig && typeof stepConfig === 'object' ? stepConfig : {};
    const prompt = String(cfg.prompt || '').trim();
    if (!prompt) return String(goal || '');
    const name = String(cfg.name || '').trim();
    return [
      `【串行工作流 · 第 ${index + 1}/${total} 步${name ? ` · ${name}` : ''}】`,
      `总目标：${String(goal || '').trim()}`,
      '',
      '本步骤职责：',
      prompt,
      '',
      index > 0 ? '请先阅读群内前序步骤结果，只完成本步骤职责。' : '只完成本步骤职责，不要提前代替后续步骤。',
      '涉及代码修改时必须运行最小相关验证。输出保持简洁：结论、动作、验证、风险。',
    ].join('\n');
  }

  return {
    REVIEW_RESULT_CONTRACT,
    TASK_PRESETS,
    TEMPLATES,
    getTemplateMeta,
    buildProjectLocatorPrompt,
    normalizeStepConfigs,
    buildSerialStepPrompt,
  };
});

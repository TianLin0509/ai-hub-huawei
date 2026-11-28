'use strict';
// 技能广场的界面假数据桩（全部自造，不含任何真实员工助手技能内容）。
// 用法：E2E 里把 installSource() 的结果交给页面 eval，接管 renderer 里 skill-plaza:* 的 IPC；
// 记录每次调用到 window.__spzStub.calls，便于断言入参（如需改写档的 acknowledgeRewrite）。
// 主进程的真实实现合入后，E2E 加 --real 走真实处理器，这个桩只在没有真实处理器时用。

function stub() {
  const { ipcRenderer } = require('electron');
  if (window.__spzStub) return 'already';
  const mk = (id, source, name, displayName, description, category, use, extra = {}) => ({ id, source, name, displayName, description, category, use, companyOnly: false, deps: [], installedIn: [], ...extra });
  const items = [
    mk('weclaw:demo-doc-proof', 'weclaw', 'demo-doc-proof', '文档校对', '检查标点、语法和错别字，输出修改报告', 'office', 'ok', { version: '0.1.0' }),
    mk('weclaw:demo-md-convert', 'weclaw', 'demo-md-convert', '文档转 Markdown', '把 Word、PDF、表格转成 Markdown', 'office', 'ok'),
    mk('weclaw:demo-slide-factory', 'weclaw', 'demo-slide-factory', '汇报页工厂', '按公司汇报模板把大纲排成幻灯片', 'ppt', 'fix', { deps: [{ key: 'cli', label: '员工助手命令行', why: '技能里调用员工助手自带的命令行', files: ['SKILL.md'] }] }),
    mk('weclaw:demo-meeting-notes', 'weclaw', 'demo-meeting-notes', '会议纪要与逐字稿', '取会议逐字稿并总结成纪要', 'welink', 'fix', { deps: [{ key: 'svc', label: '员工助手本机服务', why: '要连员工助手在本机开的服务', files: ['SKILL.md'] }] }),
    mk('weclaw:demo-timesheet', 'weclaw', 'demo-timesheet', '工时草稿', '在内网工时系统补齐本周工时，默认只存草稿', 'intranet', 'delegate', { companyOnly: true }),
    mk('weclaw:demo-address', 'weclaw', 'demo-address', '内部系统地址', '常用内网系统地址速查', 'intranet', 'ok', { companyOnly: true }),
    mk('weclaw:demo-leave', 'weclaw', 'demo-leave', '请假助手', '在内网流程里填请假单', 'intranet', 'delegate'),
    mk('weclaw:demo-welink-digest', 'weclaw', 'demo-welink-digest', 'WeLink 群消息摘要', '汇总指定群今天的讨论要点', 'welink', 'fix'),
    mk('local:demo-sim', 'local', 'demo-sim', '仿真作业', '改配置、编译、提交仿真并取回结果', 'dev', 'installed', { installedIn: ['claude', 'agents'] }),
    mk('local:demo-review', 'local', 'demo-review', '代码审查', '按团队规范审查改动', 'dev', 'installed', { installedIn: ['codeagent'] }),
    mk('local:demo-ppt-check', 'local', 'demo-ppt-check', '汇报页自检', '检查幻灯片的字号、对齐和配色', 'ppt', 'installed', { installedIn: ['claude'] }),
    mk('agentcenter:demo-lint', 'agentcenter', 'demo-lint', '代码规范检查', 'AgentCenter 插件市场 · CodeAgent 可装', 'dev', 'ok', { marketId: 'demo-lint' }),
    mk('agentcenter:demo-misc', 'agentcenter', 'demo-misc', '随手记', '把零散想法整理成待办', 'other', 'ok', { marketId: 'demo-misc' }),
  ];
  for (let i = 1; i <= 8; i++) items.push(mk(`weclaw:demo-extra-${i}`, 'weclaw', `demo-extra-${i}`, `示例技能 ${i}`, '用来测分页的自造技能', i % 2 ? 'other' : 'office', 'ok'));
  const targets = [
    { id: 'codeagent', label: 'CodeAgent', dir: 'C:/fake/.codeagent/skills', present: true },
    { id: 'claude', label: 'Claude', dir: 'C:/fake/.claude/skills', present: true },
    { id: 'agents', label: 'Codex · DSH · pi', dir: 'C:/fake/.agents/skills', present: false },
  ];
  const state = { weclawPresent: true, calls: [], imported: {}, fail: {} }; // fail.local / fail.agentcenter：模拟那一路读失败
  window.__spzStub = state;
  const view = () => {
    const list = items.filter(i => (state.weclawPresent || i.source !== 'weclaw') && !state.fail[i.source]).map(i => (state.imported[i.id] ? { ...i, use: 'installed', installedIn: state.imported[i.id] } : i));
    const n = src => list.filter(i => i.source === src).length;
    const err = src => (state.fail[src] ? { error: state.fail[src] } : {});
    return { items: list, targets, scannedAt: Date.now(), sources: { weclaw: { present: state.weclawPresent, roots: state.weclawPresent ? ['C:/fake/weclaw/skills'] : [], count: n('weclaw') }, local: { count: n('local'), ...err('local') }, agentcenter: { present: true, count: n('agentcenter'), ...err('agentcenter') } } };
  };
  const ok = data => ({ ok: true, data }), bad = error => ({ ok: false, error });
  const handlers = {
    list: () => ok(view()),
    preview: ({ id }) => {
      const it = items.find(i => i.id === id); if (!it) return bad('找不到这个技能');
      return ok({ item: it, targetName: 'weclaw-' + it.name, fileCount: 3, totalBytes: 5120,
        mapping: [{ field: '名字', before: it.name, after: 'weclaw-' + it.name, note: '' }, { field: '描述与触发词', before: '原文', after: '原文（不变）', note: '' },
          ...(it.use === 'fix' ? [{ field: '命令行', before: '员工助手命令行', after: '保留原样', note: '需要员工助手已登录' }] : []), { field: '中文显示名', before: it.displayName, after: '存在 _origin.json' }],
        migrationNotes: it.use === 'fix' ? ['技能里用到员工助手的命令行，导入后要改成本机可用的做法'] : [] });
    },
    import: ({ id, targets: t, acknowledgeRewrite }) => {
      const it = items.find(i => i.id === id); if (!it) return bad('找不到这个技能');
      if (it.use === 'delegate') return bad('这个技能要交给员工助手执行，不能导入');
      if (it.use === 'fix' && !acknowledgeRewrite) return bad('需改写的技能要先确认「我知道导入后需要改写」');
      const installed = [], skipped = [];
      for (const x of t || []) (targets.find(g => g.id === x)?.present ? installed : skipped).push(targets.find(g => g.id === x)?.present ? { target: x, dir: 'C:/fake/' + x } : { target: x, reason: '这台电脑上没有' });
      if (installed.length) state.imported[id] = installed.map(x => x.target);
      return ok({ installed, skipped });
    },
    remove: ({ id }) => { const had = state.imported[id]; delete state.imported[id]; return had ? ok({ removed: had.map(t => ({ target: t, dir: 'C:/fake/' + t })) }) : bad('台账里没有这个技能'); },
    delegate: ({ id }) => ok({ prompt: '请用技能 ' + id, opened: false }),
    'open-manage': () => ok({}),
  };
  const original = ipcRenderer.invoke.bind(ipcRenderer);
  ipcRenderer.invoke = async (channel, payload) => {
    if (typeof channel === 'string' && channel.startsWith('skill-plaza:')) {
      const op = channel.slice('skill-plaza:'.length);
      state.calls.push({ op, payload: payload ? JSON.parse(JSON.stringify(payload)) : null });
      await new Promise(r => setTimeout(r, 60));
      return handlers[op] ? handlers[op](payload || {}) : bad('没有这个操作');
    }
    return original(channel, payload);
  };
  return 'installed';
}

module.exports = { installSource: () => `(${stub.toString()})()` };

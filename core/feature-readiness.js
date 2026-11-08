'use strict';

// Feature readiness describes prerequisites; it never treats an installed CLI as a successful model request.
function featureReadiness(items = []) {
  const by = new Map(items.map(item => [item.id, item]));
  const definitions = [
    { id: 'codeagent-chat', name: 'CodeAgent 会话', needs: ['codeagent'], note: '程序就绪后，仍需在会话中确认登录和模型可用。' },
    { id: 'claude-company', name: 'Claude Code · 公司模型', needs: ['claude', 'git-bash', 'codeagent', 'company-proxy'], note: '组件就绪不代表已完成一次真实模型请求。' },
    { id: 'codex-company', name: 'Codex · 公司模型', needs: ['codex', 'codeagent', 'company-proxy'], note: '组件就绪不代表已完成一次真实模型请求。' },
    { id: 'dsh-company', name: 'DSH · 公司模型', needs: ['dsh', 'node', 'codeagent', 'company-proxy'], note: '组件就绪不代表已完成一次真实模型请求。' },
    { id: 'welink-assistant', name: '消息、邮件与日历助理', needs: ['welink', 'codeagent'], note: '登录后按助理页提示配置邮件和日历。' },
    { id: 'ppt-library', name: 'PPT 素材库与图片转可编辑', needs: ['ppt-doctor'], note: '素材检索还需在 PPT Doctor 中建立素材库；识别组件按需安装。' },
  ];
  return definitions.filter(d => by.has(d.needs[0]) && (!d.id.endsWith('-company') || by.has('company-proxy'))).map(d => {
    const dependencies = d.needs.map(id => {
      const item = by.get(id);
      // Some platforms do not need Git Bash. An absent check is different from an off proxy.
      if (!item && id === 'git-bash') return null;
      return { id, name: item?.name || id, status: item?.status || 'warn', detail: item?.detail || '尚未检测', fixes: item?.fixes || [] };
    }).filter(Boolean);
    const blocked = dependencies.filter(i => i.status !== 'ok');
    const status = blocked.some(i => i.status === 'bad') ? 'bad' : blocked.length ? 'warn' : 'ok';
    return { ...d, status, label: status === 'ok' ? '组件已就绪' : '需要处理', dependencies,
      detail: blocked.length ? blocked.map(i => `${i.name}：${i.detail}`).join('；') : d.note };
  });
}

module.exports = { featureReadiness };

'use strict';
function openSkillAdd({ document, sessionId, invoke, onInstalled, notify }) {
  const dialog = document.createElement('div'); dialog.className = 'ca-skill-add-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', '添加技能');
  const style = document.createElement('style');
  style.textContent = `.ca-skill-add-dialog,.ca-skill-add-dialog *{-webkit-app-region:no-drag}.ca-skill-add-dialog{position:fixed;z-index:10030;top:15%;left:50%;transform:translateX(-50%);width:min(480px,calc(100vw - 32px));box-sizing:border-box;padding:18px;border:1px solid var(--border-subtle);border-radius:10px;background:var(--surface-raised);color:var(--fg-default);box-shadow:0 10px 40px #0005}.ca-skill-add-dialog input[type=text]{box-sizing:border-box;width:100%;padding:8px;margin:10px 0}.ca-skill-add-dialog pre{white-space:pre-wrap;overflow:auto;max-height:35vh;overflow-wrap:anywhere}.ca-skill-add-dialog button{margin:10px 8px 0 0}.ca-skill-add-dialog a{display:block;margin:8px 0;color:var(--accent)}`;
  const title = document.createElement('strong'); title.textContent = '添加技能';
  const id = document.createElement('input'); id.type = 'text'; id.placeholder = '技能 ID 或 ID@版本'; id.pattern = '(?!-)[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?'; id.setAttribute('aria-label', '技能 ID');
  const browse = document.createElement('a'); browse.href = '#'; browse.textContent = '去 AgentCenter 找技能';
  const scopes = document.createElement('div');
  const global = document.createElement('input'); global.type = 'radio'; global.name = 'ca-skill-scope-' + sessionId; global.value = 'global'; global.checked = true;
  const project = document.createElement('input'); project.type = 'radio'; project.name = global.name; project.value = 'project';
  for (const [control, text] of [[global, '个人'], [project, '当前项目']]) { const label = document.createElement('label'); label.append(control, document.createTextNode(text)); scopes.append(label); }
  const details = document.createElement('pre'), status = document.createElement('div'); status.setAttribute('role', 'status');
  const install = document.createElement('button'); install.type = 'button'; install.textContent = '安装'; install.disabled = true;
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
  dialog.append(style, title, id, browse, scopes, details, status, install, close); document.body.append(dialog); id.focus();
  let installing = false;
  const valid = () => require('../core/codeagent-skill-install').validSkillId(id.value.trim());
  const call = payload => invoke('codeagent:skill-install', { sessionId, ...payload });
  id.addEventListener('input', () => { details.textContent = ''; install.disabled = !valid(); });
  browse.addEventListener('click', async event => { event.preventDefault(); const result = await call({ op: 'browse' }); if (!result?.ok) status.textContent = result?.error || '打开失败'; });
  install.addEventListener('click', async () => {
    if (installing || !valid()) return;
    const value = id.value.trim();
    installing = true; install.disabled = true; id.disabled = true; status.textContent = '安装中…';
    try {
      const result = await call({ op: 'add', id: value, scope: project.checked ? 'project' : 'global' });
      if (!result?.ok) throw new Error(result?.error || '安装失败');
      const installed = result.skill || { name: value }, name = installed.name || installed.id || value;
      details.textContent = [`名称：${name}`, installed.version ? `版本：${installed.version}` : '', installed.description || ''].filter(Boolean).join('\n');
      status.textContent = '已安装 ' + name; notify(status.textContent, 'success');
      await onInstalled(name, value);
    } catch (error) { status.textContent = error.message; }
    finally { installing = false; id.disabled = false; install.disabled = !valid(); }
  });
  close.addEventListener('click', () => { dialog.remove(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { dialog.remove(); event.stopPropagation(); } });
  return { dialog, id, install, project, status, details };
}
module.exports = { openSkillAdd };

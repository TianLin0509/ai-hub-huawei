'use strict';

const { isCodeAgentKind } = require('../core/ai-kinds');
const commandPolicy = require('../core/codeagent-command-policy');
const TAG = '[data-codeagent-skill]';
const DRAFT_KEY = 'hub.codeagent-skill-draft.v1:';
const RECENT_KEY = 'hub.codeagent-recent-skills.v1:';
const RECENT_LIMIT = 5;
const LATE_SKILL = '这个技能在本会话启动后才安装，若未生效请新开会话';

function selectedSkill(input) {
  const tag = input?.querySelector?.(TAG);
  return tag ? { name: tag.dataset.codeagentSkill, installedAt: Number(tag.dataset.installedAt) || 0 } : null;
}
function installationWarning(skill, session) {
  const value = session?.startedAt ?? session?.createdAt;
  const started = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(started) && skill?.installedAt > started ? LATE_SKILL : '';
}
function skillPrompt(input, text, session) {
  const skill = isCodeAgentKind(session?.kind) ? selectedSkill(input) : null;
  if (!skill) return text;
  const prefix = '/' + skill.name;
  const body = text.startsWith(prefix) ? text.slice(prefix.length).replace(/^ /, '') : text;
  return prefix + (body.trim() ? ' ' + body : '');
}
function removeSkillTag(input) {
  const tag = input.querySelector(TAG);
  if (!tag) return;
  const next = tag.nextSibling;
  if (next?.nodeType === 3 && next.textContent.startsWith(' ')) next.textContent = next.textContent.slice(1);
  tag.remove();
}
function insertSkillTag(input, skill, { document, window, session, focus = true, onChange = () => {} }) {
  const chip = document.createElement('span');
  chip.className = 'fi-skill-chip';
  chip.contentEditable = 'false';
  chip.dataset.codeagentSkill = skill.name;
  chip.dataset.installedAt = String(skill.installedAt || 0);
  chip.textContent = '/' + skill.name;
  chip.title = installationWarning(skill, session) || skill.description || '发送时调用这个技能';
  if (installationWarning(skill, session)) chip.dataset.late = 'true';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'fi-skill-remove';
  remove.setAttribute('aria-label', '删除技能 ' + skill.name);
  remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); removeSkillTag(input); onChange(); input.focus(); });
  chip.appendChild(remove); // The × is CSS content, so it never becomes prompt text.
  const old = input.querySelector(TAG);
  if (old) old.replaceWith(chip);
  else input.prepend(chip, document.createTextNode(' '));
  if (focus) try {
    let next = chip.nextSibling;
    if (!next || next.nodeType !== 3) { next = document.createTextNode(' '); input.insertBefore(next, chip.nextSibling); }
    const range = document.createRange();
    range.setStart(next, next.textContent.startsWith(' ') ? 1 : 0); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  } catch { /* A detached draft has no caret yet. */ }
  if (focus) input.focus();
  return chip;
}
function saveSkillDraft(storage, sessionId, input, text, session) {
  if (!isCodeAgentKind(session?.kind)) return;
  const skill = selectedSkill(input);
  if (skill) storage.setItem(DRAFT_KEY + sessionId, JSON.stringify({ skill, text }));
  else storage.removeItem(DRAFT_KEY + sessionId);
}
function readSkillDraft(storage, sessionId, session) {
  if (!isCodeAgentKind(session?.kind)) return null;
  const value = JSON.parse(storage.getItem(DRAFT_KEY + sessionId) || 'null');
  return typeof value?.text === 'string' && /^[\p{L}\p{N}_.:-]+$/u.test(value?.skill?.name || '')
    && (value.text === '/' + value.skill.name || value.text.startsWith('/' + value.skill.name + ' ')) ? value : null;
}
function loadSkillDraft(storage, sessionId, text, session) {
  const value = readSkillDraft(storage, sessionId, session);
  return value && value.text === text ? value.skill : null;
}
function clearSkillDraft(storage, sessionId) { storage.removeItem(DRAFT_KEY + sessionId); }

function slashQuery(text, caret, { composing = false, hasSkill = false } = {}) {
  if (composing || hasSkill || !text.startsWith('/') || !Number.isInteger(caret) || caret < 1) return null;
  const end = text.search(/\s/);
  if (caret > (end < 0 ? text.length : end)) return null;
  return text.slice(1, end < 0 ? undefined : end).toLowerCase();
}
function readRecentSkills(storage, session) {
  if (!storage || !isCodeAgentKind(session?.kind)) return [];
  const rows = JSON.parse(storage.getItem(RECENT_KEY + (session.codeagentPoolAccount || 'personal')) || '[]');
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter(row => {
    if (typeof row?.name !== 'string' || !Number.isFinite(row.at) || seen.has(row.name)) return false;
    seen.add(row.name); return true;
  }).sort((a, b) => b.at - a.at).slice(0, RECENT_LIMIT);
}
function recordSkillUse(storage, session, skill, result, now = Date.now()) {
  if (!storage || !isCodeAgentKind(session?.kind) || !skill?.name || !result?.ok || result.notSent || result.unconfirmed
    || ['stuck', 'content-mismatch', 'rejected'].includes(result.sendStatus)
    || ['unconfirmed', 'failed', 'content-mismatch'].includes(result.receipt?.status)) return false;
  const rows = [{ name: skill.name, at: now }, ...readRecentSkills(storage, session).filter(row => row.name !== skill.name)].slice(0, RECENT_LIMIT);
  storage.setItem(RECENT_KEY + (session.codeagentPoolAccount || 'personal'), JSON.stringify(rows));
  return true;
}
function skillChoices(skills, query, recent = []) {
  const needle = query.toLowerCase();
  const matching = skills.filter(skill => [skill.name, skill.description].some(value => String(value || '').toLowerCase().includes(needle)));
  const recentNames = recent.slice(0, RECENT_LIMIT).map(row => row.name);
  const used = recentNames.map(name => matching.find(skill => skill.name === name)).filter(Boolean);
  const rest = matching.filter(skill => !recentNames.includes(skill.name)).sort((a, b) => a.name.localeCompare(b.name));
  return [...used.map(skill => ({ type: 'skill', group: '最近使用', label: skill.name, skill })),
    ...rest.map(skill => ({ type: 'skill', group: '全部技能', label: skill.name, skill }))];
}
function isSkillsMenuCommand(session, text) { return commandPolicy.isSkillsMenuCommand(session?.kind, text); }

async function openSkillsMenu({ session, state, openTerminal, send, notify }) {
  if (!isCodeAgentKind(session?.kind)) return { ok: false };
  if (['starting', 'running', 'waiting'].includes(state)) {
    notify('请等当前回答结束后再打开技能菜单', 'warning');
    return { ok: false };
  }
  try {
    await openTerminal();
    const result = await send('/skills');
    if (result?.code === 'codeagent-input-residual') return result;
    if (!result?.ok || result.notSent || result.sendStatus === 'stuck') throw new Error(result?.message || result?.error || '技能菜单提交未确认，请在终端核对');
    notify('已在终端打开 CodeAgent 技能菜单，请在其中选择 Add from AgentCenter；装好后回到卡片视图即可', 'info');
    return result;
  } catch (error) { notify('打开技能菜单失败：' + error.message, 'error'); return { ok: false }; }
}

async function openTerminalCommand({ session, state, text, openTerminal, send, notify }) {
  if (!isCodeAgentKind(session?.kind) || !/^\s*\/\S+/.test(text)) return { ok: false };
  if (['starting', 'running', 'waiting'].includes(state)) { notify('请等当前回答结束后再执行终端命令', 'warning'); return { ok: false }; }
  try {
    await openTerminal();
    const result = await send(text);
    if (result?.code === 'codeagent-input-residual') return result;
    if (!result?.ok || result.notSent || result.sendStatus === 'stuck') throw new Error(result?.message || result?.error || '命令提交未确认，请在终端核对');
    notify('已在终端提交命令，请在 CodeAgent 中查看结果', 'info');
    return result;
  } catch (error) { notify('终端命令未发送：' + error.message, 'error'); return { ok: false }; }
}

async function openCommandList({ session, state, openTerminal, writePrefix, notify }) {
  if (!isCodeAgentKind(session?.kind)) return { ok: false };
  if (['starting', 'running', 'waiting'].includes(state)) { notify('请等当前回答结束后再打开内置命令', 'warning'); return { ok: false }; }
  try {
    await openTerminal();
    const result = await writePrefix();
    if (!result?.ok) throw new Error(result?.message || result?.error || '尚未确认输入行为空');
    notify('已在终端输入 /，请在 CodeAgent 自己的命令列表中选择', 'info');
    return result;
  } catch (error) { notify('未打开内置命令：' + error.message, 'warning'); return { ok: false }; }
}

const CSS = `
.fi-skill-picker, .fi-skill-picker * { -webkit-app-region: no-drag; }
.fi-skill-chip { display:inline-flex; align-items:center; gap:5px; padding:2px 7px; margin-right:3px; border:1px solid var(--border-subtle); border-radius:6px; background:var(--surface-raised); color:var(--fg-default); font-size:12px; white-space:nowrap; }
.fi-skill-chip[data-late] { border-color:var(--status-warning); }
.fi-skill-remove { border:0; background:none; color:var(--fg-muted); cursor:pointer; padding:0 2px; }
.fi-skill-remove::after { content:'×'; }
.fi-skill-picker { position:fixed; z-index:10020; width:min(440px,calc(100vw - 24px)); max-height:360px; display:flex; flex-direction:column; border:1px solid var(--border-subtle); border-radius:10px; background:var(--surface-raised); color:var(--fg-default); box-shadow:0 8px 28px #0003; padding:8px; font-size:12px; }
.fi-skill-picker[hidden] { display:none; }
.fi-skill-search { width:100%; box-sizing:border-box; padding:7px; color:inherit; background:var(--surface-sunken); border:1px solid var(--border-subtle); border-radius:5px; flex-shrink:0; }
.fi-skill-list { overflow-y:auto; min-height:30px; flex:1 1 auto; }
.fi-skill-option,.fi-skill-add,.fi-skill-commands { width:100%; text-align:left; background:none; color:inherit; border:0; border-radius:5px; padding:8px; cursor:pointer; }
.fi-skill-option:hover,.fi-skill-option[aria-selected=true],.fi-skill-footer button[aria-selected=true] { background:var(--surface-sunken); }
.fi-skill-option small { display:block; color:var(--fg-muted); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fi-skill-group,.fi-skill-note { padding:6px 8px; color:var(--fg-muted); }
.fi-skill-footer { display:flex; border-top:1px solid var(--border-subtle); margin-top:5px; flex-shrink:0; }
`;

function mountCodeAgentSkillPicker({ document, window, input, host, before, sessionId, getSession, ipcRenderer,
  readText, replaceText, saveDraft, openMenu, openCommands, openCommand, storage }) {
  if (!isCodeAgentKind(getSession()?.kind)) return null;
  if (!document.getElementById('fi-codeagent-skills-style')) {
    const style = document.createElement('style'); style.id = 'fi-codeagent-skills-style'; style.textContent = CSS; document.head.appendChild(style);
  }
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'composer-chip composer-skills'; button.textContent = '技能 ▾';
  button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  host.insertBefore(button, before || null);
  const popup = document.createElement('div'); popup.className = 'fi-skill-picker'; popup.hidden = true;
  const search = document.createElement('input'); search.className = 'fi-skill-search'; search.placeholder = '搜索技能'; search.setAttribute('aria-label', '搜索技能');
  const list = document.createElement('div'); list.className = 'fi-skill-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'CodeAgent 技能');
  const note = document.createElement('div'); note.className = 'fi-skill-note'; note.setAttribute('role', 'status');
  const footer = document.createElement('div'); footer.className = 'fi-skill-footer';
  const commands = document.createElement('button'); commands.type = 'button'; commands.className = 'fi-skill-commands'; commands.textContent = 'CodeAgent 内置命令';
  const add = document.createElement('button'); add.type = 'button'; add.className = 'fi-skill-add'; add.textContent = '从 AgentCenter 添加';
  footer.append(commands, add); popup.append(search, list, footer); list.appendChild(note); document.body.appendChild(popup);
  let skills = [], choices = [], index = 0, composing = false, mode = 'button', query = '', disposed = false, request = 0, opened = false, warnings = '', error = '', loading = false;
  function close() { opened = false; popup.hidden = true; button.setAttribute('aria-expanded', 'false'); request += 1; }
  function changed() { saveDraft(); input.dispatchEvent(new window.Event('input', { bubbles: true })); }
  function choose(row) {
    if (!row) return;
    if (row.type === 'commands') { close(); void openCommands(); return; }
    if (row.type === 'add' || row.type === 'terminal') {
      const previous = readText(); close();
      void (row.type === 'add' ? openMenu() : openCommand(row.text)).then(result => {
        if (result?.ok && readText() === previous && (row.type === 'terminal' || isSkillsMenuCommand(getSession(), previous))) { replaceText(''); changed(); }
      });
      return;
    }
    if (mode === 'slash') replaceText(readText().replace(/^\/\S*\s?/, ''));
    insertSkillTag(input, row.skill, { document, window, session: getSession(), onChange: changed });
    close(); changed();
  }
  function position() {
    const rect = (mode === 'button' ? button : input).getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8)) + 'px';
    popup.style.top = Math.max(8, rect.top - box.height - 6) + 'px';
  }
  function paint() {
    let recent = [];
    try { recent = readRecentSkills(storage, getSession()); } catch (reason) { error = '最近使用读取失败：' + reason.message; }
    const rows = skillChoices(skills, query, recent);
    if (mode === 'slash' && query && !rows.length && !loading && !error) rows.unshift({ type: 'terminal', group: '', label: readText().match(/^\/\S+/)?.[0] || '/' + query, text: readText() });
    choices = [...rows, { type: 'commands' }, { type: 'add' }]; index = Math.min(index, choices.length - 1);
    list.replaceChildren(note);
    note.textContent = loading ? '正在读取技能…' : error || warnings || (!skills.length ? '本机还没有安装技能' : rows.length ? '' : '没有匹配的技能');
    let group;
    rows.forEach((row, i) => {
      if (row.group && row.group !== group) { group = row.group; const label = document.createElement('div'); label.className = 'fi-skill-group'; label.textContent = group; list.appendChild(label); }
      const item = document.createElement('button'); item.type = 'button'; item.className = 'fi-skill-option'; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(i === index));
      item.textContent = row.type === 'skill' ? '/' + row.label : '在终端执行 ' + row.label;
      if (row.skill) for (const text of [row.skill.description, row.skill['argument-hint']]) if (text) { const detail = document.createElement('small'); detail.textContent = text; detail.title = text; item.appendChild(detail); }
      item.addEventListener('mousedown', event => event.preventDefault());
      item.addEventListener('click', () => choose(row)); list.appendChild(item);
      if (i === index) item.scrollIntoView?.({ block: 'nearest' });
    });
    commands.setAttribute('aria-selected', String(index === rows.length));
    add.setAttribute('aria-selected', String(index === rows.length + 1));
    position();
  }
  async function refresh() {
    const generation = ++request;
    loading = true;
    if (opened) { error = ''; note.textContent = '正在读取技能…'; }
    try {
      const result = await ipcRenderer.invoke('codeagent:skills', { sessionId });
      if (disposed || generation !== request) return;
      if (!result?.ok) throw new Error(result?.error || '读取技能失败');
      skills = result.skills || []; warnings = (result.warnings || []).join('；'); error = '';
    } catch (reason) { if (disposed || generation !== request) return; error = reason.message; skills = []; }
    loading = false; if (opened) paint();
  }
  function open(nextMode, nextQuery = '') {
    if (composing) return;
    opened = true; mode = nextMode; query = nextQuery; index = 0; search.value = query;
    popup.hidden = false; button.setAttribute('aria-expanded', 'true'); void refresh(); paint();
    if (mode === 'button') search.focus();
  }
  function caretOffset() {
    try {
      const selection = window.getSelection();
      if (!selection?.isCollapsed || !selection.rangeCount) return null;
      const caret = selection.getRangeAt(0);
      if (!input.contains(caret.startContainer)) return null;
      const range = document.createRange(); range.selectNodeContents(input); range.setEnd(caret.startContainer, caret.startOffset); return range.toString().length;
    } catch { return null; }
  }
  function onInput() {
    const next = slashQuery(readText(), caretOffset(), { composing, hasSkill: !!selectedSkill(input) });
    if (next == null) { if (mode === 'slash') close(); return; }
    if (!opened || mode !== 'slash') open('slash', next);
    else { query = next; search.value = query; index = 0; paint(); }
  }
  function onKeyDown(event) {
    if (composing || event.isComposing || event.keyCode === 229 || !opened) return false;
    if (event.key === 'Escape') close();
    else if (event.key === 'Enter' && loading && mode === 'slash') { /* Wait for the inventory before choosing a default action. */ }
    else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && mode === 'slash' && index === 0 && isSkillsMenuCommand(getSession(), readText())) choose({ type: 'add' });
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && choices.length && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      index = (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; paint();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && choices.length) choose(choices[index]);
    else return false;
    event.preventDefault(); return true;
  }
  button.addEventListener('click', event => { event.stopPropagation(); if (opened) close(); else open('button'); });
  search.addEventListener('input', () => { if (!composing) { query = search.value; index = 0; paint(); } });
  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => { composing = false; query = search.value; index = 0; paint(); });
  search.addEventListener('keydown', onKeyDown);
  footer.addEventListener('keydown', onKeyDown);
  commands.addEventListener('focus', () => { index = choices.length - 2; paint(); });
  add.addEventListener('focus', () => { index = choices.length - 1; paint(); });
  commands.addEventListener('click', () => choose({ type: 'commands' }));
  add.addEventListener('click', () => choose({ type: 'add' }));
  input.addEventListener('compositionstart', () => { composing = true; close(); });
  input.addEventListener('compositionend', () => { composing = false; onInput(); });
  input.addEventListener('input', onInput);
  input.addEventListener('keyup', event => { if (!['Escape', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) onInput(); });
  const outside = event => { if (!popup.contains(event.target) && event.target !== button && !input.contains(event.target)) close(); };
  document.addEventListener('mousedown', outside, true);
  return { button, refresh, onKeyDown, close, dispose() { disposed = true; close(); document.removeEventListener('mousedown', outside, true); popup.remove(); button.remove(); } };
}

module.exports = { selectedSkill, installationWarning, skillPrompt, insertSkillTag, removeSkillTag, saveSkillDraft, readSkillDraft, loadSkillDraft, clearSkillDraft,
  slashQuery, skillChoices, readRecentSkills, recordSkillUse, isSkillsMenuCommand, openSkillsMenu, openTerminalCommand, openCommandList, mountCodeAgentSkillPicker };

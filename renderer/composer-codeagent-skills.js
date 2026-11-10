'use strict';

const { isCodeAgentKind } = require('../core/ai-kinds');
const commandPolicy = require('../core/codeagent-command-policy');
const TAG = '[data-codeagent-skill]';
const DRAFT_KEY = 'hub.codeagent-skill-draft.v1:';
const RECENT_KEY = 'hub.codeagent-recent-skills.v1:';
const RECENT_LIMIT = 5;
const COMMAND_POLL_MS = 1000;
const COMMAND_POLL_MAX_MS = 90000;
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
  const matching = skills.filter(skill => [skill.name, ...(skill.aliases || []), skill.description].some(value => String(value || '').toLowerCase().includes(needle)));
  const recentNames = recent.slice(0, RECENT_LIMIT).map(row => row.name);
  const used = recentNames.map(name => matching.find(skill => skill.name === name)).filter(Boolean);
  const rest = matching.filter(skill => !recentNames.includes(skill.name)).sort((a, b) => a.name.localeCompare(b.name));
  return [...used.map(skill => ({ type: 'skill', group: '最近使用', label: skill.name, skill })),
    ...rest.map(skill => ({ type: 'skill', group: '全部技能', label: skill.name, skill }))];
}
function isSkillsMenuCommand(session, text) { return commandPolicy.isSkillsMenuCommand(session?.kind, text); }
function commandChoices(commands, query) {
  const needle = query.toLowerCase();
  return ['custom-command', 'command'].flatMap(kind => commands.filter(command => (command.kind || 'command') === kind
      && [command.name, ...(command.aliases || []), command.description].some(value => String(value || '').toLowerCase().includes(needle)))
    .map(command => ({ type: 'command', group: kind === 'custom-command' ? '自定义命令' : '内置命令', label: command.name, command })));
}
function mergedSkills(skills, commands) {
  const merged = new Map(commands.filter(command => command.kind === 'skill').map(command => [command.name.toLowerCase(), { ...command, installedAt: 0 }]));
  for (const skill of skills) merged.set(skill.name.toLowerCase(), { ...merged.get(skill.name.toLowerCase()), ...skill });
  return [...merged.values()];
}
function slashChoices(skills, commands, query, recent) {
  const commandRows = commandChoices(commands, query), needle = query.toLowerCase();
  const skillRows = skillChoices(mergedSkills(skills, commands), query, recent).map(row => ({ ...row, group: '技能' }));
  const rank = row => {
    const names = [row.label, ...(row.skill?.aliases || row.command?.aliases || [])].map(name => name.toLowerCase());
    return names.some(name => name.startsWith(needle)) ? 0 : names.some(name => name.includes(needle)) ? 1 : 2;
  };
  return [commandRows.filter(row => row.group === '内置命令'), skillRows, commandRows.filter(row => row.group === '自定义命令')]
    .flatMap(rows => needle ? rows.sort((a, b) => rank(a) - rank(b)) : rows);
}
function highlightName(node, text, query, document) {
  const needle = query.toLowerCase(), lower = text.toLowerCase();
  let offset = 0, match;
  while (needle && (match = lower.indexOf(needle, offset)) >= 0) {
    node.append(document.createTextNode(text.slice(offset, match)));
    const mark = document.createElement('mark'); mark.textContent = text.slice(match, match + needle.length); node.append(mark);
    offset = match + needle.length;
  }
  node.append(document.createTextNode(text.slice(offset)));
}
function commandName(text, commands) {
  const name = String(text).trimStart().match(/^\/(\S+)/)?.[1]?.toLowerCase();
  return commands.find(command => command.kind !== 'skill' && [command.name, ...(command.aliases || [])].some(value => value.toLowerCase() === name))?.name || '';
}
function commandProbeText(status, now = Date.now()) {
  if (status?.state === 'reading') return '正在读取 CodeAgent 命令…';
  if (status?.state === 'ready') return '';
  if (status?.state === 'failed') {
    const at = new Date(status.at), time = Number.isFinite(at.getTime()) ? at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const reason = String(status.reason || '未知原因').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
    const remaining = Number(status.retryAt) - now;
    return '命令列表读取失败：' + reason + (time ? '（' + time + '）' : '')
      + (remaining > 0 ? '；冷却剩余 ' + Math.ceil(remaining / 60000) + ' 分钟' : '');
  }
  return '尚未读取命令列表';
}

async function openTerminalCommand({ session, state, text, openTerminal, send, notify }) {
  if (!isCodeAgentKind(session?.kind) || !/^\s*\/\S+/.test(text)) return { ok: false };
  if (['starting', 'running', 'waiting'].includes(state)) { notify('请等当前回答结束后再执行终端命令', 'warning'); return { ok: false }; }
  try {
    await openTerminal();
    const result = await send(text);
    if (result?.code === 'codeagent-input-residual') return result;
    if (!result?.ok || result.notSent || result.sendStatus === 'stuck') throw new Error(result?.message || result?.error || '命令提交未确认，请在终端核对');
    return result;
  } catch (error) { notify('终端命令未发送：' + error.message, 'error'); return { ok: false }; }
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
.fi-skill-option,.fi-skill-add { width:100%; text-align:left; background:none; color:inherit; border:0; border-radius:5px; padding:8px; cursor:pointer; }
.fi-skill-option { display:grid;grid-template-columns:minmax(130px,40%) minmax(0,1fr);gap:10px;align-items:center;height:28px;box-sizing:border-box;padding:4px 8px; }
.fi-skill-name { min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.fi-skill-name mark { color:inherit;background:var(--surface-sunken);font-weight:700; }
.fi-skill-option:hover,.fi-skill-option[aria-selected=true],.fi-skill-footer button[aria-selected=true] { background:var(--surface-sunken); }
.fi-skill-option small { display:block; min-width:0;color:var(--fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.fi-skill-group,.fi-skill-note { padding:6px 8px; color:var(--fg-muted); }
.fi-skill-note:empty { display:none; }
.fi-skill-group { font-size:11px; }
.fi-skill-keys { padding:6px 8px;color:var(--fg-muted);font-size:11px;flex-shrink:0; }
.fi-skill-keys[hidden] { display:none; }
.fi-skill-footer { display:flex; border-top:1px solid var(--border-subtle); margin-top:5px; flex-shrink:0; }
.fi-skill-footer[hidden] { display:none; }
.fi-command-probe-status { display:block;padding:8px;color:var(--fg-muted); }
.fi-command-probe-retry { margin-left:8px;border:0;background:none;color:var(--fg-default);cursor:pointer; }
`;

function mountCodeAgentSkillPicker({ document, window, input, host, before, sessionId, getSession, ipcRenderer,
  readText, replaceText, saveDraft, openModel, storage, notify = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
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
  const commandStatus = document.createElement('small'); commandStatus.className = 'fi-command-probe-status'; commandStatus.setAttribute('role', 'status');
  const commandStatusText = document.createElement('span'); commandStatusText.className = 'fi-command-probe-text';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'fi-command-probe-retry'; retry.textContent = '重试';
  commandStatus.append(commandStatusText, retry);
  retry.addEventListener('mousedown', event => event.preventDefault());
  retry.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void refresh({ force: true }); });
  const footer = document.createElement('div'); footer.className = 'fi-skill-footer';
  const keys = document.createElement('div'); keys.className = 'fi-skill-keys'; keys.textContent = '↑↓ 选择 · Enter 确认 · Esc 关闭'; keys.hidden = true;
  let add = null;
  add = document.createElement('button'); add.type = 'button'; add.className = 'fi-skill-add'; add.textContent = '添加技能';
  footer.append(add);
  popup.append(search, list, footer, keys); list.appendChild(note); document.body.appendChild(popup);
  let skills = [], commands = [], commandsProbe = null, choices = [], index = 0, composing = false, mode = 'button', query = '', disposed = false, request = 0, opened = false, warnings = '', error = '', loading = false;
  let pollTimer = null, pollUntil = 0;
  function stopPolling() { if (pollTimer !== null) clearTimer(pollTimer); pollTimer = null; }
  function schedulePoll() {
    stopPolling();
    if (!opened || disposed || commandsProbe?.state !== 'reading' || now() >= pollUntil) return;
    pollTimer = setTimer(() => {
      pollTimer = null;
      if (opened && !disposed && commandsProbe?.state === 'reading' && now() < pollUntil) void refresh({ poll: true });
    }, Math.min(COMMAND_POLL_MS, pollUntil - now()));
  }
  function close() { stopPolling(); opened = false; popup.hidden = true; button.setAttribute('aria-expanded', 'false'); request += 1; }
  function changed() { saveDraft(); input.dispatchEvent(new window.Event('input', { bubbles: true })); }
  function choose(row) {
    if (!row) return;
    if (row.type === 'add') {
      close();
      require('./codeagent-skill-add').openSkillAdd({ document, sessionId, invoke: (...args) => ipcRenderer.invoke(...args), notify,
        onInstalled: async (name, id) => {
          const result = await refresh();
          const skill = result?.skills?.find(item => item.name === name || item.name === id.split('@')[0]);
          const warning = installationWarning(skill, getSession()); if (warning) notify(warning, 'warning');
        },
      });
      return;
    }
    if (row.type === 'command') {
      const name = row.command.name.toLowerCase();
      if (name === 'skills') { replaceText(''); changed(); open('button'); return; }
      if (name === 'model') { close(); replaceText(''); changed(); openModel(); return; }
      replaceText(readText().replace(/^\/\S*\s?/, '/' + row.command.name + ' ')); close(); changed(); input.focus(); return;
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
  function paint({ preserveSelection = false } = {}) {
    const selected = preserveSelection ? choices[index] : null;
    let recent = [];
    try { recent = readRecentSkills(storage, getSession()); } catch (reason) { error = '最近使用读取失败：' + reason.message; }
    const rows = mode === 'slash' ? slashChoices(skills, commands, query, recent) : skillChoices(skills, query, recent);
    footer.hidden = mode === 'slash' || !add;
    keys.hidden = mode !== 'slash';
    choices = [...rows, ...(mode === 'button' && add ? [{ type: 'add' }] : [])];
    if (selected) {
      const match = choices.findIndex(row => row.type === selected.type && row.label === selected.label);
      if (match >= 0) index = match;
    }
    index = Math.max(0, Math.min(index, choices.length - 1));
    list.replaceChildren();
    if (mode === 'slash' && commandsProbe?.state !== 'ready' && (commandsProbe?.state === 'reading' || commandsProbe?.state === 'failed' || !commands.some(command => command.kind !== 'skill'))) {
      commandStatusText.textContent = commandProbeText(commandsProbe, now()); retry.disabled = loading || commandsProbe?.state === 'reading';
      list.appendChild(commandStatus);
    }
    list.appendChild(note);
    note.textContent = loading ? '正在读取技能…' : error || warnings || (rows.length ? '' : !skills.length ? '本机还没有安装技能' : '没有匹配的技能');
    let group;
    rows.forEach((row, i) => {
      if (row.group && row.group !== group) { group = row.group; const label = document.createElement('div'); label.className = 'fi-skill-group'; label.textContent = group + ' ' + rows.filter(item => item.group === group).length; list.appendChild(label); }
      const item = document.createElement('button'); item.type = 'button'; item.className = 'fi-skill-option'; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(i === index));
      const data = row.skill || row.command, aliases = data.aliases || [];
      const text = '/' + row.label + (aliases.length ? ' (' + aliases.join(', ') + ')' : '');
      const title = [data.description, row.skill?.['argument-hint']].filter(Boolean).join('\n');
      item.title = title;
      const name = document.createElement('span'); name.className = 'fi-skill-name'; highlightName(name, text, query, document); item.appendChild(name);
      if (data.description) { const detail = document.createElement('small'); detail.textContent = data.description; detail.title = title; item.appendChild(detail); }
      item.addEventListener('mousedown', event => event.preventDefault());
      item.addEventListener('click', () => choose(row)); list.appendChild(item);
      if (i === index) item.scrollIntoView?.({ block: 'nearest' });
    });
    add?.setAttribute('aria-selected', String(index === rows.length));
    position();
  }
  async function refresh({ force = false, poll = false } = {}) {
    stopPolling();
    if (force) pollUntil = now() + COMMAND_POLL_MAX_MS;
    const generation = ++request;
    if (!poll) loading = true;
    if (opened && !poll) { error = ''; note.textContent = '正在读取技能…'; retry.disabled = true; }
    try {
      const result = await ipcRenderer.invoke('codeagent:skills', { sessionId, ...(!poll ? { probeCommands: true } : {}), ...(force ? { retryCommands: true } : {}) });
      if (disposed || generation !== request) return;
      if (!result?.ok) throw new Error(result?.error || '读取技能失败');
      skills = result.skills || []; commands = result.commands || []; commandsProbe = result.commandsProbe; warnings = (result.warnings || []).join('；'); error = '';
      loading = false; if (opened) paint({ preserveSelection: poll || force }); schedulePoll(); return result;
    } catch (reason) { if (disposed || generation !== request) return; error = reason.message; skills = []; }
    loading = false; if (opened) paint({ preserveSelection: poll || force }); schedulePoll();
  }
  function open(nextMode, nextQuery = '') {
    if (composing) return;
    stopPolling(); pollUntil = now() + COMMAND_POLL_MAX_MS;
    opened = true; mode = nextMode; query = nextQuery; index = 0; search.value = query; search.placeholder = mode === 'slash' ? '搜索技能与命令' : '搜索技能';
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
    else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && mode === 'slash' && index === 0 && isSkillsMenuCommand(getSession(), readText())) { replaceText(''); changed(); open('button'); }
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
  add?.addEventListener('focus', () => { index = choices.length - 1; paint(); });
  add?.addEventListener('click', () => choose({ type: 'add' }));
  input.addEventListener('compositionstart', () => { composing = true; close(); });
  input.addEventListener('compositionend', () => { composing = false; onInput(); });
  input.addEventListener('input', onInput);
  input.addEventListener('keyup', event => { if (!['Escape', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) onInput(); });
  const outside = event => { if (!popup.contains(event.target) && event.target !== button && !input.contains(event.target)) close(); };
  document.addEventListener('mousedown', outside, true);
  return { button, refresh, onKeyDown, close, open: () => open('button'), isCommand: text => commandName(text, commands), dispose() { disposed = true; close(); document.removeEventListener('mousedown', outside, true); popup.remove(); button.remove(); } };
}

module.exports = { selectedSkill, installationWarning, skillPrompt, insertSkillTag, removeSkillTag, saveSkillDraft, readSkillDraft, loadSkillDraft, clearSkillDraft,
  slashQuery, skillChoices, slashChoices, commandChoices, commandName, commandProbeText, mergedSkills, readRecentSkills, recordSkillUse, isSkillsMenuCommand, openTerminalCommand, mountCodeAgentSkillPicker };

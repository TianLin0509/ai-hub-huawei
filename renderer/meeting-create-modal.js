'use strict';

(function () {
const { ipcRenderer } = require('electron');
const { KIND_LABELS, GROUP_MEMBER_KINDS } = require('../core/ai-kinds.js');
const { MODEL_OPTIONS_BY_KIND, modelOptionsFor } = require('../core/model-options.js');

const MODEL_KINDS = new Set(Object.keys(MODEL_OPTIONS_BY_KIND).filter(require('../core/distribution').kindAllowed));
const deepseekProfile = require('../core/deepseek-claude-profile.js');
// 2026-10-22：新建入口里 DeepSeek 默认使用 DSH；旧 Codex / Claude Code
// 接入只留给历史会话恢复，ChatGPT 网页路由也不再作为新建成员出现。
const LEGACY_DEEPSEEK_KINDS = new Set(['deepseek', 'deepseek-claude']);
const HIDDEN_CREATE_KINDS = new Set(['chatgpt', 'deepseek', 'deepseek-claude']);

const DEFAULT_SLOTS = [
  { kind: 'claude' },
  { kind: 'codex' },
  { kind: 'deepseek-acp' },
];
// Claude + Codex are the durable default pair. DeepSeek is an explicit third
// member rather than a cost/latency-bearing default in every room.
const DEFAULT_GROUP_MEMBERS = DEFAULT_SLOTS.slice(0, 2).map(x => ({ ...x }));
const SLOT_NAMES = ['一号位', '二号位', '三号位'];
// 新群统一通用；可选场景只提示成员按需读文件，不改变会话启动配置。
const PROJECT_LIBRARY = require('../core/distribution').featureEnabled('projectLibrary');
const PLAIN_COPY = !require('../core/distribution').featureEnabled('launchEffort');
let _sceneHints = [];
let _sceneHintLoad = 0;

let _modalEl = null;
let _isGroupChat = true;
let _groupSlots = DEFAULT_GROUP_MEMBERS.map(x => ({ ...x }));
let _escListener = null;
let _meetingWorkspace = null;
// 群聊与单会话同一个默认档：工作根（2026-08-31 平铺决策）。
// 群聊尤其需要——180 场会议 100% 共用 cwd，本来就是「多个 AI 同一个目录」的场景。
let _meetingWorkspaceMode = 'existing';
// 项目库：已被 project-prep 整理过的项目（中文名 → 路径，按活跃时间排序）。
// 建群那一刻从主进程取快照；「选择已有路径」的下拉和开发场景的 prompt 都用它。
let _projectLibrary = [];
let _projectLibraryError = null;
let _projectLibraryLoading = null;
let _projectLibraryOpen = false;
let _creating = false;
let _presentation = { embedded: false, onCreated: null };
// AI 编排模式：成员 1 当负责人，用户预先选定工作成员，负责人安排其分工与参与阶段。
let _orchestrationOn = false;
// 负责人靠 MCP 工具指挥成员：Claude 家族用 --mcp-config，Codex 用 config 覆盖。CodeAgent 同 Claude（2026-10-14 公司版加入）。
const ORCHESTRATOR_KINDS = GROUP_MEMBER_KINDS;

function _paintWorkspace(workspace) {
  if (workspace) _meetingWorkspace = workspace;
  if (!_modalEl) return;
  const path = _modalEl.querySelector('#mcm-workspace-path');
  if (path) {
    path.textContent = _meetingWorkspaceMode === 'existing' && _meetingWorkspace
      ? `${window.WorkspaceController.workspaceTierLabel(_meetingWorkspace.tier)} · ${window.WorkspaceController.compactPath(_meetingWorkspace.path, 58)}`
      : '尚未选择';
    path.title = _meetingWorkspaceMode === 'existing' && _meetingWorkspace ? _meetingWorkspace.path : '';
  }
  const existingRow = _modalEl.querySelector('#mcm-workspace-existing');
  if (existingRow) existingRow.hidden = _meetingWorkspaceMode !== 'existing';
  if (_meetingWorkspaceMode !== 'existing') _projectLibraryOpen = false;
  _modalEl.querySelectorAll('[data-mcm-workspace-mode]').forEach(button => {
    const selected = button.getAttribute('data-mcm-workspace-mode') === _meetingWorkspaceMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
  });
  _renderProjectLibrary();
}

// ── 项目库下拉 ──────────────────────────────────────────────────────────────
// 用户的原话：「AI HUB 就应该作为一个选项，我点击就行，不需要我自己输入路径去找」。
// 数据源是主进程的 workspace:prepared-projects（core/prepared-project-library.js）。
async function _loadProjectLibrary(force = false) {
  if (!PROJECT_LIBRARY) return [];
  if (_projectLibraryLoading) return _projectLibraryLoading;
  // Refresh every open; no stale enrollment cache.
  _projectLibraryLoading = (async () => {
    try {
      const result = await ipcRenderer.invoke('workspace:prepared-projects');
      if (!Array.isArray(result?.items)) throw new Error('项目库返回格式无效');
      _projectLibrary = result.items.filter(item => item && item.path);
      _projectLibraryError = null;
    } catch (error) {
      console.warn('[meeting-create] 项目库读取失败:', error && error.message);
      _projectLibrary = [];
      _projectLibraryError = error;
    } finally {
      _projectLibraryLoading = null;
    }
    _renderProjectLibrary();
    return _projectLibrary;
  })();
  return _projectLibraryLoading;
}

function _pathKey(value) {
  return String(value || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

function _relativeActiveLabel(activeAt) {
  const at = Number(activeAt) || 0;
  if (!at) return '';
  const diff = Date.now() - at;
  if (diff < 60 * 60 * 1000) return '刚刚活跃';
  if (diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 3600000))} 小时前`;
  return `${Math.max(1, Math.round(diff / 86400000))} 天前`;
}

function _renderProjectLibrary() {
  if (!_modalEl) return;
  const listEl = _modalEl.querySelector('#mcm-project-library');
  const toggle = _modalEl.querySelector('#mcm-project-library-button');
  if (!listEl || !toggle) return;
  const open = _projectLibraryOpen && _meetingWorkspaceMode === 'existing';
  listEl.hidden = !open;
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.textContent = `项目库 ${open ? '▴' : '▾'}`;
  if (!open) return;
  if (_projectLibraryLoading && !_projectLibrary.length) {
    listEl.innerHTML = '<div class="mcm-project-library-empty">正在读取项目库…</div>';
    return;
  }
  if (_projectLibraryError) {
    listEl.textContent = `项目库读取失败：${_projectLibraryError.message}。重新打开可重试。`;
    return;
  }
  if (!_projectLibrary.length) {
    listEl.innerHTML = '<div class="mcm-project-library-empty">还没有整理过的项目。'
      + '在项目目录开一个普通会话，说「用 project-prep skill 整理这个仓库」，完成后按 docs/project-prep.md 登记正式目录。</div>';
    return;
  }
  const currentKey = _meetingWorkspace && _meetingWorkspace.path ? _pathKey(_meetingWorkspace.path) : '';
  listEl.innerHTML = _projectLibrary.map(item => {
    const selected = !!currentKey && _pathKey(item.path) === currentKey;
    const when = _relativeActiveLabel(item.activeAt);
    return `<button type="button" class="mcm-project-library-item${selected ? ' selected' : ''}" role="option"`
      + ` aria-selected="${selected ? 'true' : 'false'}" data-mcm-project-path="${_escapeHtml(item.path)}" title="${_escapeHtml(item.path)}">`
      + `<strong>${_escapeHtml(item.name || item.path)}</strong>`
      + `<small>${_escapeHtml(window.WorkspaceController.compactPath(item.path, 56))}</small>`
      + (when ? `<span>${_escapeHtml(when)}</span>` : '')
      + '</button>';
  }).join('');
  listEl.querySelectorAll('[data-mcm-project-path]').forEach(button => {
    button.addEventListener('click', () => {
      const target = _projectLibrary.find(item => item.path === button.dataset.mcmProjectPath);
      if (!target) return;
      void _selectLibraryProject(target).catch(err => _showError(`选择项目失败：${err && err.message ? err.message : String(err)}`));
    });
  });
}

async function _selectLibraryProject(item) {
  // workspace:select 让主进程把这条路径登记进工作区注册表并回 tier/label，
  // 与「选择文件夹…」走的是同一条归一化路径，后面的建群逻辑不用区分来源。
  const workspace = await ipcRenderer.invoke('workspace:select', item.path);
  if (!workspace || !workspace.path) throw new Error('主进程没有返回工作区');
  _meetingWorkspaceMode = 'existing';
  _meetingWorkspace = { ...workspace, label: workspace.label || item.name };
  _projectLibraryOpen = false;
  _clearError();
  _paintWorkspace(_meetingWorkspace);
  return _meetingWorkspace;
}

function _toggleProjectLibrary(open) {
  _projectLibraryOpen = typeof open === 'boolean' ? open : !_projectLibraryOpen;
  if (_projectLibraryOpen) void _loadProjectLibrary();
  _renderProjectLibrary();
}

async function _syncWorkspace() {
  if (_meetingWorkspaceMode === 'scratch') {
    _meetingWorkspace = await window.WorkspaceController.createScratch('未命名群聊');
  } else if (_meetingWorkspaceMode === 'default') {
    _meetingWorkspace = await window.WorkspaceController.createDefaultWorkspace('未命名群聊');
  } else if (!_meetingWorkspace || !_meetingWorkspace.path) {
    _meetingWorkspace = await window.WorkspaceController.pickWorkspace();
  }
  if (!_meetingWorkspace || !_meetingWorkspace.path) throw new Error('请选择群聊 workspace');
  _paintWorkspace(_meetingWorkspace);
  return _meetingWorkspace;
}

async function _chooseMeetingExistingWorkspace() {
  const workspace = await window.WorkspaceController.pickWorkspace();
  if (workspace && workspace.path) {
    _meetingWorkspaceMode = 'existing';
    _meetingWorkspace = workspace;
    _paintWorkspace(workspace);
  }
  return workspace;
}

function _escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _aiLogo(kind) {
  // *-resume 复用基础 kind 的 svg（assets 里没有 *-resume.svg）
  const base=String(kind).replace(/-resume$/, '');
  return `assets/ai-logos/${base.startsWith('deepseek') ? 'deepseek' : base}.svg`;
}

function _modelOptions(kind, selected) {
  const opts = modelOptionsFor(kind);
  return opts.map((option, i) =>
    `<option value="${_escapeHtml(option.id)}"${option.id === selected || (!selected && i === 0) ? ' selected' : ''}>${_escapeHtml(option.label || option.id)}</option>`
  ).join('');
}

function _selectOptions(entries, selected) {
  return (entries || []).map(([value, label]) =>
    `<option value="${_escapeHtml(value)}"${value === selected ? ' selected' : ''}>${_escapeHtml(label)}</option>`
  ).join('');
}

function _deepseekRouteFor(spec) {
  return deepseekProfile.normalizeRoute(spec && spec.deepseekRoute)
    || window.WorkspaceController.deepseekRouteState?.().route
    || deepseekProfile.DEFAULT_ROUTE;
}

function _normalizeSlotSpec(spec = {}) {
  const requestedKind = LEGACY_DEEPSEEK_KINDS.has(spec.kind) ? 'deepseek-acp' : spec.kind;
  const kind = MODEL_KINDS.has(requestedKind) && requestedKind !== 'chatgpt' ? requestedKind : 'claude';
  // 旧 DeepSeek 成员模板换到 DSH 后，旧的 Codex 模型名不能带过去。
  const sameRuntime = kind === spec.kind;
  const followDefault = sameRuntime ? (spec.followDefault ?? !spec.model) : true;
  const tuning = window.WorkspaceController.resolveSessionTuning(kind, followDefault ? undefined : spec.model,
    sameRuntime ? spec : {});
  return {
    kind,
    ...(kind === 'deepseek-claude' ? { deepseekRoute: _deepseekRouteFor(spec) } : {}),
    followDefault,
    model: tuning.model,
    effort: tuning.effort,
    mcpProfile: tuning.mcpProfile,
    fastMode: tuning.fastMode,
    codexSpeedTier: tuning.codexSpeedTier,
    contextMax: tuning.contextMax,
  };
}

function _cloneSlots(slots) {
  return (slots || require('./codeagent-preference').defaultGroupMembers(DEFAULT_GROUP_MEMBERS)).map(x => _normalizeSlotSpec(x));
}

async function _loadSceneHints() {
  const load = ++_sceneHintLoad;
  _sceneHints = [];
  const row = _modalEl.querySelector('#mcm-scene-row');
  const select = _modalEl.querySelector('#mcm-scene-hint');
  row.hidden = true;
  select.innerHTML = '<option value="">按话题自动</option>';
  try {
    const result = await ipcRenderer.invoke('session-scenes:snapshot');
    if (load !== _sceneHintLoad) return;
    _sceneHints = (result?.data?.scenes || []).filter(s => s.id !== 'coding' && s.file);
    select.innerHTML = '<option value="">按话题自动</option>' + _sceneHints.map(s =>
      `<option value="${_escapeHtml(s.id)}">${_escapeHtml(s.label)}</option>`).join('');
    row.hidden = !_sceneHints.length;
  } catch (error) {
    console.warn('[meeting-create] 场景库读取失败:', error && error.message);
  }
}

function _resetMembers() {
  _groupSlots = _cloneSlots(require('./codeagent-preference').defaultGroupMembers(DEFAULT_GROUP_MEMBERS));
  _renderSlots();
  const input = _modalEl.querySelector('#mcm-title-input');
  input.value = '';
  input.placeholder = '例如：帮我拆解这个问题，给出可执行方案';
}

function _slotHtml(i, spec, isGroup) {
  const def = _normalizeSlotSpec(spec || DEFAULT_SLOTS[i] || DEFAULT_SLOTS[0]);
  const tuning = window.WorkspaceController.resolveSessionTuning(def.kind, def.model, def);
  const providerKinds = isGroup ? GROUP_MEMBER_KINDS : Array.from(MODEL_KINDS);
  const aiOptions = providerKinds.filter(k => !HIDDEN_CREATE_KINDS.has(k)).map(k =>
    `<option value="${_escapeHtml(k)}"${k === def.kind ? ' selected' : ''}>${_escapeHtml(KIND_LABELS[k] || k)}</option>`
  ).join('');
  const avatarSrc = _aiLogo(def.kind);
  const avatarAlt = KIND_LABELS[def.kind] || def.kind;
  const orchLead = isGroup && _orchestrationOn && i === 0;
  const label = !isGroup ? `Slot ${i + 1} · ${SLOT_NAMES[i]}`
    : orchLead ? '成员 1 · 负责人'
    : _orchestrationOn ? `成员 ${i + 1} · 工作成员` : `成员 ${i + 1}`;
  const removeBtn = isGroup && i >= 1
    ? `<button type="button" class="mcm-remove-member" data-remove-member="${i}" title="移除此成员">×</button>`
    : '';
  const effortField = tuning.effortVisible ? `
      <label class="mcm-tuning-field"><span class="mcm-slot-field-name">思考强度</span>
        <select class="mcm-effort-select">${_selectOptions(tuning.effortOptions, tuning.effort)}</select>
      </label>` : '';
  const mcpField = tuning.showMcp ? `
      <label class="mcm-tuning-field"><span class="mcm-slot-field-name">MCP 加载</span>
        <select class="mcm-mcp-select">${_selectOptions(tuning.mcpOptions, tuning.mcpProfile)}</select>
      </label>` : '';
  const fastField = tuning.showFast ? `
      <label class="mcm-tuning-field mcm-fast-field">
        <span class="mcm-slot-field-name">快速模式</span>
        <span class="mcm-check"><input class="mcm-fast-checkbox" type="checkbox"${tuning.fastMode ? ' checked' : ''}> 启用 Claude Fast</span>
      </label>` : '';
  const codexTierField = tuning.showCodexTier ? `
      <label class="mcm-tuning-field"><span class="mcm-slot-field-name">速度通道</span>
        <select class="mcm-codex-tier-select">${_selectOptions(tuning.codexTierOptions, tuning.codexSpeedTier)}</select>
      </label>` : '';
  return `
    <div class="mcm-slot${isGroup ? ' mcm-group-member' : ''}${orchLead ? ' mcm-orch-lead' : ''}" data-slot="${i}" data-kind="${_escapeHtml(def.kind)}">
      ${removeBtn}
      <div class="mcm-slot-head">
        <img class="mcm-avatar" src="${_escapeHtml(avatarSrc)}" alt="${_escapeHtml(avatarAlt)}">
        <div><div class="mcm-slot-label">${_escapeHtml(label)}</div><strong>${_escapeHtml(avatarAlt)}</strong></div>
      </div>
      <div class="mcm-slot-fields">
        <label${(aiOptions.match(/<option/g) || []).length <= 1 ? ' style="display:none"' : ''}><span class="mcm-slot-field-name">AI</span><select class="mcm-ai-select">${aiOptions}</select></label>
        ${def.kind === 'deepseek-claude' ? _deepseekRouteHtml(def.deepseekRoute) : ''}
        <label><span class="mcm-slot-field-name">模型</span><select class="mcm-model-select">${_modelOptions(def.kind, def.model)}</select></label>
        ${effortField}
        ${mcpField}
        ${fastField}
        ${codexTierField}
      </div>
    </div>
  `;
}

// 「DeepSeek 接入」与新建会话面板同一套：Token Plan 套餐（默认）/ DeepSeek 官方 API，都跑 Claude Code。
// 缺 Key 的一条置灰并写原因；选中的那条缺 Key 时创建会被拦下，不静默换线。
function _deepseekRouteHtml(route) {
  const status = id => window.WorkspaceController.deepseekRouteStatus?.(id) || { available: true, reason: '' };
  const options = deepseekProfile.ROUTE_IDS.map(id => {
    const st = status(id);
    const label = deepseekProfile.ROUTES[id].label + (st.available ? (id === deepseekProfile.DEFAULT_ROUTE ? ' · 默认' : '') : ' · 不可用');
    return `<option value="${_escapeHtml(id)}"${id === route ? ' selected' : ''}${st.available ? '' : ' disabled'} title="${_escapeHtml(st.reason || '')}">${_escapeHtml(label)}</option>`;
  }).join('');
  const current = status(route);
  const note = current.available ? '' : `<small class="mcm-deepseek-route-note" role="status">${_escapeHtml(deepseekProfile.ROUTES[route].label + '不可用：' + current.reason)}</small>`;
  return `<label><span class="mcm-slot-field-name">DeepSeek 接入</span><select class="mcm-deepseek-route">${options}</select>${note}</label>`;
}

function _readSlotSpec(el, i, { strict = true } = {}) {
  const aiSelect = el && el.querySelector('.mcm-ai-select');
  const modelSelect = el && el.querySelector('.mcm-model-select');
  if (!aiSelect || !aiSelect.value) {
    if (strict) throw new Error(`成员 ${i + 1} 未选择 AI`);
    return _groupSlots[i] ? _normalizeSlotSpec(_groupSlots[i]) : null;
  }
  const spec = {
    kind: aiSelect.value,
    model: modelSelect ? modelSelect.value : '',
    ...(aiSelect.value === 'deepseek-claude'
      ? { deepseekRoute: el.querySelector('.mcm-deepseek-route')?.value || _groupSlots[i]?.deepseekRoute } : {}),
    followDefault: _groupSlots[i]?.followDefault ?? !_groupSlots[i]?.model,
  };
  const effort = el.querySelector('.mcm-effort-select');
  const mcp = el.querySelector('.mcm-mcp-select');
  const fast = el.querySelector('.mcm-fast-checkbox');
  const codexTier = el.querySelector('.mcm-codex-tier-select');
  if (effort) spec.effort = effort.value;
  if (mcp) spec.mcpProfile = mcp.value;
  if (fast) spec.fastMode = !!fast.checked;
  if (codexTier) spec.codexSpeedTier = codexTier.value;
  return _normalizeSlotSpec(spec);
}

function _syncGroupSlotsFromDom({ strict = false } = {}) {
  if (!_modalEl || !_isGroupChat) return;
  _groupSlots = Array.from(_modalEl.querySelectorAll('.mcm-slot'))
    .map((el, i) => _readSlotSpec(el, i, { strict }))
    .filter(Boolean);
}

// 「+ 添加成员」下一个默认落哪种 AI：先补齐还没出场的（Claude+Codex 两人时给 DeepSeek），
//   补齐后按顺序轮换。同一种 AI 允许多开（两个 Claude 跑不同模型/角色是有效用法），
//   成员数也不设上限——实际基本停在 3 人，但那是用户的选择，不该由代码写死。
function _nextGroupMemberKind() {
  const present = new Set(_groupSlots.map(slot => slot.kind));
  return GROUP_MEMBER_KINDS.find(kind => !present.has(kind))
    || GROUP_MEMBER_KINDS[_groupSlots.length % GROUP_MEMBER_KINDS.length];
}

function _renderSlots() {
  if (!_modalEl) return;
  const wrap = _modalEl.querySelector('.mcm-slots');
  if (!wrap) return;
  const specs = _isGroupChat ? _groupSlots : DEFAULT_SLOTS;
  wrap.innerHTML = specs.map((spec, i) => _slotHtml(i, spec, _isGroupChat)).join('');
  wrap.querySelectorAll('.mcm-slot').forEach(slotEl => {
    slotEl.querySelector('.mcm-ai-select').addEventListener('change', () => {
      const i = Number(slotEl.getAttribute('data-slot'));
      const selected = slotEl.querySelector('.mcm-ai-select').value;
      const kind = selected;
      _groupSlots[i] = _normalizeSlotSpec({ kind });
      _renderSlots();
    });
    slotEl.querySelector('.mcm-model-select').addEventListener('change', () => {
      _groupSlots[Number(slotEl.dataset.slot)].followDefault = false;
      _syncGroupSlotsFromDom();
      // Codex 的 effort / Fast 选项跟模型目录走，切模型后要重新生成这一张卡。
      _renderSlots();
    });
    slotEl.querySelector('.mcm-deepseek-route')?.addEventListener('change', event => {
      const i = Number(slotEl.getAttribute('data-slot'));
      _syncGroupSlotsFromDom();
      if (_groupSlots[i]) _groupSlots[i].deepseekRoute = event.target.value;
      void window.WorkspaceController.saveDeepseekRoute?.(event.target.value);
      _renderSlots();
    });
    slotEl.querySelectorAll('.mcm-effort-select, .mcm-mcp-select, .mcm-fast-checkbox, .mcm-codex-tier-select')
      .forEach(control => control.addEventListener('change', () => _syncGroupSlotsFromDom()));
  });
  wrap.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', () => {
      _syncGroupSlotsFromDom();
      const idx = parseInt(btn.getAttribute('data-remove-member'), 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < _groupSlots.length) {
        _groupSlots.splice(idx, 1);
        _renderSlots();
      }
    });
  });
  const addBtn = _modalEl.querySelector('#mcm-add-member');
  if (addBtn && _isGroupChat) {
    const nextKind = _nextGroupMemberKind();
    addBtn.disabled = false;
    addBtn.textContent = `+ 添加 ${KIND_LABELS[nextKind] || nextKind}`;
    addBtn.title = `添加成员 ${KIND_LABELS[nextKind] || nextKind}；同一种 AI 可以多开，人数不设上限`;
  }
}

function _ensureModal() {
  if (_modalEl && document.body.contains(_modalEl)) return _modalEl;
  _modalEl = document.createElement('div');
  _modalEl.id = 'meeting-create-modal';
  _modalEl.className = 'mcm-overlay';
  _modalEl.style.display = 'none';
  _modalEl.innerHTML = `
    <div class="mcm-dialog" role="dialog" aria-labelledby="mcm-title-text">
      <div class="mcm-header">
        <span class="mcm-title" id="mcm-title-text">新建<span id="mcm-mode-label">AI 群聊</span></span>
        <button class="mcm-close" aria-label="关闭">×</button>
      </div>
      <div class="mcm-body">
        <div class="mcm-name-row">
          <label class="mcm-name-label" for="mcm-title-input">房名（可选）</label>
          <input id="mcm-title-input" class="mcm-title-input" type="text" maxlength="40"
                 placeholder="留空则自动编号：AI 群聊 #N" autocomplete="off">
        </div>
        <div class="mcm-workspace-block">
          <span class="mcm-workspace-caption">${PLAIN_COPY ? '工作目录' : 'Workspace'}</span>
          <div class="mcm-workspace-choices" role="radiogroup" aria-label="选择群聊 workspace 方式">
            <button type="button" class="mcm-workspace-choice selected" data-mcm-workspace-mode="default" role="radio" aria-checked="true"><strong>默认工作目录</strong><small>${PLAIN_COPY ? '开在默认文件夹，各会话的文件互相可见' : '全员开在工作根，跨会话文件互相可见'}</small></button>
            <button type="button" class="mcm-workspace-choice" data-mcm-workspace-mode="scratch" role="radio" aria-checked="false"><strong>临时目录</strong><small>${PLAIN_COPY ? '新建一个空文件夹，全员共用' : '随机新建一次性目录，全员共用'}</small></button>
            <button type="button" class="mcm-workspace-choice" data-mcm-workspace-mode="existing" role="radio" aria-checked="false"><strong>选择已有路径</strong><small>${PLAIN_COPY ? '选择电脑上已有的文件夹' : '可选项目、领域或外部目录'}</small></button>
          </div>
          <div class="mcm-workspace-existing" id="mcm-workspace-existing" hidden><code id="mcm-workspace-path">尚未选择</code><button type="button" class="mcm-workspace-button" id="mcm-project-library-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="mcm-project-library" title="已整理过的项目，按最近活跃排序，点一下即选"${PROJECT_LIBRARY ? '' : ' style="display:none"'}>项目库 ▾</button><button type="button" class="mcm-workspace-button" id="mcm-workspace-button">选择文件夹…</button></div>
          <div class="mcm-project-library" id="mcm-project-library" role="listbox" aria-label="项目库" hidden></div>
        </div>
        <div class="mcm-scene" id="mcm-scene-row" hidden>
          <label class="mcm-scene-caption" for="mcm-scene-hint">场景</label>
          <select id="mcm-scene-hint" aria-label="群聊场景"><option value="">按话题自动</option></select>
        </div>
        <div class="mcm-orch-row" id="mcm-orch-row"${ORCHESTRATOR_KINDS.some(require('../core/distribution').kindAllowed) ? '' : ' style="display:none"'}>
          <label class="mcm-orch-switch"><input type="checkbox" id="mcm-orch-toggle" role="switch"><span class="mcm-orch-track" aria-hidden="true"></span><strong>负责人</strong></label>
          <span class="mcm-orch-hint" id="mcm-orch-hint">打开后成员 1 当负责人：你只和它对话，它像懂技术的领导一样拆解任务、给成员分工、审查交付并核实关键证据；具体实现交给成员。目标与停止条件直接用自然语言说明。</span>
          <div class="mcm-orch-options" id="mcm-orch-options" hidden>
            <span class="mcm-orch-note">模型由你选择；目标、分工、时间与停止条件直接在群聊中描述。成员有事可随时叫醒负责人；成员之间的交流由负责人安排。</span>
          </div>
        </div>
        <div class="mcm-member-caption">
          <strong>成员配置</strong>
          <span>${require('../core/distribution').kindAllowed('deepseek') ? '需要第三视角时再添加 DeepSeek。' : ''}可继续加人，同一种 AI 也能多开。${PLAIN_COPY ? '每位成员可以选不同的模型。' : '每位成员可独立选择模型、思考强度、速度与 MCP。'}</span>
        </div>
        <div class="mcm-slots"></div>
        <button type="button" class="mcm-add-member" id="mcm-add-member">+ 添加成员</button>
      </div>
      <div class="mcm-footer">
        <button class="mcm-cancel">取消</button>
        <button type="button" class="mcm-create mcm-primary">创建群聊</button>
      </div>
    </div>
  `;
  document.body.appendChild(_modalEl);
  _bindEvents();
  return _modalEl;
}

function _setOrchestration(on) {
  _orchestrationOn = !!on;
  if (!_modalEl) return;
  const toggle = _modalEl.querySelector('#mcm-orch-toggle');
  if (toggle) toggle.checked = _orchestrationOn;
  _modalEl.querySelector('#mcm-orch-row')?.classList.toggle('on', _orchestrationOn);
  const options = _modalEl.querySelector('#mcm-orch-options');
  if (options) options.hidden = !_orchestrationOn;
  const caption = _modalEl.querySelector('.mcm-member-caption span');
  if (caption) {
    if (!caption.dataset.plainText) caption.dataset.plainText = caption.textContent;
    caption.textContent = _orchestrationOn
      ? '成员 1 为负责人（懂项目、定方案、审查验收），其余为工作成员。任意模型均可；目标、分工和停止条件用自然语言说明。'
      : caption.dataset.plainText;
  }
  const hint = _modalEl.querySelector('#mcm-orch-hint');
  if (hint && PLAIN_COPY && !_orchestrationOn) hint.textContent = '打开后成员 1 当负责人：你只和它对话，它来拆任务、分工和审查。';
  else if (hint) hint.textContent = _orchestrationOn
    ? '已开启：成员 1 当负责人。它亲自定方案、分工、审查与核实，具体实现交给你选好的成员；成员间交流由它安排。'
    : '打开后成员 1 当负责人：你只和它对话，它像懂技术的领导一样拆解任务、给成员分工、审查交付并核实关键证据；具体实现交给成员。目标与停止条件直接用自然语言说明。';
  _renderSlots();
}

function _orchestrationPayload() {
  if (!_orchestrationOn || !_modalEl) return null;
  return { enabled: true, settings: { coordination: 'star' } };
}

function _bindEvents() {
  _modalEl.querySelector('.mcm-close').addEventListener('click', closeMeetingCreateModal);
  _modalEl.querySelector('.mcm-cancel').addEventListener('click', closeMeetingCreateModal);
  _modalEl.querySelector('.mcm-create').addEventListener('click', (event) => {
    event.preventDefault();
    void _onCreate();
  });
  _modalEl.querySelector('#mcm-add-member').addEventListener('click', () => {
    _syncGroupSlotsFromDom();
    const nextKind = _nextGroupMemberKind();
    _groupSlots.push(_normalizeSlotSpec({ kind: nextKind }));
    _renderSlots();
  });
  _modalEl.querySelectorAll('[data-mcm-workspace-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const requested = button.getAttribute('data-mcm-workspace-mode');
      _meetingWorkspaceMode = requested === 'existing' || requested === 'scratch' ? requested : 'default';
      _paintWorkspace();
      // 切到「选择已有路径」还没选过目录时，先展开项目库让用户点选；
      // 只有项目库确实是空的才回落到系统文件夹对话框（老行为）。
      if (_meetingWorkspaceMode === 'existing' && !_meetingWorkspace) {
        _toggleProjectLibrary(true);
        void _loadProjectLibrary().then(items => {
          if (_meetingWorkspaceMode !== 'existing' || _meetingWorkspace) return;
          if (!items.length) {
            _projectLibraryOpen = false;
            _renderProjectLibrary();
            return _chooseMeetingExistingWorkspace();
          }
          return undefined;
        }).catch(err => _showError(`选择目录失败：${err && err.message ? err.message : String(err)}`));
      }
    });
  });
  _modalEl.querySelector('#mcm-project-library-button').addEventListener('click', () => {
    _toggleProjectLibrary();
  });
  _modalEl.querySelector('#mcm-workspace-button').addEventListener('click', () => {
    _projectLibraryOpen = false;
    _renderProjectLibrary();
    void _chooseMeetingExistingWorkspace().catch(err => _showError(`选择目录失败：${err && err.message ? err.message : String(err)}`));
  });
  _modalEl.querySelector('#mcm-orch-toggle').addEventListener('change', event => {
    _syncGroupSlotsFromDom();
    _setOrchestration(event.target.checked);
  });
  _modalEl.addEventListener('click', (e) => {
    if (!_presentation.embedded && e.target === _modalEl) closeMeetingCreateModal();
  });
}

async function _onCreate() {
  if (_creating) return;
  const createBtn = _modalEl && _modalEl.querySelector('.mcm-create');
  if (!createBtn) return;
  _creating = true;
  createBtn.disabled = true;
  createBtn.setAttribute('aria-busy', 'true');
  createBtn.textContent = '正在准备 workspace...';
  _clearError();
  try {
    // 即使用户在模型目录异步返回前立刻点创建，也要先用真实目录重新归一化。
    // 否则 gpt-5.5 可能把 fallback 里的 max 带进 CLI（该模型真实只支持到 xhigh）。
    await window.WorkspaceController.loadSessionDefaults();
    _syncGroupSlotsFromDom({ strict: true });
    _renderSlots();
    // 读取 DOM 也必须在 try 内。历史状态或第三方样式脚本一旦留下残缺 slot / 未选
    // scene，旧代码会在 invoke 之前同步 throw，界面上就像按钮完全没反应。
    const slots = Array.from(_modalEl.querySelectorAll('.mcm-slot')).map((el, i) => {
      const spec = _readSlotSpec(el, i, { strict: true });
      if (spec.kind === 'deepseek-claude') {
        const st = window.WorkspaceController.deepseekRouteStatus?.(spec.deepseekRoute) || { available: true };
        if (!st.available) throw new Error(`成员 ${i + 1}：${deepseekProfile.ROUTES[spec.deepseekRoute].label}不可用：${st.reason}；请改选另一种接入方式`);
      }
      return {
        index: i,
        kind: spec.kind,
        ...window.WorkspaceController.buildSessionTuningOpts(spec.kind, spec.model, spec),
        ...(spec.kind === 'deepseek-claude' ? { deepseekRoute: spec.deepseekRoute } : {}),
      };
    });
    if (!slots.length) throw new Error('请至少保留一个群聊成员');
    const orchestration = _orchestrationPayload();
    if (orchestration && slots.length < 2) throw new Error('编排群至少需要负责人和一位工作成员；请先选择成员');
    const sceneHint = _modalEl.querySelector('#mcm-scene-hint').value;
    const titleInput = _modalEl.querySelector('#mcm-title-input');
    const title = titleInput ? titleInput.value.trim() : '';

    const workspace = await _syncWorkspace();
    createBtn.textContent = '正在创建成员会话...';
    const meeting = await ipcRenderer.invoke('create-meeting', {
      mode: 'general',
      scene: 'general',
      sceneHint: _sceneHints.some(s => s.id === sceneHint) ? sceneHint : '',
      slots,
      title,
      groupChat: _isGroupChat,
      groupMode: _isGroupChat ? 'deliberation' : null,
      groupRecentRawN: 5,
      participants: _isGroupChat ? (orchestration ? [slots[0].index] : slots.map((_, i) => i)) : null,
      workspace: workspace.path,
      workspaceLabel: workspace.label,
      workspaceDraft: !!workspace.draft,
      serialWorkflow: null,
      ...(orchestration ? { orchestration } : {}),
    });
    if (!meeting || !meeting.id) throw new Error('create-meeting returned empty meeting');
    const onCreated = _presentation.onCreated;
    closeMeetingCreateModal();
    if (typeof onCreated === 'function') {
      try { onCreated(meeting); } catch (error) { console.error('[meeting-create] onCreated failed', error); }
    }
    if (typeof selectMeeting === 'function') selectMeeting(meeting.id);
    else if (typeof window.selectMeeting === 'function') window.selectMeeting(meeting.id);
  } catch (e) {
    console.error('[meeting-create-modal] create failed:', e);
    _showError((e && e.message) ? e.message : String(e));
    _creating = false;
    createBtn.disabled = false;
    createBtn.removeAttribute('aria-busy');
    createBtn.textContent = '创建群聊';
  }
}

function _showError(text) {
  let bar = _modalEl.querySelector('.mcm-error');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'mcm-error';
    const footer = _modalEl.querySelector('.mcm-footer');
    if (footer) footer.before(bar);
  }
  bar.textContent = `创建失败：${text}`;
}

function _clearError() {
  const bar = _modalEl && _modalEl.querySelector('.mcm-error');
  if (bar) bar.remove();
}

function openMeetingCreateModal(mode = 'general', options = {}) {
  if (mode === 'group') {
    _isGroupChat = true;
  } else {
    _isGroupChat = true;
  }
  _ensureModal();
  const embeddedHost = options.embedded === true && options.host && typeof options.host.appendChild === 'function'
    ? options.host
    : null;
  if (embeddedHost) embeddedHost.appendChild(_modalEl);
  else if (_modalEl.parentElement !== document.body) document.body.appendChild(_modalEl);
  _modalEl.classList.toggle('mcm-embedded', !!embeddedHost);
  const dialogEl = _modalEl.querySelector('.mcm-dialog');
  if (dialogEl) {
    dialogEl.setAttribute('role', embeddedHost ? 'group' : 'dialog');
    dialogEl.setAttribute('aria-labelledby', embeddedHost ? 'launch-center-group-title' : 'mcm-title-text');
  }
  _presentation = {
    embedded: !!embeddedHost,
    onCreated: typeof options.onCreated === 'function' ? options.onCreated : null,
  };
  _clearError();
  _orchestrationOn = false;
  _setOrchestration(false);
  _resetMembers();
  void _loadSceneHints();
  _meetingWorkspaceMode = 'default';
  _meetingWorkspace = null;
  _projectLibraryOpen = false;
  _paintWorkspace();
  // 项目库每次开弹窗都重新拉：别的终端刚 commit 过的项目要排到前面来。
  void _loadProjectLibrary(true);

  const modeLabel = _modalEl.querySelector('#mcm-mode-label');
  modeLabel.textContent = 'AI 群聊';

  const titleInput = _modalEl.querySelector('#mcm-title-input');
  if (titleInput) titleInput.value = '';
  const addBtn = _modalEl.querySelector('#mcm-add-member');
  if (addBtn) addBtn.style.display = 'inline-flex';
  const createBtn = _modalEl.querySelector('.mcm-create');
  _creating = false;
  createBtn.disabled = false;
  createBtn.removeAttribute('aria-busy');
  createBtn.textContent = '创建群聊';
  _modalEl.style.display = 'flex';
  // 单会话与群聊共用 codex-cli 的模型目录。目录异步返回后保留用户已选值重绘，
  // 让 gpt-5.6 的 ultra / Fast 与旧模型的较短枚举始终准确。
  void window.WorkspaceController.loadSessionDefaults().then(() => {
    if (!_modalEl || _modalEl.style.display === 'none') return;
    _syncGroupSlotsFromDom();
    _renderSlots();
  });
  if (_escListener) document.removeEventListener('keydown', _escListener);
  _escListener = null;
  if (!_presentation.embedded) {
    _escListener = (e) => {
      if (e.key === 'Escape' && _modalEl.style.display !== 'none') closeMeetingCreateModal();
    };
    document.addEventListener('keydown', _escListener);
  }
}

function closeMeetingCreateModal() {
  if (_modalEl) _modalEl.style.display = 'none';
  if (_escListener) {
    document.removeEventListener('keydown', _escListener);
    _escListener = null;
  }
  _presentation = { embedded: false, onCreated: null };
}

window.openMeetingCreateModal = openMeetingCreateModal;
window.closeMeetingCreateModal = closeMeetingCreateModal;
})();

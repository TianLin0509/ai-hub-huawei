'use strict';
// 启动中心「负责人」下拉（来源 22dff5bd、deda1cae）：新建会话时可以挂到某位负责人名下，作为该负责人团队的成员（team:attach-member）。
// 默认「无（独立会话）」；从侧栏右键负责人「创建子会话…」进来时自动选中该负责人。选项是现有负责人，按最近活动排序（team:lead-options）。
// 选了负责人时多一个可选的「任务」输入：写了就随组队说明一起发给新会话，也写进给负责人的通知。
// 组队只支持 CodeAgent：选了负责人就自动切到 CodeAgent，其他 AI 选项置灰，下拉旁写一行说明；取消负责人后恢复，不让建好了才报错。

const NONE = '';
// 能当组队成员的启动选项：CodeAgent 和 CodeAgent-Lite（Lite 建出来的会话也是 CodeAgent）。
const TEAM_KINDS = new Set(['codeagent', 'codeagent-lite']);
const LOCK_NOTE = '组队只支持 CodeAgent';
const LOCK_TIP = '选了负责人时只能建 CodeAgent 会话（组队只支持 CodeAgent）；负责人选「无」即可恢复';

function createLaunchLeadPicker({ document, ipcRenderer, notify = () => {} }) {
  if (!document) throw new Error('lead picker requires document');
  let options = [];
  let wanted = NONE;      // 打开时要预选的负责人（右键进来的那位）
  let loadSeq = 0;
  let section = null, select = null, taskInput = null;
  const HINT_OFF = '选了负责人，新会话作为成员挂到它的团队下，并收到怎么汇报、交付的说明';

  // 放在页脚「取消 / 创建会话」左边，不增加启动中心的高度。
  function mount() {
    if (section && section.isConnected) return true;
    const footer = document.querySelector('#launch-center-session-panel .session-create-footer');
    if (!footer || !footer.lastElementChild) return false;
    section = document.createElement('div');
    section.className = 'session-lead-inline';
    section.id = 'new-session-lead-section';
    section.innerHTML = '<label for="new-session-lead">负责人</label><select id="new-session-lead" aria-describedby="new-session-lead-section"></select>'
      + '<input type="text" id="new-session-lead-task" maxlength="4000" aria-label="子会话任务（可选）" placeholder="任务（可选，随组队说明发给它）" hidden>'
      + `<span class="session-lead-note" id="new-session-lead-note" role="status" title="${LOCK_TIP}" hidden>${LOCK_NOTE}</span>`;
    footer.insertBefore(section, footer.lastElementChild);
    select = section.querySelector('#new-session-lead');
    taskInput = section.querySelector('#new-session-lead-task');
    select.addEventListener('change', () => { wanted = select.value; paint(); });
    return true;
  }

  // 「名字（N 名成员）」整句一个词条，英文界面能整句翻译。
  const label = o => (o.members ? `${o.title}（${o.members} 名成员）` : o.title);

  function paint() {
    if (!mount()) return;
    const known = options.some(o => o.sid === wanted);
    // 右键进来的负责人还没出现在清单里（刚成为负责人、清单还没刷新）：先放一个占位，选中它。
    const rows = known || wanted === NONE ? options : [{ sid: wanted, title: '所选负责人', members: 0 }].concat(options);
    select.replaceChildren(...[{ sid: NONE }].concat(rows).map(o => {
      const opt = document.createElement('option');
      opt.value = o.sid;
      opt.textContent = o.sid === NONE ? '无（独立会话）' : label(o);
      return opt;
    }));
    select.value = wanted;
    const on = select.value !== NONE;
    taskInput.hidden = !on;
    section.classList.toggle('active', on);
    // 没有任何负责人时整块不显示，普通用户看不到多余的控件。
    section.hidden = !rows.length;
    lockKinds(on);
    const chosen = rows.find(o => o.sid === select.value);
    section.title = on
      ? `新会话会作为「${chosen?.title || '负责人'}」的成员；Hub 通知负责人，并给它发组队说明（怎么汇报、交付）。不占同时干活的名额。`
      : HINT_OFF;
  }

  // 选了负责人：当前不是 CodeAgent 就切过去（点 CodeAgent 选项，走启动中心自己的切换流程），其他 AI 选项置灰；取消后恢复。
  // 只恢复自己置灰的那些（data-lead-locked），不动别的逻辑设的状态。
  function lockKinds(on) {
    const menu = document.getElementById('new-session-menu') || document;
    const buttons = [...menu.querySelectorAll('.new-session-option[data-kind]')];
    const note = section && section.querySelector('#new-session-lead-note');
    if (!on) {
      for (const b of buttons) if (b.dataset.leadLocked) { b.disabled = false; b.removeAttribute('aria-disabled'); delete b.dataset.leadLocked; if (b.dataset.leadTitle !== undefined) { b.title = b.dataset.leadTitle; delete b.dataset.leadTitle; } }
      if (note) note.hidden = true;
      return;
    }
    const selected = buttons.find(b => b.classList.contains('selected'));
    const target = buttons.find(b => b.dataset.kind === 'codeagent') || buttons.find(b => TEAM_KINDS.has(b.dataset.kind));
    const switched = !!(target && !(selected && TEAM_KINDS.has(selected.dataset.kind)));
    if (switched) target.click();
    for (const b of buttons) {
      if (TEAM_KINDS.has(b.dataset.kind) || b.dataset.leadLocked) continue;
      b.dataset.leadLocked = '1'; b.dataset.leadTitle = b.title || ''; b.title = LOCK_TIP;
      b.disabled = true; b.setAttribute('aria-disabled', 'true');
    }
    if (note) note.hidden = false;
  }

  async function refresh() {
    const seq = ++loadSeq;
    try {
      const result = await ipcRenderer.invoke('team:lead-options');
      if (seq !== loadSeq) return;
      options = result?.ok && Array.isArray(result.result) ? result.result.filter(o => o && o.sid) : [];
    } catch { if (seq === loadSeq) options = []; }
    paint();
  }

  // 每次打开启动中心调用：leadSid 来自右键「创建子会话…」，普通打开为空 → 默认独立会话。
  function reset(leadSid = NONE) {
    wanted = typeof leadSid === 'string' ? leadSid : NONE;
    if (mount()) { taskInput.value = ''; paint(); }
    return refresh();
  }

  // 点「创建会话」那一刻的选择（之后创建要等几秒，期间改下拉不影响这一次）。
  function selection() {
    if (!mount() || select.value === NONE) return null;
    return { leadSid: select.value, task: taskInput.value.trim() };
  }

  // 会话建好后调用：挂到所选负责人名下。失败不影响已建好的会话，只提示原因。
  async function attach(session, chosen = selection()) {
    if (!chosen || !session?.id) return null;
    // 起个看得懂的名字：有任务用任务，没任务用「负责人 · 子会话」。否则自动标题会拿第一条消息（组队说明）起名。
    const leadRow = options.find(o => o.sid === chosen.leadSid);
    const title = chosen.task ? chosen.task.replace(/\s+/g, ' ').slice(0, 24) : `${String(leadRow?.title || '负责人').slice(0, 14)} · 子会话`;
    try {
      const result = await ipcRenderer.invoke('team:attach-member', { leadSid: chosen.leadSid, sessionId: session.id, task: chosen.task, title });
      if (!result?.ok) throw new Error(result?.error || '挂到负责人失败');
      wanted = NONE;
      await ipcRenderer.invoke('rename-session', { sessionId: session.id, title, userRenamed: false }).catch(() => {});
      return result.result;
    } catch (error) {
      notify(`会话已建好，但没能挂到负责人下面：${error && error.message ? error.message : String(error)}`, 'error');
      return null;
    }
  }

  // 启动中心关掉时放开置灰（群聊等别的入口也用这些选项）；保留草稿重开时按当前选择再锁回去。
  const win = document.defaultView;
  win?.addEventListener?.('launch-center:closed', () => lockKinds(false));
  win?.addEventListener?.('launch-center:session-opened', () => { if (section && select && select.value !== NONE) lockKinds(true); });

  return { reset, refresh, selection, attach, mount, unlock: () => lockKinds(false) };
}

module.exports = { createLaunchLeadPicker };

'use strict';
// 底栏「用户群」弹层里的「一键入群」（r47，2026-11-18）：在 r46 的弹层上给每个没满的群加一个按钮，点了由主进程
// 经公司内网请维护人电脑上的收件机拉你入群（main/welink-join-client.js）。结果就地写在弹层底部的状态行里。
// 本机找不到 WeLink 账号时，就地出一个输入框，「保存并入群」一步完成，下次不用再填。
// 统一包与成员版都带（2026-11-28 起）；拉人的收件机只在成员版。

const STYLE = `
#welink-user-groups-panel { width:380px; }
#welink-user-groups-panel .wug-join { flex:none; height:26px; padding:0 10px; border:1px solid var(--brand, #3478f6); border-radius:6px; background:var(--brand, #3478f6); color:var(--brand-ink, #fff); font:inherit; cursor:pointer; white-space:nowrap; }
#welink-user-groups-panel .wug-join:hover:not(:disabled) { filter:brightness(1.06); }
#welink-user-groups-panel .wug-join:disabled { opacity:.6; cursor:default; }
#welink-user-groups-panel .wug-full { flex:none; color:var(--fg-muted, #66707d); font-size:11px; }
#welink-user-groups-panel .wug-status[data-level='info'] { color:var(--fg-muted, #66707d); }
#welink-user-groups-panel .wug-account { display:flex; gap:8px; align-items:center; margin-top:8px; }
#welink-user-groups-panel .wug-account[hidden] { display:none; }
#welink-user-groups-panel .wug-account input { flex:1; min-width:0; height:26px; box-sizing:border-box; padding:0 8px; border:1px solid var(--border-mid, #c9d1dc); border-radius:6px; font:inherit; color:inherit; background:var(--surface-base, #fff); }
#welink-user-groups-panel .wug-account input:focus { outline:2px solid var(--brand, #3478f6); outline-offset:0; border-color:transparent; }
`;

// 主进程结果 → 状态行显示什么、要不要露出账号输入框。
function describeResult(res) {
  if (!res || typeof res !== 'object') return { text: '入群失败：没有收到结果', level: 'error', askAccount: false };
  if (res.ok) return { text: res.message || '已加入', level: 'ok', askAccount: false };
  // 第一次没找到账号是正常引导，不当错误标红；填了格式不对才标红。
  if (res.needAccount === true) return { text: res.message || '请填一下你的 WeLink 账号', level: res.invalid ? 'error' : 'info', askAccount: true };
  return { text: res.message || '入群失败', level: 'error', askAccount: false };
}

function attachWelinkJoin({ document: doc, panel, ipcRenderer } = {}) {
  if (!doc || !panel || !ipcRenderer || panel.querySelector('[data-wug-join]')) return null;
  const status = panel.querySelector('[data-wug-status]');
  const style = doc.createElement('style');
  style.id = 'welink-join-style'; style.textContent = STYLE;
  doc.head.appendChild(style);
  const form = doc.createElement('div');
  form.className = 'wug-account'; form.hidden = true;
  form.innerHTML = '<input type="text" data-wug-account maxlength="20" autocomplete="off" spellcheck="false" placeholder="你的 WeLink 账号，如 a00123456" aria-label="WeLink 账号"><button type="button" class="wug-join" data-wug-join-save>保存并入群</button>';
  (status ? status.parentNode.insertBefore(form, status) : panel.appendChild(form));
  const input = form.querySelector('[data-wug-account]');
  let pendingGroup = '', busy = false;

  function show({ text, level }) {
    if (!status) return;
    status.textContent = text;
    if (level === 'error' || level === 'info') status.dataset.level = level; else delete status.dataset.level;
  }
  function setBusy(on) {
    busy = on;
    for (const b of panel.querySelectorAll('[data-wug-join],[data-wug-join-save]')) b.disabled = on;
  }

  async function join(group, account) {
    if (busy) return;
    pendingGroup = group;
    setBusy(true);
    show({ text: '正在请维护人电脑拉你入群，一般几秒钟…', level: 'ok' });
    let res;
    try { res = await ipcRenderer.invoke('welink-join:request', { group, ...(account ? { account } : {}) }); }
    catch (e) { res = { ok: false, message: `入群失败（${e && e.message || e}）` }; }
    setBusy(false);
    const view = describeResult(res);
    show(view);
    form.hidden = !view.askAccount;
    if (view.askAccount) input.focus();
  }

  // 只给没满的群加按钮；群表以主进程（core/welink-user-groups.js）为准。
  Promise.resolve(ipcRenderer.invoke('welink-join:state')).then(state => {
    const list = state && Array.isArray(state.groups) ? state.groups : [];
    const open = new Set(list.filter(g => !g.full).map(g => String(g.id))), full = new Set(list.filter(g => g.full).map(g => String(g.id)));
    for (const copy of panel.querySelectorAll('[data-wug-copy]')) {
      const id = copy.dataset.wugCopy;
      if (copy.parentNode.querySelector('[data-wug-join],.wug-full')) continue;
      if (full.has(id)) {
        const tag = doc.createElement('span');
        tag.className = 'wug-full'; tag.textContent = '已满'; tag.title = '这个群已满 500 人，请加入下面没满的群';
        copy.parentNode.insertBefore(tag, copy);
        continue;
      }
      if (!open.has(id)) continue;
      const btn = doc.createElement('button');
      btn.type = 'button'; btn.className = 'wug-join'; btn.dataset.wugJoin = id; btn.textContent = '一键入群';
      btn.title = '用你本机登录的 WeLink 账号直接加入这个群（由维护人电脑代为拉你入群）';
      copy.parentNode.insertBefore(btn, copy);
    }
  }).catch(() => { /* 拿不到群表就只留复制群号 */ });

  panel.addEventListener('click', event => {
    const btn = event.target.closest('[data-wug-join]');
    if (btn) { void join(btn.dataset.wugJoin, ''); return; }
    if (event.target.closest('[data-wug-join-save]')) {
      const value = input.value.trim();
      if (!value) { show({ text: '请先填你的 WeLink 账号', level: 'error' }); input.focus(); return; }
      void join(pendingGroup, value);
    }
  });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); form.querySelector('[data-wug-join-save]').click(); } });
  return { join, form };
}

module.exports = { attachWelinkJoin, describeResult };

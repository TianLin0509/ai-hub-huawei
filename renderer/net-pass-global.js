'use strict';
// 主界面底栏右侧的「一键放行」（2026-11-12 用户：统一的放行入口放在主界面角落，一次放行全局共享）。
// 后台本来就会自动放行，这里是兜底：自动没成功、或想马上确认时用。
const CSS = `
#net-pass-global { display:inline-flex; align-items:center; gap:6px; flex:none; order:3; height:24px; padding:0 10px; border-radius:12px;
  border:1px solid var(--border-subtle, #d9d7e2); background:transparent; color:var(--fg-default, inherit); font:12px var(--font-sans, inherit); cursor:pointer; }
#net-pass-global:hover { background:var(--surface-hover, #f1f0f5); }
#net-pass-global:disabled { opacity:.6; cursor:default; }
#net-pass-global .npg-dot { width:8px; height:8px; border-radius:50%; background:#9aa0ab; }
#net-pass-global[data-state="ok"] .npg-dot { background:#2f8f4e; }
#net-pass-global[data-state="blocked"] { border-color:rgba(194, 91, 18, .5); color:#c25b12; }
#net-pass-global[data-state="blocked"] .npg-dot { background:#c25b12; }
#net-pass-global[data-state="running"] .npg-dot { background:#3478f6; }
`;

function view(status, running) {
  if (running) return { state: 'running', text: '正在放行…', title: '正在把下载服务器、通道服务器和团队站点逐个放行' };
  if (!status || !status.available) return null;
  const blocked = Array.isArray(status.blocked) ? status.blocked : [];
  if (blocked.length) return { state: 'blocked', text: '需要放行', title: `被公司网络拦着：${blocked.join('、')}。点一下全部放行（后台也会自动重试）` };
  const unknown = (status.hosts || []).some(h => h.state === 'unknown' || h.state === 'checking');
  return { state: unknown ? 'unknown' : 'ok', text: '一键放行', title: '网络放行正常。公司网络拦截时后台会自动放行；也可以点这里把所有服务器重新放行一遍' };
}

function summary(result) {
  if (!result || !Array.isArray(result.steps)) return '放行没有完成，请稍后再试';
  const bad = result.steps.filter(s => !s.ok);
  return bad.length ? `还有 ${bad.length} 处没放行：${bad.map(s => s.name + '（' + s.note + '）').join('、')}` : `已全部放行（${result.steps.length} 处）`;
}

function mount({ doc = document, ipcRenderer, toast = () => {} } = {}) {
  let button = null, status = null, running = false;
  const render = () => {
    if (!button) return;
    const v = view(status, running);
    button.hidden = !v;
    if (!v) return;
    button.dataset.state = v.state; button.title = v.title; button.disabled = running;
    button.querySelector('.npg-text').textContent = v.text;
  };
  const refresh = async () => { try { status = await ipcRenderer.invoke('net-pass:global-status'); } catch (_) { status = null; } render(); };
  const attach = () => {
    const footer = doc.getElementById('hub-system-footer');
    if (!footer || doc.getElementById('net-pass-global')) return !!footer;
    const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style);
    button = doc.createElement('button');
    button.type = 'button'; button.id = 'net-pass-global'; button.hidden = true;
    button.innerHTML = '<span class="npg-dot" aria-hidden="true"></span><span class="npg-text">一键放行</span>';
    button.addEventListener('click', async () => {
      if (running) return;
      running = true; render();
      let result = null;
      try { result = await ipcRenderer.invoke('net-pass:global'); } catch (_) {}
      running = false; status = result && result.status ? result.status : status; render();
      toast(summary(result));
    });
    footer.appendChild(button);
    return true;
  };
  if (!attach()) {
    const timer = setInterval(() => { if (attach()) { clearInterval(timer); void refresh(); } }, 1000);
  } else void refresh();
  ipcRenderer.on('net-pass:state', () => { void refresh(); });
  setInterval(() => { void refresh(); }, 60000);
  return { refresh, view: () => view(status, running) };
}

module.exports = { mount, view, summary };

'use strict';
// AI 网页会话（2026-10-25 用户）：ChatGPT / Gemini / DeepSeek 等官网直接内嵌在 Hub 主区。
// 每个「网站 + 身份」一份持久存储，在 Hub 里登录一次后一直记住；同一网站可开多个会话，共用这份登录。
// 网页是远程内容：沙箱、无 preload、拿不到任何 Hub IPC。状态只靠主进程定时读页面上可见的按钮与标题。
// 实测（2026-10-25）：账号页 Chrome 的 Cookie 复制进来不可用（ChatGPT 被 Cloudflare 卡住、Gemini 登录失效），
// 所以这里不导入任何外部登录，只用用户在 Hub 里亲自登录的结果。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// honest：不冒充 Chrome，如实报 Electron。用 Google 账号登录的网站要这样：Google 发现「自称 Chrome、内核特征却对不上」会拒绝登录
// （「此浏览器或应用可能不安全」）。2026-10-26 实测：只改身份字符串冒充 Chrome 6 次全被拒；用户在登录实验台亲手走
// ChatGPT →「继续使用 Google 登录」，原样 Electron 通过。豆包等国内站仍需伪装（10-25「环境较差」），保持不变。
const SITES = Object.freeze({
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', logo: 'codex', account: 'Codex 账号', honest: true },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app', logo: 'gemini', account: 'Antigravity 账号', honest: true },
  deepseek: { name: 'DeepSeek', url: 'https://chat.deepseek.com/', logo: 'deepseek' },
  kimi: { name: 'Kimi', url: 'https://www.kimi.com/', logo: 'kimi' },
  qwen: { name: '千问', url: 'https://www.qianwen.com/', logo: 'qwen' },
  doubao: { name: '豆包', url: 'https://www.doubao.com/chat/', logo: '' },
  glm: { name: '智谱清言', url: 'https://chatglm.cn/', logo: 'glm' },
  minimax: { name: 'MiniMax', url: 'https://agent.minimaxi.com/', logo: 'minimax' },
});
// 分流表之外、本模块新增的两家国内站。
// MiniMax 国内版页面还会从 minimax.cn、hailuoai.* 取资源（2026-10-25 实测）。
const EXTRA_DIRECT = Object.freeze(['chatglm.cn', 'zhipuai.cn', 'bigmodel.cn', 'minimaxi.com', 'minimax.chat', 'minimax.cn', 'hailuoai.com', 'hailuoai.video']);
const IDENTITIES = Object.freeze({ main: '主', alt: '副' });
// 与普通会话一致（main/session-auto-suspend.js 的 AUTO_SUSPEND_IDLE_MS）。
const IDLE_MS = 5 * 60 * 60 * 1000;
const POLL_MS = 2000;
// 登录常用弹窗（OAuth）留在 Hub 里完成；其余新窗口交给系统浏览器。
const AUTH_HOST = /(^|\.)(accounts\.google\.com|auth\.openai\.com|auth0\.openai\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com|open\.weixin\.qq\.com|graph\.qq\.com|passport\.[\w.-]+|login\.[\w.-]+|auth\.[\w.-]+)$/i;

// 页面里可见的「停止生成」按钮 = 正在回答。各家写法不同，用文字、aria-label、data-testid 一起认。
// 只看元素有没有排版位置，不逐个算样式：每 2 秒跑一次，按钮多的页面上逐个算样式会拖慢网页。
const PROBE = `(()=>{const vis=e=>!!e&&e.getClientRects().length>0;
 const stop=[...document.querySelectorAll('button,[role="button"]')].some(b=>{if(!vis(b))return false;
  const t=[b.getAttribute('aria-label'),b.getAttribute('data-testid'),b.getAttribute('title'),(b.innerText||'').slice(0,40)].join(' ');
  return /(^|\\b|[\\s-])(stop|停止|中止|终止)/i.test(t)&&!/stop sharing|停止共享|语音|voice|录音|朗读|read aloud/i.test(t);});
 return {generating:stop,title:document.title||'',url:location.href};})()`;

// 端到端测试用本地夹具页代替真实官网；只在隔离数据目录（CLAUDE_HUB_DATA_DIR）下生效，生产实例永远打开官网。
function siteUrl(key, env = process.env) {
  return env.CLAUDE_HUB_DATA_DIR && /^http:\/\/127\.0\.0\.1:\d+\//.test(env.HUB_WEB_SESSIONS_FIXTURE_URL || '') ? env.HUB_WEB_SESSIONS_FIXTURE_URL + '?site=' + key : SITES[key].url;
}

const SLOGAN = /^(Chat, Work, Create|阿里\s*AI\s*助手|字节跳动旗下|探索未至之境|Meet Gemini|Google Gemini|Kimi\s*-\s*会推理|智谱清言\s*-|MiniMax Agent)|AI\s*(智能)?助手$/i;

const LOGIN_PATH = /(^|\/)(sign_?in|log_?in|auth)(\/|$|\?)/i;

function cleanTitle(raw, site) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  const names = [site.name, 'ChatGPT', 'Google Gemini', 'Gemini', 'DeepSeek', 'Kimi', '千问', '通义千问', '豆包', '智谱清言', 'MiniMax', 'MiniMax Agent'];
  for (const n of names) {
    const e = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s*[-|·—–:]\\s*${e}.*$`, 'i'), '').replace(new RegExp(`^${e}\\s*[-|·—–:]\\s*`, 'i'), '');
  }
  if (!t || names.some(n => n.toLowerCase() === t.toLowerCase()) || /^(new chat|新对话|新聊天|新建对话)$/i.test(t)) return '';
  // 各家首页的宣传语不是对话标题（2026-10-25 真实页面：千问「阿里 AI 助手」、豆包「字节跳动旗下 AI 智能助手」等）。
  if (SLOGAN.test(t)) return '';
  return t.slice(0, 80);
}

// 让内嵌网页在网站眼里和同版本的 Chrome 一致：品牌里补上 Google Chrome、带上完整的客户端提示与常见的 window.chrome 字段、
// 语言列表与 Chrome 默认相同。Electron 默认缺这些，豆包等站的风控会据此提示「环境异常」（2026-10-25 用户反馈）。
// 只改网站看到的浏览器描述，不改内核行为；版本号保持真实内核版本，不冒充更新的 Chrome。
const CHROME_SHIM = `(()=>{try{const c=window.chrome||(window.chrome={});const t=performance.timing;
 if(!c.app)c.app={isInstalled:false,InstallState:{DISABLED:'disabled',INSTALLED:'installed',NOT_INSTALLED:'not_installed'},RunningState:{CANNOT_RUN:'cannot_run',READY_TO_RUN:'ready_to_run',RUNNING:'running'},getDetails(){return null},getIsInstalled(){return false},runningState(){return 'cannot_run'}};
 if(!c.csi)c.csi=function(){return{onloadT:t.domContentLoadedEventEnd,startE:t.navigationStart,pageT:Date.now()-t.navigationStart,tran:15}};
 if(!c.loadTimes)c.loadTimes=function(){const n=t.navigationStart/1000;return{requestTime:n,startLoadTime:n,commitLoadTime:t.responseStart/1000,finishDocumentLoadTime:t.domContentLoadedEventEnd/1000,finishLoadTime:t.loadEventEnd/1000,firstPaintTime:t.responseEnd/1000,firstPaintAfterLoadTime:0,navigationType:'Other',wasFetchedViaSpdy:true,wasNpnNegotiated:true,npnNegotiatedProtocol:'h2',wasAlternateProtocolAvailable:false,connectionInfo:'h2'}};
}catch(e){}})()`;
function userAgentOverride(userAgent, chromeVersion) {
  const full = String(chromeVersion || '').trim() || (/Chrome\/([\d.]+)/.exec(userAgent) || [])[1] || '0.0.0.0';
  const major = full.split('.')[0];
  const brands = [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not-A.Brand', version: '24' }];
  return {
    userAgent, acceptLanguage: 'zh-CN,zh,en', platform: 'Win32',
    userAgentMetadata: { brands, fullVersionList: brands.map(b => ({ brand: b.brand, version: b.brand === 'Not-A.Brand' ? '24.0.0.0' : full })), fullVersion: full,
      platform: 'Windows', platformVersion: '19.0.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false },
  };
}

function browserUserAgent(fallback) {
  // 去掉 Electron 和应用名，保留与内核版本一致的 Chrome 标识（不冒充别的版本，避免客户端提示不一致）。
  return String(fallback || '').replace(/\s(Electron|[\w-]+)\/[\w.]+(?=\s|$)/g, m => /Chrome|Safari|AppleWebKit|Mozilla/.test(m) ? m : '');
}

function createWebSessions({ dataDir, getWindow, WebContentsView, BrowserWindow, session, shell, Menu, clipboard, app, getProxy = () => '', onChanged = () => {}, now = Date.now, logger = console }) {
  const file = path.join(dataDir, 'web-sessions.json');
  let items = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(saved?.items)) items = saved.items.filter(i => i && typeof i.id === 'string' && SITES[i.site] && IDENTITIES[i.identity]);
    // 旧版本存下的首页宣传语标题（如「阿里 AI 助手」）清掉，侧栏改显示网站名，等真正的对话标题出现。
    for (const i of items) if (i.title && !cleanTitle(i.title, SITES[i.site])) i.title = '';
    // 停在登录页的旧记录：下次直接打开网站首页（登录页地址里常带一次性参数）。
    for (const i of items) { try { if (LOGIN_PATH.test(new URL(i.url).pathname)) i.url = siteUrl(i.site); } catch { i.url = siteUrl(i.site); } }
  } catch (e) { if (e.code !== 'ENOENT') logger.warn('[web-sessions] 记录无法读取，按空列表启动：', e.message); }
  const live = new Map(); // id → { view, phase, error, generating, stopStreak, runStreak }
  // 登录存储同时只能由一个 Hub 进程打开（2026-10-25 实测：第二个进程读不到、也存不下 Cookie，表现为每开一个 Hub 都要重新登录）。
  // 第一个真正打开网页的 Hub 成为持有者，写下自己的 PID；其他 Hub 窗口只列出网页会话，打开时提示到持有者窗口操作。
  const ownerFile = path.join(dataDir, 'web-sessions-owner.json');
  let owned = false;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  function currentOwner() {
    try {
      const o = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      if (Number.isInteger(o?.pid) && o.pid !== process.pid && alive(o.pid) && fs.existsSync(path.join(dataDir, 'control', o.pid + '.json'))) return o;
    } catch {}
    return null;
  }
  function acquireOwner() {
    if (owned) return true;
    if (currentOwner()) return false;
    const tmp = ownerFile + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: now() }), 'utf8');
      fs.renameSync(tmp, ownerFile);
    } catch (e) { try { fs.unlinkSync(tmp); } catch {} logger.warn('[web-sessions] 持有者记录写入失败：', e.message); }
    owned = true;
    return true;
  }
  function assertOwner() {
    if (acquireOwner()) return;
    const o = currentOwner();
    throw Object.assign(new Error(`网页会话正在另一个 Hub 窗口（PID ${o?.pid || '未知'}）里使用。浏览器的登录信息同一时间只能由一个窗口读写，在这里打开会要求重新登录、也存不下；请到那个窗口打开，或关掉那个窗口后再在这里用。`), { code: 'WEB_OWNER' });
  }
  function reloadItems() {
    if (owned) return;
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(saved?.items)) items = saved.items.filter(i => i && typeof i.id === 'string' && SITES[i.site] && IDENTITIES[i.identity]); } catch {}
  }
  const configured = new Set();
  // 网页圆桌正在替用户提问的网页（main/web-page-agent.js）：回答完成不弹桌面通知、不标未读，也不因闲置被休眠。
  const automated = new Set();
  let shownId = null, attachedTo = null, visible = true, lastBounds = null, timer = null, emitTimer = null, disposed = false;

  function persist() {
    if (!owned) return;
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) { try { fs.unlinkSync(tmp); } catch {} logger.warn('[web-sessions] 保存失败：', e.message); }
  }
  const find = id => items.find(i => i.id === id);
  function publicItem(item) {
    const l = live.get(item.id), site = SITES[item.site];
    const status = !l ? 'dormant' : l.phase === 'error' ? 'error' : l.generating ? 'running' : l.phase === 'loading' ? 'loading' : 'ready';
    return { ...item, siteName: site.name, logo: site.logo, identityLabel: IDENTITIES[item.identity],
      displayTitle: item.customTitle || item.title || site.name, status, error: l?.error || '' };
  }
  function state(extra = {}) {
    const other = owned ? null : currentOwner();
    return { ok: true, owner: { self: owned, otherPid: other?.pid || null }, items: items.map(publicItem), shownId, sites: Object.entries(SITES).map(([key, s]) => ({ key, ...s })), identities: IDENTITIES, ...extra };
  }
  function emit(extra) {
    if (extra) { onChanged(state(extra)); return; }
    clearTimeout(emitTimer);
    emitTimer = setTimeout(() => onChanged(state()), 50);
  }

  function partitionFor(item) { return `persist:aiweb-${item.site}-${item.identity}`; }
  function configure(partition, site = {}) {
    if (configured.has(partition)) return session.fromPartition(partition);
    const ses = session.fromPartition(partition);
    // 与账号页专属 Chrome 同一套分流（core/hub-browser-routing.js）：国外站走 Hub 代理，国内 AI 站直连；没配代理就跟随系统。
    let plan = null;
    try { plan = getProxy(); } catch (e) { logger.warn('[web-sessions] Hub 代理无效，改跟随系统网络：', e.message); }
    if (plan?.proxy) {
      const bypass = [plan.bypass, ...EXTRA_DIRECT.flatMap(d => [d, '*.' + d])].join(';');
      void ses.setProxy({ proxyRules: plan.proxy, proxyBypassRules: bypass }).catch(e => logger.warn('[web-sessions] 代理设置失败：', e.message));
    }
    if (!site.honest) ses.setUserAgent(browserUserAgent(app?.userAgentFallback || ses.getUserAgent()));
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media', 'pointerLock']);
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    configured.add(partition);
    return ses;
  }

  function contextMenu(wc, params) {
    if (!Menu) return;
    const t = [];
    if (params.linkURL) t.push({ label: '在浏览器中打开链接', click: () => void shell.openExternal(params.linkURL) }, { label: '复制链接', click: () => clipboard?.writeText(params.linkURL) }, { type: 'separator' });
    if (params.isEditable) t.push({ label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' });
    else if (params.selectionText) t.push({ label: '复制', role: 'copy' });
    if (params.mediaType === 'image' && params.srcURL) t.push({ label: '复制图片', click: () => wc.copyImageAt(params.x, params.y) }, { label: '图片另存为…', click: () => wc.downloadURL(params.srcURL) });
    if (t.length && t[t.length - 1].type !== 'separator') t.push({ type: 'separator' });
    t.push({ label: '后退', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: '刷新', click: () => wc.reload() });
    Menu.buildFromTemplate(t).popup({ window: getWindow() || undefined });
  }

  function wake(item) {
    let l = live.get(item.id);
    if (l && !l.view.webContents.isDestroyed()) return l;
    assertOwner();
    const partition = partitionFor(item);
    const site = SITES[item.site];
    const ses = configure(partition, site);
    // backgroundThrottling 关掉：网页圆桌会让没在显示的网页在后台答题，默认的后台节流会拖慢它的计时器和渲染。
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false } });
    // 网站第一帧画出来之前显示白底，不露出窗口底下的黑色。
    view.setBackgroundColor('#ffffff');
    l = { view, phase: 'loading', error: '', generating: false, stopStreak: 0, runStreak: 0 };
    live.set(item.id, l);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url, features }) => {
      let host = '';
      try { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol)) return { action: 'deny' }; host = u.hostname; } catch { return { action: 'deny' }; }
      if (AUTH_HOST.test(host) || /width=|height=|popup/i.test(features || '')) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, title: '登录', webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } } };
      }
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, params) => contextMenu(wc, params));
    wc.on('did-create-window', win => { if (!site.honest) void applyBrowserProfile(win.webContents, { blank: false }); });
    wc.on('did-start-loading', () => { l.phase = 'loading'; l.error = ''; emit(); });
    wc.on('did-stop-loading', () => { if (l.phase !== 'error') l.phase = 'ready'; emit(); });
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { l.phase = 'error'; l.error = `网页未能打开：${description}（可点刷新重试）`; emit(); }
    });
    wc.on('render-process-gone', () => { l.phase = 'error'; l.error = '网页进程已停止，点刷新即可恢复'; l.generating = false; emit(); });
    wc.on('page-title-updated', (_e, title) => {
      const t = cleanTitle(title, SITES[item.site]);
      if (t && t !== item.title) { item.title = t; persist(); emit(); }
    });
    wc.on('did-navigate', (_e, url) => remember(item, url));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) remember(item, url); });
    const load = () => wc.loadURL(item.url || siteUrl(item.site)).catch(e => { if (e.code !== 'ERR_ABORTED') { l.phase = 'error'; l.error = `网页未能打开：${e.message}`; emit(); } });
    if (site.honest) void load();
    else void applyBrowserProfile(wc).finally(() => { if (!wc.isDestroyed()) void load(); });
    return l;
  }
  // 调试协议的命令要等页面里有文档才回复：新开的网页先载入空白页，再设置，最后打开网站（2026-10-25 实测，不先载入会一直等）。
  async function applyBrowserProfile(wc, { blank = true } = {}) {
    const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 超时')), 4000))]);
    try {
      if (blank && !wc.getURL()) await within(wc.loadURL('about:blank'), '空白页');
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await within(wc.debugger.sendCommand('Emulation.setUserAgentOverride', userAgentOverride(wc.getUserAgent(), process.versions.chrome)), '浏览器描述');
      await within(wc.debugger.sendCommand('Page.enable'), '页面事件');
      await within(wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_SHIM }), '页面补齐');
    } catch (e) { logger.warn('[web-sessions] 浏览器描述未能完整设置，按默认打开：', e.message); }
  }
  function remember(item, url) {
    try { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol)) return; if (LOGIN_PATH.test(u.pathname)) return; } catch { return; }
    if (item.url !== url) { item.url = url; persist(); }
  }

  // 醒着的网页一直挂在窗口上，切换时只改显隐：反复摘下再挂上会让网页重新合成，切换时会闪一下黑屏。
  function attach(id) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (attachedTo && attachedTo !== win && !attachedTo.isDestroyed()) for (const l of live.values()) attachedTo.contentView.removeChildView(l.view);
    attachedTo = win;
    for (const [otherId, l] of live) {
      if (!win.contentView.children.includes(l.view)) win.contentView.addChildView(l.view);
      l.view.setVisible(otherId === id && visible);
    }
    applyBounds();
  }
  function detachAll() {
    for (const l of live.values()) l.view.setVisible(false);
  }
  function applyBounds() {
    const l = shownId && live.get(shownId);
    const win = getWindow();
    if (!l || !lastBounds || !win || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    const zoom = win.webContents.getZoomFactor();
    const v = lastBounds;
    const x = Math.min(width, Math.max(0, Math.round(v.x * zoom))), y = Math.min(height, Math.max(0, Math.round(v.y * zoom)));
    l.view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(v.width * zoom))), height: Math.max(0, Math.min(height - y, Math.round(v.height * zoom))) });
  }
  const validRect = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.width >= 1 && r.height >= 1;

  function create({ site, identity = 'main' } = {}) {
    if (!SITES[site]) throw new Error('不支持这个网站');
    assertOwner();
    if (!IDENTITIES[identity]) throw new Error('未知的身份');
    const t = now();
    const item = { id: 'web-' + crypto.randomUUID().slice(0, 12), site, identity, title: '', customTitle: '', url: siteUrl(site), createdAt: t, lastActiveAt: t, lastCompletedAt: 0, unread: false };
    items.unshift(item);
    persist();
    emit();
    return publicItem(item);
  }
  function show({ id, bounds } = {}) {
    const item = find(id);
    if (!item) throw new Error('这个网页会话已不存在');
    if (bounds !== undefined && !validRect(bounds)) throw new Error('网页区域尚未准备好，请重新打开');
    if (bounds) lastBounds = bounds;
    wake(item);
    shownId = id; visible = true;
    item.lastActiveAt = now();
    if (item.unread) { item.unread = false; persist(); }
    attach(id);
    live.get(id).view.webContents.focus();
    ensureTimer();
    emit();
    return state();
  }
  function setBounds(bounds) { if (validRect(bounds)) { lastBounds = bounds; applyBounds(); } return { ok: true }; }
  function setVisible(value) {
    visible = !!value;
    if (shownId) attach(shownId);
    return { ok: true, visible };
  }
  function hide() { detachAll(); shownId = null; emit(); return state(); }
  function suspend(id, reason = 'manual') {
    const l = live.get(id);
    if (!l) return state();
    if (attachedTo && !attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(l.view);
    if (!l.view.webContents.isDestroyed()) l.view.webContents.close({ waitForBeforeUnload: false });
    live.delete(id);
    if (shownId === id) shownId = null;
    logger.log?.(`[web-sessions] ${reason === 'idle' ? '自动' : '手动'}休眠 ${id}`);
    emit();
    return state();
  }
  function close(id) {
    assertOwner();
    suspend(id, 'close');
    items = items.filter(i => i.id !== id);
    persist();
    emit();
    return state();
  }
  function rename(id, title) {
    assertOwner();
    const item = find(id);
    if (!item) throw new Error('这个网页会话已不存在');
    item.customTitle = String(title || '').trim().slice(0, 80);
    persist(); emit();
    return state();
  }
  function navigate(id, action) {
    const item = find(id), l = live.get(id);
    if (!item) throw new Error('这个网页会话已不存在');
    if (action === 'external') { void shell.openExternal(item.url || siteUrl(item.site)); return state(); }
    if (!l) return state();
    const wc = l.view.webContents;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') { l.phase = 'loading'; l.error = ''; if (!wc.getURL()) void wc.loadURL(item.url || siteUrl(item.site)).catch(() => {}); else wc.reload(); }
    else if (action === 'home') void wc.loadURL(siteUrl(item.site)).catch(() => {});
    emit();
    return state();
  }
  // 网页圆桌用：在后台唤醒网页（不切到前台），挂在窗口上但隐藏，等网页加载完再交给自动提问脚本。
  // fresh=先回到网站首页开新对话；url=回到指定的对话（命令行 AI 接着同一对话追问）。网页已经在显示时位置不动。
  async function pageFor(id, { fresh = false, url = '' } = {}) {
    const item = find(id);
    if (!item) throw new Error('这个网页会话已不存在');
    const l = wake(item);
    mount(id, l);
    ensureTimer();
    item.lastActiveAt = now();
    emit();
    const wc = l.view.webContents;
    await settle(l, wc);
    const target = fresh ? siteUrl(item.site) : url && sameOrigin(url, item.site) && url !== wc.getURL() ? url : '';
    if (target) {
      await wc.loadURL(target).catch(e => { if (e.code !== 'ERR_ABORTED') throw new Error('网页未能打开：' + e.message); });
      await settle(l, wc);
    }
    return { wc, item };
  }
  async function settle(l, wc) {
    const t0 = Date.now();
    for (;;) {
      if (wc.isDestroyed()) throw new Error('网页已关闭');
      if (l.phase === 'error') throw new Error(l.error || '网页未能打开');
      const url = wc.getURL();
      if (url && url !== 'about:blank' && !wc.isLoading()) return;
      if (Date.now() - t0 > 60000) throw new Error('网页 60 秒内没有打开完成，请打开原网页查看网络或登录');
      await new Promise(r => setTimeout(r, 300));
    }
  }
  function mount(id, l) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (attachedTo && attachedTo !== win && !attachedTo.isDestroyed()) for (const other of live.values()) attachedTo.contentView.removeChildView(other.view);
    attachedTo = win;
    if (!win.contentView.children.includes(l.view)) win.contentView.addChildView(l.view);
    if (id === shownId) return;
    // 隐藏的网页也要有正常大小，网站才会按电脑宽度排版（lite 脚本只认看得见位置的按钮和输入框）。
    const [width, height] = win.getContentSize();
    l.view.setVisible(false);
    l.view.setBounds({ x: 0, y: 0, width: Math.max(1024, width), height: Math.max(700, height) });
  }
  function sameOrigin(url, site) { try { return new URL(url).origin === new URL(siteUrl(site)).origin; } catch { return false; } }
  function setAutomation(id, on) { if (on) automated.add(id); else automated.delete(id); }
  function markRead(id) { const item = find(id); if (item?.unread) { item.unread = false; persist(); emit(); } return state(); }

  async function poll() {
    const t = now();
    const win = getWindow();
    const focused = !!win && !win.isDestroyed() && win.isFocused();
    for (const [id, l] of [...live]) {
      const item = find(id);
      if (!item) { suspend(id, 'close'); continue; }
      const wc = l.view.webContents;
      if (wc.isDestroyed()) { live.delete(id); emit(); continue; }
      let probe = null;
      if (l.phase !== 'error') probe = await wc.executeJavaScript(PROBE, false).catch(() => null);
      if (probe) {
        // 连续两次看到才算开始、连续两次看不到才算结束：页面切换时按钮会闪一下。
        if (probe.generating) { l.runStreak++; l.stopStreak = 0; } else { l.stopStreak++; l.runStreak = 0; }
        if (!l.generating && l.runStreak >= 2) { l.generating = true; item.lastActiveAt = t; emit(); }
        else if (l.generating && l.stopStreak >= 2) {
          l.generating = false;
          item.lastCompletedAt = t; item.lastActiveAt = t;
          const watching = shownId === id && visible && focused, auto = automated.has(id);
          if (!watching && !auto) item.unread = true;
          persist();
          emit({ completed: { id, title: publicItem(item).displayTitle, siteName: SITES[item.site].name, notify: !watching && !auto } });
        }
        if (l.generating || (id === shownId && visible && focused)) item.lastActiveAt = t;
      }
      if (automated.has(id)) item.lastActiveAt = t;
      if (id !== shownId && !l.generating && t - (item.lastActiveAt || 0) > IDLE_MS) suspend(id, 'idle');
    }
    if (!live.size) { clearInterval(timer); timer = null; }
  }
  function ensureTimer() {
    if (timer || disposed) return;
    timer = setInterval(() => { void poll().catch(e => logger.warn('[web-sessions] 状态巡检失败：', e.message)); }, POLL_MS);
    timer.unref?.();
  }
  function dispose() {
    disposed = true;
    if (owned) { try { const o = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); if (o?.pid === process.pid) fs.unlinkSync(ownerFile); } catch {} }
    clearInterval(timer); timer = null;
    for (const id of [...live.keys()]) suspend(id, 'close');
  }
  // 测试与排障用：当前显示的原生网页实际所在的位置（窗口内容坐标）和是否挂在窗口上。
  function list() {
    const l = shownId && live.get(shownId);
    const win = getWindow();
    reloadItems();
    const attached = !!(l && win && !win.isDestroyed() && win.contentView.children.includes(l.view) && l.view.getVisible());
    return state({ view: l ? { bounds: l.view.getBounds(), attached } : null });
  }
  return { list, create, show, setBounds, setVisible, hide, suspend: id => suspend(id), close, rename, navigate, markRead, dispose, state, pageFor, setAutomation };
}

function registerWebSessionsIpc(ipcMain, { web, getWindow }) {
  const trusted = event => { const win = getWindow(); return !!win && !win.isDestroyed() && event.sender === win.webContents; };
  const handlers = {
    'web-sessions:list': () => web.list(),
    'web-sessions:create': r => web.create(r),
    'web-sessions:show': r => web.show(r),
    'web-sessions:bounds': r => web.setBounds(r?.bounds),
    'web-sessions:visible': r => web.setVisible(r?.visible),
    'web-sessions:hide': () => web.hide(),
    'web-sessions:suspend': r => web.suspend(r?.id),
    'web-sessions:close': r => web.close(r?.id),
    'web-sessions:rename': r => web.rename(r?.id, r?.title),
    'web-sessions:navigate': r => web.navigate(r?.id, r?.action),
    'web-sessions:mark-read': r => web.markRead(r?.id),
  };
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, request) => {
      if (!trusted(event)) return { ok: false, error: '无权操作网页会话' };
      try { return await fn(request || {}); } catch (e) { return { ok: false, error: e.message }; }
    });
  }
}

module.exports = { createWebSessions, registerWebSessionsIpc, SITES, IDENTITIES, cleanTitle, browserUserAgent, userAgentOverride, CHROME_SHIM, PROBE };

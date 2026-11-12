'use strict';
// 「个人」页的主进程接线（2026-11-12）：在各功能入口记一次使用、认人、回溯历史、把升级和成就告诉页面与桌宠。
// 计分不改各功能自己的代码：installProfileTap 在注册 IPC 时给下表里的入口套一层，用户真的点到那个功能才记。
const fs = require('node:fs');
const path = require('node:path');

// IPC 入口 → 记什么。feature 记「用过这个功能」；kind 记消息 / 新建会话。
// gap：页面打开时会反复调用的入口（读状态、边打字边搜），同一功能 5 分钟内只算一次，不让次数虚高。
const GAP = 5 * 60000;
const TAPS = {
  'session:send-prompt': { kind: 'prompt', when: (_req, res) => !(res && res.notSent) },
  'create-session': { kind: 'session' },
  'company-assistant:ask': { feature: 'assistant' },
  'company-assistant:brief-now': { feature: 'assistant' },
  'company-assistant:room-command': { feature: 'rooms', when: req => ['start', 'once', 'configure'].includes(req && req.op) },
  'company-assistant:meeting-start': { feature: 'meeting' },
  'company-assistant:ppt-search': { feature: 'ppt', gap: GAP },
  'company-assistant:ppt-ask': { feature: 'ppt' },
  'company-assistant:ppt-make-start': { feature: 'ppt' },
  'company-forum:ensure-today': { feature: 'forum', gap: GAP },
  'company-attendance:ensure-today': { feature: 'attendance', gap: GAP },
  'team:decide': { feature: 'team', when: req => !!req && req.approve === true },
  'create-meeting': { feature: 'roundtable' },
  'groupchat:turn': { feature: 'roundtable' },
  'ask-aside:ask': { feature: 'aside' },
  'hub-rules:save-mine': { feature: 'rules' },
  'env-check:run': { feature: 'components', gap: GAP },
  'execute-disk-release': { feature: 'disk' },
  'get-disk-usage-analysis': { feature: 'disk', gap: GAP },
};

function installProfileTap(ipcMain, { now = () => Date.now() } = {}) {
  const tap = { profile: null, seen: new Set() };
  const lastAt = new Map();
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    const rule = TAPS[channel];
    if (!rule) return handle(channel, handler);
    tap.seen.add(rule.feature || 'chat');
    tap.profile?.registerFeature(rule.feature || 'chat');
    // 原处理照常执行，返回值和异常原样交回；它成功了（没抛错、没回 ok:false、满足这个入口自己的条件）才记一次。
    const note = (result, args) => {
      try {
        if (result && result.ok === false) return;
        if (rule.when && !rule.when(args[0], result)) return;
        if (rule.kind === 'prompt') tap.profile?.record('prompt', { skill: !!(args[0] && args[0].codeagentSkill) });
        else if (rule.kind) tap.profile?.record(rule.kind);
        else if (!rule.gap || now() - (lastAt.get(rule.feature) || -Infinity) >= rule.gap) { lastAt.set(rule.feature, now()); tap.profile?.record('feature', { id: rule.feature }); }
      } catch (error) { console.error('[profile] 计分失败：', error.message); }
    };
    return handle(channel, (event, ...args) => {
      const out = handler(event, ...args);
      if (out && typeof out.then === 'function') { out.then(result => note(result, args), () => {}); return out; }
      note(out, args);
      return out;
    });
  };
  tap.bind = profile => { tap.profile = profile; for (const id of tap.seen) profile.registerFeature(id); };
  return tap;
}

// 历史用量：Token 账本里有用量的日期 + 每天新建的会话数（按会话文件的创建时间）。
function readHistory(dataDir, dayKey) {
  const out = { activeDays: [], sessionDays: {}, tokens: 0, hasLedger: false, models: [] };
  const models = new Map();
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'token-usage-ledger.json'), 'utf8'));
    out.hasLedger = true;
    for (const [day, rows] of Object.entries(ledger.days || {})) {
      let sum = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        const n = (Number(row[3]) || 0) + (Number(row[5]) || 0) + (Number(row[6]) || 0);
        sum += n;
        const model = String(row[1] || row[0] || '其他').slice(0, 60);
        if (n > 0) models.set(model, (models.get(model) || 0) + n);
      }
      if (sum > 0) { out.activeDays.push(day); out.tokens += sum; }
    }
    out.models = [...models].map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  } catch { /* 还没有账本：只按会话文件回溯 */ }
  try {
    const dir = path.join(dataDir, 'sessions');
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const stat = fs.statSync(path.join(dir, name));
      const key = dayKey(new Date(stat.birthtimeMs || stat.mtimeMs));
      out.sessionDays[key] = (out.sessionDays[key] || 0) + 1;
    }
  } catch { /* 没有会话目录 */ }
  return out;
}

function createProfileController({ ipcMain, tap, dataDir, sendToRenderer, getAssistant = () => null, getPet = () => null, codeAccount = () => '', transcriptTap = null, app = null }) {
  const { Profile, dayKey } = require('../core/profile/service');
  const identity = require('../core/profile/identity');
  const profile = new Profile({ dataDir });
  tap?.bind(profile);
  let identityBusy = null, lastOpenDay = '', models = [];

  // 入口按钮和页面头像用当前桌宠的形象；没有桌宠的版本用名字里的字。
  const petInfo = () => { try { const pet = getPet(); if (!pet) return { available: false }; const st = pet.getSettings(); return { available: true, enabled: !!st.enabled, role: st.role || '' }; } catch { return { available: false }; } };
  const brief = () => ({ ...profile.brief(), pet: petInfo() });
  const pushPet = () => { try { getPet()?.setProfile?.(profile.brief()); } catch { /* 桌宠没开 */ } };
  const changed = () => { sendToRenderer('profile:changed', brief()); pushPet(); };
  let changedTimer = null;
  profile.on('changed', () => { if (!changedTimer) changedTimer = setTimeout(() => { changedTimer = null; changed(); }, 400); });
  // 升级、解锁成就：页面弹一条提示；桌宠开着就让它庆祝。一次解锁多枚时合成一条。
  profile.on('achievement', ({ list }) => {
    const first = list[0], more = list.length - 1;
    const payload = { type: 'achievement', icon: first.icon, title: more > 0 ? `解锁 ${list.length} 枚成就` : `解锁成就「${first.name}」`, text: more > 0 ? list.map(a => a.name).join('、') : first.desc, list };
    sendToRenderer('profile:event', payload);
    try { getPet()?.celebrate?.({ id: 'ach-' + first.id, title: payload.title, text: payload.text, art: 'badge-' + first.icon }); } catch { /* 桌宠没开 */ }
  });
  profile.on('level-up', ev => {
    const perk = ev.perks.map(p => `桌宠解锁「${p.name}」`).join('，');
    const payload = { type: 'level-up', level: ev.to, rank: ev.rank.n, title: ev.rankUp ? `升到 Lv.${ev.to} · 晋升${ev.rank.name}` : `升到 Lv.${ev.to}`, text: perk || `${ev.rank.name}，继续加油` };
    sendToRenderer('profile:event', payload);
    try { getPet()?.celebrate?.({ id: 'lv-' + ev.to, title: payload.title, text: payload.text, big: ev.rankUp, art: 'rank-' + ev.rank.n }); } catch { /* 桌宠没开 */ }
  });

  function noteOpen() {
    const key = dayKey(new Date());
    if (key === lastOpenDay) return;
    lastOpenDay = key; profile.record('open');
  }
  function syncHistory() {
    const history = readHistory(dataDir, dayKey);
    // 账本要等首次统计才有：没有账本、也没有旧会话时先不结案，下次再试。
    const done = profile.state.backfill;
    if ((!done && (history.hasLedger || Object.keys(history.sessionDays).length)) || (done && !done.ledger && history.hasLedger)) profile.backfill({ ...history, ledger: history.hasLedger });
    profile.setTokens(history.tokens); models = history.models;
    try { if (getPet()?.isActive?.()) profile.petCompany(); } catch { /* 桌宠没开 */ }
  }
  function refreshIdentity({ force = false } = {}) {
    if (identityBusy) return identityBusy;
    identityBusy = (async () => {
      const assistant = getAssistant();
      const local = identity.localIdentity({
        assistantSettings: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'company-assistant', 'settings.json'), 'utf8')),
        codeAccount,
      });
      if (!profile.state.identity) profile.setIdentity({ ...local, at: Date.now() });
      const welink = assistant && typeof assistant.rawWelink === 'function' ? args => assistant.rawWelink(args, { timeoutMs: 15000 }) : null;
      const next = await identity.resolveIdentity({ cached: profile.state.identity, local, welink, force });
      profile.setIdentity(next);
      return next;
    })().catch(error => { console.error('[profile] 认人失败：', error.message); return profile.state.identity; }).finally(() => { identityBusy = null; });
    return identityBusy;
  }

  transcriptTap?.on('turn-complete', () => { try { profile.record('turn'); } catch (error) { console.error('[profile] 计分失败：', error.message); } });
  app?.on('browser-window-focus', noteOpen);
  app?.on('before-quit', () => { try { profile.flush(); } catch { /* 退出时保存失败不拦退出 */ } });

  // 足迹页和名片页另外要的：各模型用量、版本、WeLink 登录状态。
  const extra = () => {
    let welink = 'none';
    try { const a = getAssistant(); if (a && a.auth) welink = a.auth.status().state || 'unknown'; } catch { welink = 'unknown'; }
    return { models, version: app?.getVersion?.() || '', welink };
  };
  const handlers = {
    // 打开页面时先和文件对一次：别的 Hub 窗口记的经验也算进来
    state: () => { profile.save(); return { ok: true, snapshot: profile.snapshot(), brief: brief(), extra: extra() }; },
    brief: () => ({ ok: true, brief: brief() }),
    seen: () => { profile.markSeen(); return { ok: true }; },
    'set-nickname': request => { profile.setNickname(request && request.name); return { ok: true, brief: brief() }; },
    'refresh-identity': async () => { await refreshIdentity({ force: true }); return { ok: true, snapshot: profile.snapshot(), brief: brief(), extra: extra() }; },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('profile:' + name, async (_event, request = {}) => { try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; } });
  }

  let timer = null;
  function start() {
    noteOpen();
    setTimeout(() => { try { syncHistory(); } catch (error) { console.error('[profile] 回溯失败：', error.message); } void refreshIdentity(); pushPet(); }, 4000).unref?.();
    // 定时只同步历史和身份；「今天用过」只在启动、窗口获得焦点和实际操作时记，Hub 挂在后台不算。
    timer = setInterval(() => { try { syncHistory(); profile.save(); } catch { /* 下次再试 */ } void refreshIdentity(); }, 30 * 60000); timer.unref?.();
  }
  return { profile, start, refreshIdentity, syncHistory, brief: () => profile.brief(),
    // 桌宠被摸了一下。
    notePet: () => profile.record('pet'),
    noteFeature: id => profile.record('feature', { id }),
    stop: () => { clearInterval(timer); profile.flush(); } };
}

module.exports = { installProfileTap, createProfileController, readHistory, TAPS };

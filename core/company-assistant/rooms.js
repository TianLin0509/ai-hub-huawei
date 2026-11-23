'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const component = require('./room-component');
const { createRuntimeDownload } = require('./room-runtime-download');
const S = require('./room-schedule');
const { RoomOfflineRetry } = require('./room-offline-retry');

const SOON_MS = 10 * 60000;   // 订到的会开始前 10 分钟，桌宠提醒一次
const RULES = ['主题', '开始时间', '时长小时', '时长分钟', '优先会议室', '抢订日', '抢订设置', '会后动作', '系统', '高级', '地域'];
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('会议室文件读取失败：' + path.basename(file) + '（' + error.message + '）'); }
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// 「10-27（周一）14:00–16:00 · 会议室」：由记录里的日期、开始时间与时长计算；字段不全就原样显示。
const WEEK = '日一二三四五六';
function slotText(r = {}) {
  const room = r['会议室'] || '未选定', raw = `${r['日期'] || ''} ${r['时间'] || ''}`.trim();
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r['日期'] || '').trim());
  const t = /^(\d{1,2}):(\d{2})\s*起\s*(\d+)h(\d+)m$/.exec(String(r['时间'] || '').trim());
  if (!d || !t) return `${raw} · ${room}`;
  const day = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
  const start = Number(t[1]) * 60 + Number(t[2]), end = start + Number(t[3]) * 60 + Number(t[4]);
  if (day.getMonth() !== Number(d[2]) - 1 || Number(t[2]) > 59 || end <= start || end > 24 * 60) return `${raw} · ${room}`;
  const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${d[2]}-${d[3]}（周${WEEK[day.getDay()]}）${hm(start)}–${hm(end)} · ${room}`;
}
class RoomBooking {
  constructor(a, deps = {}) {
    this.a = a; this.deps = deps; this.timer = null; this.starting = null; this.ticking = false;
    this.error = ''; this.preparationError = ''; this.lastStart = 0; this.child = null; this.runtime = null;
    this.offlineRetry = new RoomOfflineRetry(this);
  }
  saved() { const exe = this.settings().exePath; return !!(exe && fs.existsSync(exe)); }
  // 会议室运行时（77MB 的秘书终结者）第一次用时才下载：这里只做一次性的准备，不联网。
  runtimeDownloader() {
    if (this.deps.roomCommand) return null;
    if (this.runtime && this.runtime.bundle === this.deps.roomBundle) return this.runtime.downloader;
    let downloader = null, error = '';
    try {
      const { baseline } = component.bundledRuntime(this.deps.roomBundle);
      // 'roomDownloader' in deps：测试要能明确说「这台机器不联网」，传 null 就别再建下载器。
      downloader = 'roomDownloader' in this.deps ? this.deps.roomDownloader
        : createRuntimeDownload({ dataDir: this.a.dir, baseline, sources: this.deps.roomRuntimeSources,
          fetchImpl: this.deps.roomFetch,
          // 下载器每 250ms 报一次进度，不能每次都把整页重画（下面还有 3 秒轮询）：1 秒最多推一次；
          // 结束态（成功/失败/取消）立即推，让界面马上换按钮。
          onState: state => {
            const now = Date.now();
            if (state.phase === 'downloading' && now - (this.runtime?.pushedAt || 0) < 1000) return;
            if (this.runtime) this.runtime.pushedAt = now;
            this.a.changed();
          } });
    } catch (e) { error = e.message; }
    this.runtime = { bundle: this.deps.roomBundle, downloader, error, pushedAt: 0 };
    return downloader;
  }
  runtimeState() {
    const dl = this.runtimeDownloader(), status = dl ? dl.status() : null;
    let info = { cached: false, bundled: false, bytes: null, sha256: null, error: '' };
    try {
      const now = component.runtimeInfo(this.a, { bundle: this.deps.roomBundle });
      info = { cached: now.cached, bundled: now.bundled, bytes: now.bytes, sha256: now.sha256, error: '' };
    } catch (error) { info = { ...info, error: error.message }; }
    return { ...info, ...(status || {}), installed: info.cached || info.bundled || !!(status && status.installed),
      phase: status ? status.phase : 'unavailable', error: (status && status.error) || info.error || this.runtime?.error || '' };
  }
  settings() { return this.a.settings().rooms || {}; }
  home() { return this.deps.roomHome || this.settings().home || require('../work-file-root').directory('meeting-room', path.join(this.a.dir, 'meeting-room')); }
  file(...parts) { return path.join(this.home(), ...parts); }
  helper() { return this.home() ? readJson(this.file('hub-control', 'status.json'), null) : null; }
  status() {
    let helper;
    try { helper = this.helper(); } catch (e) { this.error = e.message; }
    const live = !this.blockedExternal && helper?.protocol === 1 && (!helper.pid || processAlive(helper.pid))
      && this.a.now() - helper.at < 30000 && helper.at <= this.a.now() + 5000;
    const runtime = this.runtimeState();
    return { available: !!this.deps.roomCommand || runtime.installed, download: runtime, embedded: true, preparing: !!this.starting,
      connected: !!live, running: !!(live && helper.running), mode: live ? helper.mode : null,
      loginNeeded: !!helper?.loginNeeded, loginBusy: !!(live && helper.loginBusy),
      rules: helper?.rules || null, phases: live ? helper.phases : {}, nextOpen: helper?.nextOpen,
      error: this.preparationError || this.error, home: this.home(), enabled: !!this.settings().enabled,
      ...this.scheduleState(helper), events: (this.a.state().roomEvents || []).map(e => ({ ...e, record: this.offlineRetry.decorate(e.record), slot: slotText(e.record) })) };
  }
  // 会议室名称与近期日程地点用来推断园区；日程快照每 10 分钟最多读一次。
  meetingLocations() {
    const now = this.a.now();
    if (this.locCache && now - this.locCache.at < 10 * 60000) return this.locCache.list;
    let list = [];
    try {
      const snap = this.a.snapshot?.();
      list = [...(snap?.meetings || []), ...(snap?.calendar || [])].map(m => String(m.location || '')).filter(Boolean).slice(0, 200);
    } catch { list = []; }
    this.locCache = { at: now, list };
    return list;
  }
  // 生效的抢订节奏 + 组件是否能按非 7 天抢。
  schedule(helper = null) {
    try { helper = helper || this.helper(); } catch { helper = null; }
    const rooms = [...(helper?.rules?.['优先会议室'] || []), ...((helper?.history || []).map(r => r['会议室']).filter(Boolean))];
    const inferred = S.inferCampus({ rooms, locations: this.meetingLocations() });
    const componentOpenTime = helper?.preferences?.['抢订设置']?.['开放时间'] || helper?.rules?.['抢订设置']?.['开放时间'] || null;
    const schedule = S.resolveSchedule({ saved: this.settings().schedule, inferred, componentOpenTime });
    const caps = Array.isArray(helper?.capabilities) ? helper.capabilities : [];
    return { ...schedule, componentOpenTime: S.normalizeOpenTime(componentOpenTime), advanceDaysSupported: caps.includes('advance-days') };
  }
  scheduleState(helper) {
    const schedule = this.schedule(helper), openAt = S.nextOpenAt(this.a.now(), schedule.openTime);
    return { schedule: { ...schedule, text: S.describe(schedule), hubNextOpen: openAt.toISOString(), hubTargetDate: S.targetDateFor(openAt, schedule.advanceDays) },
      targetOffsetDays: schedule.advanceDays };
  }
  saveSchedule({ advanceDays, openTime } = {}) {
    const days = Number(advanceDays), open = S.normalizeOpenTime(openTime);
    if (!S.validDays(days)) throw new Error(`提前天数请填 ${S.MIN_DAYS}–${S.MAX_DAYS} 的整数`);
    if (!open) throw new Error('开放时刻请填 00:00–23:59 的时间');
    this.a.setSettings({ rooms: { schedule: { advanceDays: days, openTime: open, confirmed: true, at: this.a.now() } } });
    this.a.changed();
    return this.status();
  }
  // 开抢前把生效的节奏交给组件：开放时刻组件本来就收；提前天数要新版组件才收。
  // 规则不是 7 天而组件只会抢 7 天：启动守护、立即抢一次都会白跑，在准备组件之前就拒绝。测试填表不提交，照常放行。
  checkSchedule(op) {
    const s = this.schedule();
    if (['start', 'once'].includes(op) && s.advanceDays !== S.DEFAULT_ADVANCE_DAYS && !s.advanceDaysSupported) {
      const who = s.source === 'campus' ? `${s.campus}园区是提前 ${s.advanceDays} 天放号` : `你设置的是提前 ${s.advanceDays} 天`;
      throw new Error(`${who}，当前会议室组件只会抢 7 天后的会议室，按这个规则抢不到；需要更新会议室组件后才能按 ${s.advanceDays} 天抢。本次未启动，可在「设置 · 抢订节奏」改回 7 天`);
    }
    return s;
  }
  async applySchedule() {
    const s = this.schedule();
    const patch = {};
    // 组件开放时刻已知且不同，或不知道组件当前值而规则来自园区/用户设置时才下发；默认规则不动组件原设置。
    if (s.componentOpenTime ? s.componentOpenTime !== s.openTime : s.source !== 'default') patch['开放时间'] = s.openTime;
    if (s.advanceDaysSupported) patch['提前天数'] = s.advanceDays;
    if (Object.keys(patch).length) await this.command('configure', { '抢订设置': patch }, { user: true, internal: true });
  }
  details() {
    const state = this.status(), helper = this.helper() || {};
    const keys = ['version', 'capabilities', 'loginState', 'loginCheckedAt', 'serverNow', 'targetDate', 'preferences',
      'history', 'logs', 'pending', 'roomRead', 'messageTest', 'cliAvailable'];
    for (const key of keys) state[key] = helper[key];
    state.controlBusy = state.connected ? helper.controlBusy : null;
    // The original exe history includes entries made before Hub was connected.
    if (!state.history) {
      const history = readJson(this.file('booking_history.json'), []);
      if (!Array.isArray(history)) throw new Error('会议室历史格式不正确，原文件已保留');
      state.history = history.slice(-50);
    }
    state.history = this.offlineRetry.history(state.history);
    return state;
  }
  // 可选功能「会议室」关着（2026-11-19 反馈 1b517a0b）：不轮询、不自动开抢、不拉起组件进程。默认开，由 main.js 按开关设。
  setEnabled(on) { this.off = !on; if (this.off) this.close(); }
  // 关之前先确认不会让已经安排好的抢订落空；返回拦下的原因，空串表示可以关。
  offBlocker() {
    const s = this.status();
    let helper = null;
    try { helper = this.helper(); } catch { helper = null; }
    if (s.running || this.settings().enabled) return '自动抢订还开着，关掉会让之后的放号抢订落空；先在会议室页点「暂停」再关';
    if (s.loginBusy) return '会议室助手正在登录，等登录结束再关';
    if (s.connected && helper?.controlBusy) return '会议室组件正在执行操作（如读取会议室），等它做完再关';
    if (Array.isArray(helper?.pending) && helper.pending.length) return `还有 ${helper.pending.length} 个会后动作（提醒或自动释放）等着执行，关掉会落空；先在会议室页处理掉再关`;
    if (this.offlineRetry.active()) return '正在等网络恢复后自动补抢，先在会议室页停掉补抢再关';
    if (this.starting) return '会议室组件正在启动，稍等几秒再关';
    return '';
  }
  // 关掉：停轮询，并结束 Hub 拉起的会议室组件进程（只按登记的进程号、核对过程序路径才结束），之后不常驻。
  async shutdown() {
    this.setEnabled(false);
    let helper = null;
    try { helper = this.helper(); } catch { helper = null; }
    const exe = this.settings().exePath;
    if (!this.status().connected || !helper?.pid || !exe) return { stopped: false };
    await component.stopManagedHelper(helper, exe);
    // 结束命令返回不代表进程真的没了：最多等 5 秒核一次，还在就报错（main.js 会把开关恢复成开着）。
    for (let i = 0; i < 25 && processAlive(Number(helper.pid)); i++) await new Promise(r => setTimeout(r, 200));
    if (processAlive(Number(helper.pid))) throw new Error('会议室组件进程没有结束');
    this.child = null;
    return { stopped: true };
  }
  // 15 秒巡检只在有事可做时才跑（2026-11-23 开销优化）：组件装过（有控制状态或抢订历史、记住了 exe）、
  // 自动抢订开着、正在准备组件、或有补抢在等。都没有时（没用过会议室的人）不再每 15 秒读写状态、刷新界面；
  // 之后一旦装组件、开抢、打开会议室页看状态，就由 wakeTimer() 按需拉起。
  needsTimer() {
    if (this.starting || this.child || this.settings().enabled || this.offlineRetry.active() || this.saved()) return true;
    try { return fs.existsSync(this.file('hub-control', 'status.json')) || fs.existsSync(this.file('booking_history.json')); }
    catch { return false; }
  }
  start() {
    if (this.off) return;
    this.offlineRetry.start();
    this.wakeTimer();
  }
  wakeTimer() {
    if (this.off || this.deps.noTimer || this.timer || !this.needsTimer()) return;
    this.timer = setInterval(() => { void this.tick().catch(e => { this.error = e.message; this.a.changed(); }); }, 15000);
  }
  stopTimer() { clearInterval(this.timer); this.timer = null; }
  // 关 Hub 时只停 Hub 自己的定时器，不结束会议室组件进程：组件是常驻的抢订守护，Hub 退出后照样按放号时刻抢，
  // 结束它会让已经安排好的抢订落空。真正要停组件走 shutdown()（「可选功能」里关掉会议室时，按进程号核对后结束）。
  close() { this.stopTimer(); this.offlineRetry.close(); }
  readHistory() {
    const history = readJson(this.file('booking_history.json'), []);
    if (!Array.isArray(history)) throw new Error('秘书历史格式不正确，已保留之前的结果');
    return history;
  }
  async discover() { return this.status(); }
  async install() { return this.ensure({ user: true }); }
  async reconnect() {
    const helper = this.helper(), live = this.status();
    const desired = component.manifest(path.join(this.deps.roomBundle || path.join(__dirname, 'room-component'), 'control.json'));
    if (live.connected && helper?.version !== desired.version) {
      const versionNumber = v => String(v || '').split('.').map(Number).reduce((n, x) => n * 1000 + x, 0);
      if (versionNumber(helper.version) > versionNumber(desired.version)) throw new Error('本机会议室组件较新，请升级 Hub 后继续，现有组件已保留');
      const runtime = await component.prepareRuntime(this.a, { bundle: this.deps.roomBundle, downloader: this.runtimeDownloader() });
      await component.stopManagedHelper(helper, runtime.exe);
    }
    return this.ensure({ user: true });
  }
  useExecutable(exePath) {
    if (!/\.exe$/i.test(exePath) || !fs.existsSync(exePath)) throw new Error('请选择已安装的秘书终结者 exe');
    this.a.setSettings({ rooms: { exePath, home: path.dirname(exePath), enabled: false } });
    this.wakeTimer();
    this.error = ''; return this.status();
  }
  baselineHistory() {
    if (this.a.state().roomSeen !== undefined || !this.home()) return;
    const history = readJson(this.file('booking_history.json'), []);
    if (!Array.isArray(history)) throw new Error('秘书历史格式不正确，未启动抢订');
    this.a.saveState({ roomSeen: history.map(r => createHash('sha256').update(JSON.stringify(r)).digest('hex')) });
  }
  // Preparing the embedded control component does not start a booking. Only the
  // explicit start command (or an already enabled schedule) may enter daemon mode.
  async ensure({ user = false } = {}) {
    if (this.off) throw new Error('会议室已在「可选功能」里关闭；在会议室页点「开启会议室」后再用');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const runtime = this.deps.roomCommand ? null
        : await component.prepareRuntime(this.a, { bundle: this.deps.roomBundle, downloader: this.runtimeDownloader() });
      const command = this.deps.roomCommand || [runtime.exe];
      if (!command[0] || !fs.existsSync(command[0])) throw new Error('会议室组件不可用，请修复 Hub 安装包');
      if (!this.deps.roomCommand) {
        const foreign = await component.foreignInstances(runtime.exe, { listProcesses: this.deps.roomProcesses });
        this.blockedExternal = foreign.length > 0;
        if (this.blockedExternal) throw new Error('旧秘书终结者正在运行，请先在它的托盘退出，再回到 Hub；当前未启动第二份抢订');
      }
      if (this.status().connected) { this.baselineHistory(); this.error = ''; this.preparationError = ''; return { ...this.status(), preparing: false }; }
      component.initializeHome(this.home());
      if (runtime) {
        await component.stage(this.a, runtime.exe, this.home(), { baseline: runtime.baseline, bundle: this.deps.roomBundle });
        this.a.setSettings({ rooms: { exePath: runtime.exe, home: this.home(), enabled: !!this.settings().enabled } });
      }
      this.baselineHistory();
      const child = (this.deps.roomSpawn || spawn)(command[0], [...command.slice(1), '--hub-control'], {
        cwd: path.dirname(command[0]), windowsHide: true,
        env: { ...process.env, ...(this.deps.roomEnv || {}), MSZ_HOME: this.home(), MSZ_NO_TRAY: '1', QT_QPA_PLATFORM: 'offscreen' }, stdio: 'ignore',
      });
      this.child = child;
      let failed = null, exited = false;
      child.on('error', e => { failed = e; });
      child.on('exit', () => { exited = true; });
      child.unref?.();
      const end = Date.now() + (this.deps.roomReadyTimeoutMs || 120000);
      while (Date.now() < end) {
        if (failed) throw failed;
        if (this.status().connected) { this.error = ''; this.preparationError = ''; return { ...this.status(), preparing: false }; }
        if (exited) throw new Error('会议室组件未接通。若旧秘书终结者正在运行，请先退出旧实例；当前未启动第二份抢订');
        await new Promise(r => setTimeout(r, 250));
      }
      await (this.deps.roomKill || component.killTree)(child);
      throw new Error('会议室组件准备超时，本次后台进程已关闭；请稍后重试');
    })().catch(error => { this.preparationError = error.message; throw error; }).finally(() => { this.starting = null; this.wakeTimer(); this.a.changed(); });
    this.a.changed();
    return this.starting;
  }
  async command(op, args = {}, { user = false, internal = false } = {}) {
    if (!['status', 'configure', 'start', 'pause', 'login', 'show', 'test', 'once', 'read-rooms', 'test-message', 'remove-pending'].includes(op)) throw new Error('不支持的会议室操作');
    if (['once', 'test-message', 'remove-pending'].includes(op) && !user) throw new Error('请在会议室页面亲自执行此操作');
    if (op === 'configure' && !user && ['抢订设置', '会后动作', '系统', '高级'].some(k => Object.hasOwn(args, k))) throw new Error('请在会议室页面亲自修改高级设置');
    if (op === 'configure' && Object.keys(args).some(k => !RULES.includes(k))) {
      const s = this.schedule();
      throw new Error(`目标日期按抢订节奏自动算（每天 ${s.openTime.slice(0, 5)} 放号，抢 ${s.advanceDays} 天后），不支持指定某一天；请提供主题、时段、会议室和星期`);
    }
    if (op === 'status') return this.status();
    if (!internal && ['pause', 'once', 'test', 'configure', 'start'].includes(op)) this.offlineRetry.cancel();
    if (!internal) this.checkSchedule(op);
    if (!internal) await this.ensure({ user });
    if (!internal && ['start', 'once', 'test'].includes(op)) await this.applySchedule();
    const id = randomUUID(), req = this.file('hub-control', 'requests', id + '.json'), reply = this.file('hub-control', 'replies', id + '.json');
    fs.mkdirSync(path.dirname(req), { recursive: true });
    const tmp = req + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ id, op, args, at: this.a.now() }), 'utf8'); fs.renameSync(tmp, req);
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const result = readJson(reply, null);
      if (result) {
        if (result.requestId !== id) throw new Error('秘书回执编号不一致');
        if (!result.ok) throw new Error(result.error || '秘书未执行这项操作');
        if (!internal && (op === 'start' || op === 'pause')) this.a.setSettings({ rooms: { enabled: op === 'start' } });
        this.wakeTimer();
        this.error = ''; this.a.changed(); return { ...this.status(), ...result, connected: true };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('秘书尚未回报结果，请查看当前状态；没有自动重复执行');
  }
  // 2026-11-20：Hub 升级后，常驻的旧组件进程不会自己换新版（抢订提速修复在 2.1.4 里）。
  // 远离放号时段、组件空闲（只在守护里等下一次放号）时自动换上新版，原来开着的守护照旧恢复；
  // 放号前 45 分钟到放号后 15 分钟、正在立即抢/测试/登录、有会后动作或补抢在等时都不动。
  async upgradeIdleHelper(live, minute, win, now) {
    if (this.deps.roomCommand || !live.connected || this.upgrading || now - (this.lastUpgrade || 0) < 30 * 60000) return;
    let helper, desired;
    try {
      helper = this.helper();
      desired = component.manifest(path.join(this.deps.roomBundle || path.join(__dirname, 'room-component'), 'control.json')).version;
    } catch { return; }
    const num = v => String(v || '').split('.').map(Number).reduce((n, x) => n * 1000 + x, 0);
    if (!helper?.version || num(helper.version) >= num(desired)) return;
    if (minute >= win.from - 15 && minute < win.to + 15) return;
    if (live.loginBusy || helper.controlBusy || (live.running && live.mode !== 'daemon')) return;
    if ((Array.isArray(helper.pending) && helper.pending.length) || this.offlineRetry.active()) return;
    const resume = !!(live.running && this.settings().enabled);
    this.upgrading = true; this.lastUpgrade = now;
    try {
      // 守护在跑时组件拒绝被结束：先内部暂停（不改「自动抢订」开关），等它真的停下再换。
      if (live.running) {
        await this.command('pause', {}, { internal: true });
        const end = Date.now() + 15000;
        while (this.helper()?.running && Date.now() < end) await new Promise(r => setTimeout(r, 300));
      }
      await this.reconnect();
      console.log(`[company-assistant] 会议室组件已自动从 ${helper.version} 换到 ${desired}`);
    } catch (e) {
      console.warn('[company-assistant] 会议室组件自动换新版没做成：', e.message);
    }
    try {
      if (resume) {
        try { await this.command('start'); } catch { await new Promise(r => setTimeout(r, 3000)); await this.command('start'); }
      }
    } catch (e) {
      this.a.bus?.publish?.({ id: 'room-upgrade:' + new Date(now).toISOString().slice(0, 10), kind: 'room', notify: true, page: 'rooms', tone: 'bad',
        cta: '打开会议室', title: '会议室自动抢订需要重新开启', text: '会议室组件换新版后没能恢复自动抢订：' + e.message + '。打开会议室页点「开始」即可。' });
    } finally { this.upgrading = false; }
  }
  // 桌宠联动（2026-11-09）：抢订有了新结果、订到的会快开始、会议室助手要重新登录，都交给提醒总线，
  // 开着桌宠时由桌宠举卡片说（点开到会议室页），没开桌宠时照旧是右下角通知卡。每件事只说一次。
  tellPet(added, history, live, now) {
    const bus = this.a.bus;
    if (!bus?.publish) return;
    // 一轮里新结果不超过 3 条就逐条说；更多时（集中抢订、暂停后恢复）并成一张汇总卡，一条都不漏。
    if (added.length > 3) {
      const won = added.filter(x => booked(x.record)).length;
      bus.publish({ id: 'room-batch:' + added[0].id, kind: 'room', notify: true, page: 'rooms', tone: won ? '' : 'bad', cta: '打开会议室',
        title: `抢订有 ${added.length} 条新结果：抢到 ${won} 条`, text: added.slice(0, 6).map(x => `${booked(x.record) ? '✓' : '✗'} ${slotText(x.record)}`).join('\n') + (added.length > 6 ? `\n……另有 ${added.length - 6} 条` : '') });
    } else for (const { id, record: r } of added) {
      const ok = booked(r), topic = String(r['主题'] || '').trim();
      bus.publish({ id: 'room:' + id, kind: 'room', notify: true, page: 'rooms', tone: ok ? '' : 'bad', cta: '打开会议室',
        title: ok ? '抢到会议室了' : `会议室${r['状态'] || '没抢到'}`, text: [slotText(r), topic, r['备注'] || ''].filter(Boolean).join('\n') });
    }
    const st = this.a.state(), told = new Set(st.roomSoonTold || []);
    let changed = false;
    for (const r of history.slice(-50)) {
      const at = slotStart(r);
      if (!booked(r) || at == null || at - now > SOON_MS || at - now <= 0) continue;
      const key = createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16);
      if (told.has(key)) continue;
      told.add(key); changed = true;
      const mins = Math.max(1, Math.round((at - now) / 60000)), topic = String(r['主题'] || '').trim();
      bus.publish({ id: 'room-soon:' + key, kind: 'room', notify: true, page: 'rooms', cta: '打开会议室',
        title: `${mins} 分钟后开会：${r['会议室'] || '会议室'}`, text: [slotText(r), topic].filter(Boolean).join('\n') });
    }
    if (changed) this.a.saveState({ roomSoonTold: [...told].slice(-60) });
    const needLogin = !!(live && live.loginNeeded);
    if (needLogin && !this.loginTold) {
      const day = new Date(now).toISOString().slice(0, 10);
      bus.publish({ id: 'room-login:' + day, kind: 'room', notify: true, page: 'rooms', tone: 'bad', cta: '打开会议室',
        title: '会议室助手要重新登录', text: '登录过期后自动抢订会落空；打开会议室页扫码登录一次就好。' });
    }
    this.loginTold = needLogin;
  }
  async tick() {
    if (this.off || this.ticking || !this.home()) return;
    // 没装组件、没开抢、没有补抢在等：这一轮什么都不读写，并停掉 15 秒巡检（有事时 wakeTimer 再拉起）。
    if (!this.needsTimer()) { this.stopTimer(); return; }
    this.wakeTimer();
    this.ticking = true;
    try {
      const now = this.a.now(), d = new Date(now), minute = d.getHours() * 60 + d.getMinutes();
      const live = this.status();
      if (this.settings().enabled && live.connected && !live.running && !this.offlineRetry.active()) this.a.setSettings({ rooms: { enabled: false } });
      const win = S.autoStartWindow(live.schedule?.openTime);
      if (this.settings().enabled && minute >= win.from && minute < win.to && !live.connected && now - this.lastStart >= 10 * 60000) {
        this.lastStart = now; await this.command('start');
      }
      await this.upgradeIdleHelper(live, minute, win, now);
      const history = this.readHistory();
      const idOf = r => createHash('sha256').update(JSON.stringify(r)).digest('hex');
      const stored = this.a.state(), prior = stored.roomSeen;
      const ids = history.map(idOf), seen = new Set(prior || ids);
      let events = stored.roomEvents || [];
      const added = [];
      if (prior) for (const record of history) {
        const id = idOf(record);
        if (seen.has(id)) continue;
        seen.add(id);
        added.push({ id, record });
        events = [{ id, at: now, record, phoneSent: false }, ...events].slice(0, 30);
      }
      this.a.saveState({ roomSeen: [...new Set([...(prior || []), ...ids])].slice(-200), roomEvents: events });
      await this.offlineRetry.tick(history, live, now);
      this.tellPet(added, history, live, now);
      for (const event of events.filter(e => !e.phoneSent).slice(0, 3)) {
        if (!this.a.phone?.active()) break;
        const r = event.record;
        const text = `会议室${r['状态'] || '结果'}：${slotText(r)}${r['备注'] ? '\n' + r['备注'] : ''}`;
        if (await this.a.phone.send(text, 'room')) {
          const latest = this.a.state().roomEvents || [];
          this.a.saveState({ roomEvents: latest.map(e => e.id === event.id ? { ...e, phoneSent: true } : e) });
        } else break;
      }
      this.error = ''; this.a.changed();
    } finally { this.ticking = false; }
  }
}
// 记录里的开始时刻（本地时间毫秒）；字段不全返回 null。
function slotStart(r = {}) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r['日期'] || '').trim());
  const t = /^(\d{1,2}):(\d{2})/.exec(String(r['时间'] || '').trim());
  if (!d || !t) return null;
  const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])).getTime();
  return Number.isFinite(at) ? at : null;
}
const booked = r => /成功|已预订|已预定|抢到/.test(String(r['状态'] || ''));
module.exports = { RoomBooking, RULES, readJson, slotText, slotStart, SOON_MS };

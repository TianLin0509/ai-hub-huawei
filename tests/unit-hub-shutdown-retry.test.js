'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('async function closeWindowsForShutdown(');
const end = source.indexOf("// 'quit'", start);
assert.ok(start > 0 && end > start, '真实退出函数存在');
const closeStart = source.indexOf("  mainWindow.on('close', (event) => {");
const closeEnd = source.indexOf('\n  });', closeStart) + '\n  });'.length;
assert.ok(closeStart > 0 && closeEnd > closeStart, '真实主窗口关闭处理器存在');
const cleanupStart = source.indexOf('async function runFinalShutdownCleanup()');
const cleanupEnd = source.indexOf("  capture('completion-notifier'", cleanupStart);
assert.ok(cleanupStart > 0 && cleanupEnd > cleanupStart, '真实服务清理函数存在');
const cleanupSource = source.slice(cleanupStart, cleanupEnd) + '\n  dbCleanup(); return { clean: errors.length === 0, errors };\n}';
const beatQuitHook = source.match(/app\.on\('will-quit', \(\) => beats\.forEach\(b => b\.stop\(\)\)\);/)[0];

function setup(t, { veto = false, drainSafe = true, overlays = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE retry_probe (value TEXT); INSERT INTO retry_probe VALUES (\'ready\')');
  const windows = [];
  const counts = { flush: 0, drain: 0, cleanup: 0, quit: 0, restore: 0, handoff: 0, freeze: 0, resume: 0 };
  const order = [];
  const app = new EventEmitter();
  const main = new EventEmitter();
  const stopped = {};
  const stop = name => { stopped[name] = (stopped[name] || 0) + 1; };
  const pet = { destroyed: false, isDestroyed() { return this.destroyed; }, close() { this.destroyed = true; stop('pet-close'); } };
  const petMenu = { ...pet, close() { this.destroyed = true; stop('pet-menu-close'); } };
  const notification = { ...pet, close() { this.destroyed = true; stop('notification-close'); } };
  if (overlays) windows.push(pet, petMenu, notification);
  main.webContents = new EventEmitter();
  main.destroyed = false;
  main.veto = veto;
  main.isDestroyed = () => main.destroyed;
  main.close = () => {
    let prevented = false;
    main.emit('close', { preventDefault() { prevented = true; } });
    if (prevented) return;
    if (main.veto) { order.push('veto'); main.webContents.emit('will-prevent-unload', {}); return; }
    main.destroyed = true;
    order.push('window-closed');
    main.emit('closed');
    app.emit('window-all-closed');
  };
  windows.push(main);
  const delivery = { freeze() { counts.freeze++; }, startWatching() { counts.resume++; }, dispose() { order.push('delivery-disposed'); } };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout,
    process: { __hubShutdownCleanupClean: false },
    app, BrowserWindow: { getAllWindows: () => windows.filter(w => !w.isDestroyed()) },
    mainWindow: main,
    shutdownDrainState: 'idle', shutdownDrainPromise: null,
    finalShutdownCleanupDone: false,
    trayController: { markQuitting() {}, interceptClose() { return false; } },
    global: { __deliveryEngine: delivery },
    agentLeagueBridge: { beginHandoff() { counts.handoff++; } },
    flushRendererWorkscene: async () => { counts.flush++; order.push('workscene-saved'); },
    sessionManager: { disposeGracefully: async () => { counts.drain++; order.push('drained'); return { safeToQuit: drainSafe, drainedPtyCount: 1, durationMs: 0 }; } },
    sessionModelCreationConfirmation: { cancelAll: () => stop('model-confirmation') },
    lanPoolService: { stop: async () => { await Promise.resolve(); stop('lan-pool'); } },
    companyProxyService: { stop: async () => { await Promise.resolve(); stop('proxy'); } },
    companyForumEdge: { close: async () => { await Promise.resolve(); stop('forum-edge'); } },
    accountCenter: { stopPump: () => stop('account-pump'), adapter: { dispose: () => stop('account-adapter') } },
    hubAccountsService: { stopAuto: () => stop('hub-accounts') },
    beats: [{ stop: () => stop('heartbeat') }],
    hubPetController: { getWindows: () => overlays ? [pet, petMenu] : [], dispose: () => {
      stop('pet-dispose'); if (overlays) { pet.destroyed = true; petMenu.destroyed = true; }
    } },
    desktopNotificationController: { getWindow: () => overlays ? notification : null, dispose: () => {
      stop('notification-dispose'); if (overlays) notification.destroyed = true;
    } },
    dbCleanup: () => { counts.cleanup++; order.push('database-closed'); db.close(); },
    restoreWindowAfterFailedShutdown: () => { counts.restore++; },
    closeHookServerForShutdown() {}, primeV8MemoryPoolForExit: () => ({ ok: true }),
  });
  app.quit = () => {
    counts.quit++;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit('before-quit', event);
    if (!event.defaultPrevented) { order.push('app-quit'); app.emit('will-quit', event); }
  };
  vm.runInContext(cleanupSource, context);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(source.slice(closeStart, closeEnd), context);
  vm.runInContext(beatQuitHook, context);
  main.on('closed', () => { context.mainWindow = null; });
  t.after(() => { try { db.close(); } catch {} });
  return { db, counts, stopped, order, app, main, context, pet, petMenu, notification, shutdown: () => context.beginGracefulHubShutdown('test-update') };
}

test('录音拒绝关窗后更新可重试：数据库和会话仍可用，第二次正常关闭', async t => {
  const f = setup(t, { veto: true });
  const failed = await f.shutdown();
  assert.equal(failed.safeToQuit, false);
  assert.match(failed.error, /未保存.*取消退出/);
  assert.equal(f.context.shutdownDrainState, 'idle');
  assert.equal(f.context.shutdownDrainPromise, null);
  assert.equal(f.main.destroyed, false, '拒绝关闭时保留原窗口');
  assert.equal(f.counts.drain, 0, '尚未中断会话');
  assert.equal(f.counts.handoff, 0, '尚未交接正在执行的任务');
  assert.equal(f.counts.cleanup, 0);
  assert.equal(f.counts.restore, 1);
  assert.equal(f.counts.resume, 1, '恢复派发');
  assert.equal(f.db.prepare('SELECT value FROM retry_probe').get().value, 'ready', '更新 gate 仍可读通道数据库');
  f.db.prepare('UPDATE retry_probe SET value = ?').run('retry');
  assert.equal(f.db.prepare('SELECT value FROM retry_probe').get().value, 'retry');

  f.main.veto = false;
  const result = await f.shutdown();
  assert.equal(result.safeToQuit, true);
  assert.equal(result.cleanup.clean, true);
  assert.equal(f.counts.drain, 1);
  assert.equal(f.counts.handoff, 1);
  assert.equal(f.counts.cleanup, 1);
  assert.equal(f.counts.quit, 1, 'window-all-closed 不应递归多次退出');
  assert.equal(f.counts.flush, 2, '两轮均先保存工作现场');
  assert.deepEqual(f.order, ['workscene-saved', 'veto', 'workscene-saved', 'window-closed', 'drained', 'database-closed', 'delivery-disposed', 'app-quit']);
  assert.throws(() => f.db.prepare('SELECT value FROM retry_probe').get(), /database is not open/);
});

test('普通退出只收尾一次，并在关窗前保存最新工作现场', async t => {
  const f = setup(t);
  f.app.quit();
  const result = await f.context.shutdownDrainPromise;
  assert.equal(result.safeToQuit, true);
  assert.equal(f.counts.flush, 1);
  assert.equal(f.counts.drain, 1);
  assert.equal(f.counts.cleanup, 1);
  assert.equal(f.counts.quit, 2, '一次退出请求，一次安全收尾后的最终退出');
  assert.equal(f.context.mainWindow, null);
  assert.ok(f.order.indexOf('workscene-saved') < f.order.indexOf('window-closed'));
  assert.ok(f.order.indexOf('window-closed') < f.order.indexOf('database-closed'));
});

test('实际 app.quit 入口拒绝关闭时，代理、账号、心跳及桌宠均保持原运行态', async t => {
  assert.equal((source.match(/app\.on\('before-quit'/g) || []).length, 1, '只保留统一的退出请求处理器，服务不得提前收尾');
  const f = setup(t, { veto: true, overlays: true });
  f.app.quit();
  const failed = await f.context.shutdownDrainPromise;
  assert.equal(failed.safeToQuit, false);
  assert.deepEqual(f.stopped, {}, '没有服务被 stop、dispose 或 cancel');
  assert.equal(f.pet.destroyed, false);
  assert.equal(f.petMenu.destroyed, false);
  assert.equal(f.notification.destroyed, false);
  assert.equal(f.counts.handoff, 0);
  assert.equal(f.db.prepare('SELECT value FROM retry_probe').get().value, 'ready');

  f.main.veto = false;
  f.app.quit();
  const result = await f.context.shutdownDrainPromise;
  assert.equal(result.safeToQuit, true);
  for (const name of ['model-confirmation', 'lan-pool', 'proxy', 'forum-edge', 'account-pump', 'account-adapter', 'hub-accounts', 'heartbeat', 'pet-dispose', 'notification-dispose']) {
    assert.equal(f.stopped[name], 1, `${name} 仅在最终退出时清理一次`);
  }
  assert.equal(f.stopped['pet-close'], undefined, '桌宠没有被通用关窗确认提前关闭');
  assert.equal(f.stopped['pet-menu-close'], undefined);
  assert.equal(f.pet.destroyed, true);
  assert.equal(f.petMenu.destroyed, true);
});

test('取消退出保留语音流和本地识别进程，will-quit 时才停止', () => {
  const voice = fs.readFileSync(path.join(__dirname, '..', 'main/ipc/voice-input-handlers.js'), 'utf8');
  const hook = voice.match(/app\.on\('will-quit',.*streams\.keys\(\).*\);/)[0];
  assert.equal(voice.includes("app.on('before-quit'"), false);
  const app = new EventEmitter(), stopped = [];
  vm.runInNewContext(hook, {
    app, streams: new Map([[10, {}]]), cancelOwner: id => stopped.push('stream:' + id), read: () => ({}),
    getLocal: () => ({ stop: () => stopped.push('local') }), getSpeaker: () => ({ stop: () => stopped.push('speaker') }),
  });
  app.emit('before-quit');
  assert.deepEqual(stopped, []);
  app.emit('will-quit');
  assert.deepEqual(stopped, ['stream:10', 'local', 'speaker']);
});

test('PTY 未退出时仍取消退出，不会关闭数据库', async t => {
  const f = setup(t, { drainSafe: false });
  const result = await f.shutdown();
  assert.equal(result.safeToQuit, false);
  assert.equal(f.counts.cleanup, 0);
  assert.equal(f.counts.quit, 0);
  assert.equal(f.counts.restore, 1);
  assert.equal(f.db.prepare('SELECT value FROM retry_probe').get().value, 'ready');
});

test('窗口一直不响应时取消退出，移除临时监听后允许重试', async t => {
  const f = setup(t);
  f.main.close = () => {};
  await assert.rejects(f.context.closeWindowsForShutdown(10), /窗口未能关闭/);
  assert.equal(f.main.listenerCount('closed'), 1, '只保留窗口原有的 closed 监听');
  assert.equal(f.main.webContents.listenerCount('will-prevent-unload'), 0);
  assert.equal(f.counts.cleanup, 0);
  assert.equal(f.db.prepare('SELECT value FROM retry_probe').get().value, 'ready');
});

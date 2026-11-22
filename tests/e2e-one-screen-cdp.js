'use strict';
// 「一个 Tab 一屏」回归（2026-11-21）：全新用户（空 HOME、空数据目录、PATH 里没有任何 CLI）、隔离 Hub、无头 CDP、1440×900；
// 设置另在 1024×640（公司黄区笔记本逻辑分辨率）下每个页签再测一遍（2026-11-22）。
//   1. 主页：#empty-state 不出纵向滚动，「保存并继续」在首屏内；
//   2. 启动中心新建会话：面板不滚动，「创建会话」与「更多选项」在首屏；点开能看到权限模式，关掉重开记住状态；
//   3. 设置：每个页签都不滚动，保存按钮在首屏；所有设置项 id 仍在页面上；搜「回车」回车后自动切到对应页签；
//   4. 会议室：右侧「守护」栏与左侧内容都不滚动；组件没接通时第 ① 步写明登录按钮为什么是灰的；
//   5. 深色主题（深海夜幕）下主页、启动中心、设置再测一遍。
// 用法：node tests/e2e-one-screen-cdp.js（截图与报告写到 HUB_E2E_ARTIFACT_DIR 或 artifacts/one-screen-gui）
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/one-screen-gui');
const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

// 设置弹窗里写死在 index.html 的设置项 id：分页签后一个都不能少。
function staticSettingIds() {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  const start = html.indexOf('<div id="config-main-view">');
  const end = html.indexOf('<div class="config-modal-actions">', start);
  return [...html.slice(start, end).matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
}

// 页面里会出纵向滚动条的区域（可见、overflow 为 auto/scroll、内容比可视区高 2px 以上）。
const SCROLLERS = root => `(()=>{const r=${root ? `document.querySelector(${JSON.stringify(root)})` : 'document.body'};if(!r)return ['missing ${root}'];return [r,...r.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);const b=e.getBoundingClientRect();return /(auto|scroll)/.test(s.overflowY)&&b.width>0&&b.height>0&&s.visibility!=='hidden'&&e.scrollHeight>e.clientHeight+2;}).map(e=>(e.id?'#'+e.id:(e.className||e.tagName))+' '+e.scrollHeight+'/'+e.clientHeight);})()`;
const IN_VIEW = sel => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight;})()`;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub one screen '));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  for (const dir of [home, data, out, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    [pathKey]: [system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
  };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) env[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const report = { checks: [], measures: {}, root };
  let hub, cdp;
  const until = async (expression, label, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { try { if (await cdp.eval(expression)) return; } catch {} await sleep(200); }
    throw new Error('Timeout: ' + label);
  };
  async function mouse(point) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  // 只点首屏里看得见的元素：点不到说明它被挤出了一屏。
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});if(r.top<0||r.bottom>innerHeight)throw Error('Off screen '+${JSON.stringify(selector)}+' '+Math.round(r.top)+'..'+Math.round(r.bottom));return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await mouse(point);
  }
  async function clickText(text, scope) {
    const point = await cdp.eval(`(()=>{const sc=document.querySelector(${JSON.stringify(scope)})||document.body;const els=[...sc.querySelectorAll('button,[role=menuitem],[role=option],li,div')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&r.bottom<=innerHeight&&e.textContent.includes(${JSON.stringify(text)})});const e=els.sort((a,b)=>a.textContent.length-b.textContent.length)[0];if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if (!point) throw new Error('Missing text ' + text);
    await mouse(point);
  }
  async function key(name, code) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
  }
  async function shot(name) {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
  }
  async function noScroll(label, rootSel) {
    const list = await cdp.eval(SCROLLERS(rootSel));
    report.measures[label] = list;
    assert.deepEqual(list, [], `${label}：当前视口下不应出现纵向滚动（${list.join(', ')}）`);
  }

  async function checkHome(prefix) {
    await click('#btn-home');
    await until('document.getElementById("home-create-session")?.getBoundingClientRect().width > 0', 'home visible');
    // 「用 API key 开始」卡是异步画出来的：等它出现（最多 15 秒），没出现就只测滚动。
    await until('[...document.querySelectorAll("#community-setup button")].some(x=>/保存并继续/.test(x.textContent))', 'api key card', 15000).catch(() => {});
    await sleep(600);
    await shot(prefix + '01-home');
    await noScroll(prefix + 'home', '#empty-state');
    const save = await cdp.eval(`(()=>{const b=[...document.querySelectorAll('#community-setup button')].find(x=>/保存并继续/.test(x.textContent));if(!b)return 'none';const r=b.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0?'in':'out '+Math.round(r.top);})()`);
    report.measures[prefix + 'homeSaveButton'] = save;
    if (save !== 'none') assert.equal(save, 'in', '主页「保存并继续」在首屏内');
    report.checks.push(`${prefix || '浅色 '}主页：不滚动，「保存并继续」${save === 'in' ? '在首屏' : '本环境未出现'}`);
  }

  async function checkLauncher(prefix) {
    await click('#btn-home');
    await until('document.getElementById("home-create-session")?.getBoundingClientRect().width > 0', 'home visible');
    await sleep(300);
    await click('#home-create-session');
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'launch center open');
    await sleep(1200);
    await shot(prefix + '02-launch-center');
    await noScroll(prefix + 'launch', '#new-session-menu');
    assert.ok(await cdp.eval(IN_VIEW('#new-session-submit')), '「创建会话」在首屏');
    const toggle = await cdp.eval('(()=>{const b=document.getElementById("new-session-more-toggle");return b&&!b.hidden?{expanded:b.getAttribute("aria-expanded"),summary:b.textContent}:null})()');
    report.measures[prefix + 'moreToggle'] = toggle;
    assert.ok(toggle, '「更多选项」显示');
    assert.equal(toggle.expanded, 'false', '默认收起');
    assert.match(toggle.summary, /权限模式/, '收起时摘要里写着权限模式');
    await click('#new-session-more-toggle');
    await until('document.getElementById("new-session-permission-field").getBoundingClientRect().height > 0', 'permission shown after expand');
    await shot(prefix + '02b-launch-more-open');
    await click('#new-session-cancel');
    await sleep(500);
    await click('#home-create-session');
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'launch center reopen');
    await sleep(800);
    assert.equal(await cdp.eval('document.getElementById("new-session-more-toggle").getAttribute("aria-expanded")'), 'true', '重开启动中心保留展开');
    // 展开后允许滚动；重开保留展开时，先像用户一样滚到「收起」所在位置。
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1000, y: 700, deltaY: 600, deltaX: 0 });
    await until(IN_VIEW('#new-session-more-toggle'), 'expanded launcher toggle visible');
    await click('#new-session-more-toggle');
    await click('#new-session-cancel');
    await click('#home-create-session');
    await until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', 'launch center collapsed reopen');
    assert.equal(await cdp.eval('document.getElementById("new-session-more-toggle").getAttribute("aria-expanded")'), 'false', '收起后重开保留收起');
    await noScroll(prefix + 'launchReopen', '#new-session-menu');
    await click('#new-session-cancel');
    await sleep(400);
    report.checks.push(`${prefix || '浅色 '}启动中心：不滚动，创建按钮在首屏；「更多选项」摘要含权限模式，展开 / 收起后重开保留状态`);
  }

  async function openSettings() {
    await click('#btn-options');
    await until('document.getElementById("options-settings")?.getBoundingClientRect().width > 0', 'options menu');
    await click('#options-settings');
    await until('!document.getElementById("config-modal").classList.contains("hidden") && !document.getElementById("config-save").disabled', 'settings open');
    await sleep(600);
  }

  async function checkSettings(prefix) {
    await openSettings();
    const tabs = await cdp.eval('[...document.querySelectorAll("#cfg-tabs [data-cfg-tab-btn]")].filter(b=>!b.hidden).map(b=>b.dataset.cfgTabBtn)');
    report.measures[prefix + 'settingsTabs'] = tabs;
    assert.ok(tabs.length >= 3, '设置分成至少 3 个页签');
    // 2026-11-22：「高级」溢出过一次没被发现，这几个页签必须都在、都量到。
    for (const must of ['general', 'display', 'pet', 'advanced', 'server']) assert.ok(tabs.includes(must), `设置页签「${must}」在`);
    for (const tab of tabs) {
      await click(`#cfg-tab-${tab}`);
      await sleep(300);
      await shot(`${prefix}09-settings-${tab}`);
      await noScroll(`${prefix}settings-${tab}`, '#config-modal');
      assert.ok(await cdp.eval(IN_VIEW('#config-save')), `设置「${tab}」页签：保存按钮在首屏`);
      const height = await cdp.eval('Math.round(document.querySelector("#config-modal .config-modal-content").getBoundingClientRect().height)');
      report.measures[`${prefix}settings-${tab}-height`] = height;
    }
    report.checks.push(`${prefix || '浅色 '}设置：${tabs.length} 个页签各一屏，保存按钮都在首屏`);
    await click('#config-close');
    await sleep(400);
  }

  async function launch() {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'one-screen', extraEnv: env, windowMode: 'hidden' });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }

  async function checkRooms(prefix) {
    const tabs = await cdp.eval('[...document.querySelectorAll(".cr-top [data-cr-tab]")].map(b=>b.dataset.crTab)');
    assert.deepEqual(tabs, ['overview', 'plan', 'post', 'history', 'logs', 'settings']);
    for (const tab of tabs) {
      await click(`.cr-top [data-cr-tab="${tab}"]`);
      await sleep(300);
      await noScroll(`${prefix}rooms-${tab}`, '.cr-sheet');
      if (['plan', 'post', 'settings'].includes(tab)) assert.ok(await cdp.eval(IN_VIEW('[data-cr-op="save"]')), `${tab} 保存按钮在首屏`);
      if (tab === 'settings') {
        const fields = await cdp.eval('[...document.querySelectorAll("[data-cr-settings-panel] [data-cr-field]")].map(e=>e.dataset.crField)');
        assert.equal(fields.length, 14, '保留全部设置控件');
        for (const group of ['booking', 'computer', 'page', 'data']) {
          await click(`[data-cr-settings-tab="${group}"]`);
          await sleep(150);
          assert.equal(await cdp.eval('document.querySelectorAll("[data-cr-settings-panel]:not([hidden])").length'), 1);
          assert.ok(await cdp.eval(IN_VIEW(`[data-cr-settings-panel="${group}"]`)), `${group} 设置分组完整可见`);
          await noScroll(`${prefix}rooms-settings-${group}`, '.cr-sheet');
          const remaining = await cdp.eval('[...document.querySelectorAll("[data-cr-settings-panel] [data-cr-field]")].map(e=>e.dataset.crField)');
          assert.deepEqual(remaining, fields, '切换分组保留所有设置控件');
          await shot(`${prefix}17-rooms-settings-${group}`);
        }
        await click('[data-cr-settings-tab="booking"]');
      }
      await shot(`${prefix}17-rooms-${tab}`);
    }
    report.checks.push(`${prefix}会议室：六个子页签及四组设置均无纵向滚动，设置控件完整保留`);
  }

  try {
    await launch();
    await until('typeof window.__hubOpenConfigModal === "function"', 'renderer ready', 60000);

    await checkHome('');
    await checkLauncher('');
    await checkSettings('');
    // 公司黄区笔记本 2560×1600、240% 缩放，逻辑分辨率约 1024×640：设置每个页签同样一屏。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await checkSettings('small-1024x640-');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);

    // 通知 / 监控入口经过异步观察器后仍在目标页签，定时聚焦也落到可见字段。
    const notificationEnabled = await cdp.eval('require("../core/distribution").featureEnabled("completionNotification")');
    if (!notificationEnabled) report.checks.push('本发行版关闭通知功能：通知入口及接收 ID 校验由单测覆盖');
    for (const [option, tab, field] of [
      ['notificationSetup', 'notify', 'cfg-feishu-target'],
      ['operationsSetup', 'server', 'cfg-aliyun-health-url'],
    ]) {
      if (tab === 'notify' && !notificationEnabled) continue;
      await cdp.eval(`window.__hubOpenConfigModal({${option}:true})`);
      await until(`window.__hubSettingsTabs.active === '${tab}' && document.activeElement.id === '${field}'`, option);
      assert.ok(await cdp.eval(IN_VIEW('#' + field)), `${option} 目标字段可见`);
      await click('#config-close');
    }
    report.checks.push(`${notificationEnabled ? '通知 / 监控' : '监控'}入口：异步观察器后目标页签和焦点保留`);

    for (const [field, value, enabled, tab] of [
      ['cfg-feishu-target', 'wrong', null, 'notify'],
      ['cfg-feishu-target', '', 'cfg-notification-enabled', 'notify'],
      ['cfg-aliyun-health-url', 'wrong', 'cfg-aliyun-enabled', 'server'],
    ]) {
      if (tab === 'notify' && !notificationEnabled) continue;
      await openSettings();
      await cdp.eval(`document.getElementById('${field}').value = ${JSON.stringify(value)}; ${enabled ? `document.getElementById('${enabled}').checked = true;` : ''} window.__hubSettingsTabs.activate('general');`);
      await click('#config-save');
      await until(`window.__hubSettingsTabs.active === '${tab}' && document.activeElement.id === '${field}' && document.getElementById('config-save-msg').classList.contains('error')`, 'validation ' + field);
      assert.ok(await cdp.eval(IN_VIEW('#' + field)), '校验失败的字段显示在首屏');
      await click('#config-close');
    }
    report.checks.push(`设置保存：${notificationEnabled ? '三种非法配置' : '非法监控 URL'}跳到目标页签、聚焦字段并显示错误`);

    // 设置项一个不少；搜索跳到别的页签里的项
    await openSettings();
    const ids = staticSettingIds();
    const missing = await cdp.eval(`${JSON.stringify(ids)}.filter(id=>!document.getElementById(id))`);
    assert.deepEqual(missing, [], '设置项 id 都还在');
    report.checks.push(`设置：index.html 里 ${ids.length} 个设置项 id 都还在页面上`);
    await click('#hub-feature-search-input');
    await cdp.send('Input.insertText', { text: '回车' });
    await until('!document.querySelector(".hub-feature-search-list").hidden', 'search results');
    await key('Enter', 13);
    await until('document.getElementById("cfg-composer-enter").getBoundingClientRect().height > 0', 'search jumped to composer enter');
    report.measures.searchJumpTab = await cdp.eval('window.__hubSettingsTabs.active');
    assert.equal(report.measures.searchJumpTab, 'display', '搜「回车」切到「外观与输入」');
    await shot('09-settings-search-jump');
    report.checks.push('设置：搜「回车」按回车，自动切到「外观与输入」并高亮回车键设置');
    await click('#config-close');
    await sleep(400);

    // 会议室
    await click('#btn-company-rooms');
    await until('!!document.querySelector(".cr-side-b") && document.querySelector(".cr-side-b").getBoundingClientRect().height > 0', 'rooms page', 30000);
    await sleep(2500);
    await shot('17-rooms');
    await noScroll('rooms', '.cr-sheet');
    const why = await cdp.eval(`(()=>{const b=document.querySelector('[data-cr-slot="first-use"] [data-cr-op="login"]');if(!b)return {button:false};const w=document.querySelector('[data-cr-slot="login-why"]');return {button:true,disabled:b.disabled,why:w?w.textContent:''};})()`);
    report.measures.roomsLoginWhy = why;
    if (why.button && why.disabled) assert.ok(why.why.length > 0, '第 ① 步登录按钮灰着时写明原因');
    report.checks.push(`会议室：守护栏与内容都不滚动；第 ① 步登录按钮${why.disabled ? `灰着，旁边写着「${why.why}」` : '可用'}`);
    await checkRooms('1440x900-');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await checkRooms('1024x640-');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);

    // 深色主题
    await click('#btn-theme');
    await sleep(600);
    await clickText('深海夜幕', 'body');
    await until('document.documentElement.dataset.theme === "dark"', 'dark theme');
    await key('Escape', 27);
    await sleep(800);
    await checkHome('dark-');
    await checkLauncher('dark-');
    await checkSettings('dark-');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    if (error.logTail) report.launchLog = error.logTail;
    if (cdp) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) { report.teardown = await gracefulQuit(hub).catch(e => e.message); fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: !!report.passed, checks: report.checks, error: report.error ? String(report.error).split('\n')[0] : undefined }, null, 2));
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });

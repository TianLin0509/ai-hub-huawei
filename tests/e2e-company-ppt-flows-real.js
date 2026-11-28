'use strict';
// 真机压测：PPT 页「找页（语义搜索）」「素材 / 团队素材包」「库地图」「做页（一句话三版）」（2026-11-28）。
// 隔离 Hub（隐藏窗口、全新数据目录）+ 真实本机 PPT Doctor 与它已有的索引 + 真实公司 CodeAgent；CDP 鼠标键盘操作。
// 不点「打开」类按钮（会在用户桌面弹 PowerPoint），产物只核对文件。
//   <Hub 程序> 以 ELECTRON_RUN_AS_NODE=1 运行：node tests/e2e-company-ppt-flows-real.js --exe <AI Hub Community.exe> [--out <证据目录>] [--skip-ai]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

delete process.env.ELECTRON_RUN_AS_NODE;
const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const exe = arg('--exe'), skipAi = argv.includes('--skip-ai'), aiOnly = argv.includes('--ai-only'), makeOnly = argv.includes('--make-only');   // --make-only：只跑 F15 一句话三版
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-flows-real-'));
const out = arg('--out') || path.join(root, 'out'), cac = path.join(root, 'cac-home', '.cac'), dataDir = path.join(root, 'data');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const report = { startedAt: new Date().toISOString(), root, checks: [], metrics: {}, screenshots: [], timeline: [] };
const t0 = Date.now();
const save = () => { try { fs.writeFileSync(path.join(out, 'report.json'), j(report, null, 1)); } catch {} };
const log = (msg, extra) => { const line = { s: Math.round((Date.now() - t0) / 1000), msg, ...(extra ? { extra } : {}) }; report.timeline.push(line); console.log(j(line)); save(); };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); log((ok ? '通过 ' : '失败 ') + name, detail); return !!ok; };
let hub, c;
const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return true; await sleep(500); } throw Error('超时：' + label); };
const waitFor = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return true; await sleep(500); } return false; };
const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); const file = path.join(out, name + '.jpg'); fs.writeFileSync(file, Buffer.from(s.data, 'base64')); report.screenshots.push(file); };
const click = async selector => {
  const point = await c.eval(`(() => {const e=document.querySelector(${j(selector)});if(!e)throw Error('找不到 '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
};
const typeInto = async (selector, text) => {
  await c.eval(`(() => { const e = document.querySelector(${j(selector)}); e.focus(); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await click(selector); if (text) await c.send('Input.insertText', { text });
};
const text = sel => c.eval(`(document.querySelector(${j(sel)})?.innerText || '').slice(0, 400)`).catch(() => '');
const scrollOverflow = sel => c.eval(`(() => { const e = document.querySelector(${j(sel)}); if (!e) return null; return { scrollH: document.scrollingElement.scrollHeight, clientH: document.scrollingElement.clientHeight }; })()`).catch(() => null);

function prepare() {
  for (const d of [out, cac, dataDir]) fs.mkdirSync(d, { recursive: true });
  // 根下 ~/.cac.json 放到副本目录旁：CodeAgent 新版模型清单只在那里，Hub 对 *.cac 目录读同级 .cac.json（m1 ff9f96b30；只复制目录会误判「默认模型下线」）。
  try { fs.copyFileSync(path.join(os.homedir(), '.cac.json'), path.join(path.dirname(cac), '.cac.json')); } catch { /* 没有就算了 */ }
  const real = path.join(os.homedir(), '.cac');
  if (fs.existsSync(real)) for (const name of fs.readdirSync(real)) {
    const src = path.join(real, name);
    if (!fs.statSync(src).isFile() || /^history\.jsonl$|\.log$|\.bak|hub-backup|\.(cjs|html)$|^build-asar/i.test(name) || fs.statSync(src).size > 2 * 1024 * 1024) continue;
    fs.copyFileSync(src, path.join(cac, name));
  }
  // 测试用的配置副本里指定一个可用模型，并写 Hub 记的「上次选的模型」——等同用户之前已在换模型卡片里选过它；真实 ~/.cac 不动。
  const wantModel = arg('--codeagent-model');
  if (wantModel) {
    const f = path.join(cac, 'settings.json'); let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    report.codeagentModelFrom = cfg.model || ''; cfg.model = wantModel; fs.writeFileSync(f, JSON.stringify(cfg, null, 2)); report.codeagentModel = wantModel;
    fs.writeFileSync(path.join(dataDir, 'codeagent-last-model.json'), j({ personal: { model: wantModel, at: new Date().toISOString() } }));
  }
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), j({ assistant: true, forum: false }));
}

async function keyword(query, label) {
  await typeInto('[data-ppt-query]', query);
  const t = Date.now();
  await c.eval(`(() => { const n = document.querySelector('[data-ppt-notice]'); if (n) n.textContent = ''; return true; })()`);
  await click('[data-ppt="keyword"]');
  // 检索结束的标志：提示条写出「N 页关键词命中」或结果区写出「本轮没有命中」；结果区里固定的「没经 AI 读页核对」说明不算。
  await waitFor(`/页关键词命中|先输入/.test(document.querySelector('[data-ppt-notice]')?.textContent || '') || /本轮没有命中/.test(document.querySelector('[data-ppt-results]')?.innerText || '')`, 60000);
  await sleep(800);
  const n = await c.eval(`document.querySelectorAll('[data-ppt-result]').length`);
  const r = { query: query.slice(0, 40), label, ms: Date.now() - t, results: n, notice: await text('[data-ppt-notice]'), empty: n ? '' : await text('[data-ppt-results]') };
  (report.metrics.keyword ||= []).push(r); log('关键词 ' + label, r); await shot('f13-' + label).catch(() => {});
  return r;
}

async function main() {
  // 隔离副本会被内源静默升级写回 app.asar，那时实际跑的是原包而不是要测的代码：发现就停，不测。
  if (fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar'))) throw new Error('隔离副本的 resources 下又出现了 app.asar（可能被静默升级写回），实际会跑原包；请先改名或重建副本再测');
  prepare();
  // 不让隔离实例用本机真实 WeLink 登录去拉消息、整理助理（2026-11-28 真机压测踩到：后台读了几百次历史消息并占住 CodeAgent）。
  const welinkStub = path.join(root, 'welink-disabled.js');
  fs.writeFileSync(welinkStub, 'process.stdout.write(JSON.stringify({ authenticated: false, loggedIn: false }));');
  hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'ppt flows real', executablePath: exe,
    entryPath: path.resolve(__dirname, '..'), cwd: path.dirname(exe), extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_WELINK_CLI: welinkStub, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
      AI_HUB_QUIET_UPDATE: '0', AI_HUB_UPDATE_STARTUP_DELAY_MS: String(24 * 3600 * 1000), DEEPSEEK_API_KEY: '' } });
  await require('./helpers/isolation-guard').guardIsolatedHub(hub, root);   // 5 秒内发现用到生产数据目录就只结束这个主进程并报错
  for (let i = 0; !c; i++) { try { c = await connectFirstPage(hub, target => /index\.html/.test(target.url), { waitMainMs: 15000 }); } catch (error) { if (i >= 8) throw error; await sleep(3000); } }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // 账号默认模型在公司侧不可用时，Hub 建会话会弹「新建会话需要换个模型」并等用户选。脚本不替用户点（红队审核：代点会掩盖卡死），
  // 只记下出现的时刻和原文，收尾时记为失败；要测功能本身，请用 --codeagent-model 给测试用的配置副本指定一个可用模型。
  let swapBusy = false;
  const swapTimer = setInterval(async () => {
    if (swapBusy || !c || report.modelSwapCard) return; swapBusy = true;
    try {
      const hit = await c.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '换成它并创建' && x.getBoundingClientRect().width > 0); if (!b) return null; const card = b.closest('[role=dialog], [role=alertdialog], [class*=hmn]') || b.parentElement; return (card?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300); })()`).catch(() => null);
      if (hit) { report.modelSwapCard = { s: Math.round((Date.now() - t0) / 1000), text: hit }; log('出现「新建会话需要换个模型」卡片（未代点）', hit.slice(0, 120)); }
    } finally { swapBusy = false; }
  }, 3000);
  swapTimer.unref?.();
  await until('!!document.getElementById("btn-company-ppt")', 'PPT 入口', 120000);
  report.hubVersion = await c.eval(`require('../package.json').version`).catch(() => null);
  await click('#btn-company-ppt');
  await until('["ready","empty","missing","upgrade","error"].includes(document.querySelector("[data-ppt-status]")?.dataset.state)', 'Doctor 状态', 90000);
  report.doctorStatus = await text('[data-ppt-status]');
  log('Doctor', report.doctorStatus);

  // ---- F13 找页 ----
  if (!aiOnly && !makeOnly) {
  const kws = [['SRS 测量 PMI 精度', 'mixed-cn-en'], ['AI for RRM 调度增益', 'ai-rrm'], ['MU-MIMO 配对', 'mumimo'], ['zqxjv乱码不存在的词9x7', 'no-result']];
  for (const [q, l] of kws) await keyword(q, l);
  const k = report.metrics.keyword;
  check('F13 大库关键词搜索 3 个中英混合查询都有结果且 10 秒内', k.slice(0, 3).every(r => r.results > 0 && r.ms < 10000), k.slice(0, 3).map(r => [r.label, r.results, r.ms]));
  check('F13 无结果时给出明确提示（不白屏）', k[3].results === 0 && /没|无|找不到|换/.test(k[3].notice + k[3].empty), { notice: k[3].notice, empty: k[3].empty });
  await typeInto('[data-ppt-query]', '');
  await click('[data-ppt="keyword"]'); await sleep(1200);
  const emptyNotice = await text('[data-ppt-notice]');
  check('F13 空输入提示先输入内容', /先输入|输入/.test(emptyNotice), emptyNotice);
  await keyword('「」<>&;%$#@!'.repeat(3) + 'x'.repeat(300), 'special-long');
  check('F13 特殊字符+超长输入不报错', !/错误|异常|Error/i.test(report.metrics.keyword.at(-1).notice), report.metrics.keyword.at(-1));
  }
  if (!skipAi && !makeOnly) {
    // 用关键词已确认在库里有命中的主题（「SRS 测量 PMI 精度」30 页、「AI for RRM 调度增益」6 页）
    const aiQueries = (arg('--ai-queries') || '介绍 SRS 测量和 PMI 精度的那页|AI for RRM 调度增益的结果页').split('|');
    report.metrics.aiSearch = [];
    for (const q of aiQueries) {
      await typeInto('[data-ppt-query]', q);
      const t = Date.now();
      await click('[data-ppt-search]');
      // 按钮很快就恢复可点，AI 找页在后台继续：以这一问在 chat.json 里的状态为准，最多等 15 分钟。
      const readChats = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'company-assistant', 'chat.json'), 'utf8')); } catch { return []; } };
      const before = new Set(report.metrics.aiSearch.map(x => x.chatId).filter(Boolean));
      let chat = {}, ok = false;
      const endAi = Date.now() + 15 * 60000;
      while (Date.now() < endAi) {
        const cands = readChats().filter(x => !before.has(x.id) && (x.askedAt || 0) >= t - 5000);
        chat = cands.at(-1) || {};
        if (chat.id && ['done', 'error'].includes(chat.state)) { ok = true; break; }
        await sleep(5000);
      }
      await sleep(3000);
      const trace = (chat.trace?.events || chat.events || []).filter(e => e && e.kind).map(e => ({ kind: e.kind, checked: e.checked, recommended: e.recommended, op: e.op, n: e.count }));
      const m = { query: q, chatId: chat.id, ok, seconds: Math.round((Date.now() - t) / 1000), results: await c.eval(`document.querySelectorAll('[data-ppt-result]').length`), ai: await c.eval(`document.querySelectorAll('[data-ppt-result].is-ai').length`),
        panel: (await text('[data-ppt-results]')).slice(0, 300), chatState: chat.state, chatError: chat.error, pptResults: (chat.pptResults || []).length, answerHead: String(chat.a || chat.agentText || '').slice(0, 1500), trace: trace.slice(-12) };
      report.metrics.aiSearch.push(m); log('AI 找页', { q, seconds: m.seconds, ai: m.ai, pptResults: m.pptResults, chatState: m.chatState });
      await shot('f13-ai-search-' + report.metrics.aiSearch.length).catch(() => {});
      check(`F13 AI 找页「${q}」给出推荐页`, ok && m.ai > 0, { seconds: m.seconds, ai: m.ai, pptResults: m.pptResults, chatState: m.chatState, error: m.chatError });
    }
  }

  if (aiOnly) return;
  if (!makeOnly) {
  // ---- F14 素材 / 团队素材包 ----
  await click('[data-ppt-tab="materials"]');
  await waitFor(`!!document.querySelector('[data-pptm="refresh"], [data-pptm="team-pack"]')`, 30000);
  await sleep(4000);
  const mat = async () => c.eval(`({ items: document.querySelector('[data-pptm-grid]')?.children.length || 0, count: (document.querySelector('.pptm-count')?.innerText || '').slice(0, 60), next: !!document.querySelector('[data-pptm="next"]:not([disabled])'), text: (document.querySelector('.pptm-main')?.innerText || '').slice(0, 300) })`).catch(e => ({ error: String(e) }));
  report.metrics.materialsBefore = await mat(); await shot('f14-materials-first').catch(() => {});
  log('素材首屏', report.metrics.materialsBefore);
  if (await c.eval(`!!document.querySelector('[data-pptm="team-pack"]')`)) {
    const t = Date.now();
    await click('[data-pptm="team-pack"]');
    await waitFor(`/团队素材包 v.* 已就绪|没有完成|失败|连不上|拦下/.test(document.querySelector('[data-ppt-notice]')?.textContent || '')`, 5 * 60000);
    report.metrics.teamPack = { seconds: Math.round((Date.now() - t) / 1000), notice: (await c.eval(`(document.body.innerText.match(/团队素材包[^\\n]{0,80}/) || [''])[0]`)) };
    report.metrics.materialsAfter = await mat(); await shot('f14-team-pack').catch(() => {});
    check('F14 首次一键同步团队素材包（公司内源）成功', /已就绪/.test(report.metrics.teamPack.notice), report.metrics.teamPack);
  } else check('F14 有「团队素材包」入口', false, report.metrics.materialsBefore);
  if (await c.eval(`!!document.querySelector('[data-pptm="next"]:not([disabled])')`)) {
    await click('[data-pptm="next"]'); await sleep(2500);
    report.metrics.materialsPage2 = await mat(); await shot('f14-materials-page2').catch(() => {});
    check('F14 素材很多时能翻页', true, report.metrics.materialsPage2);
  }
  report.metrics.materialsScroll = await scrollOverflow('body');
  // ---- F14 库地图 ----
  await click('[data-ppt-tab="map"]');
  await sleep(6000);
  report.metrics.map = await c.eval(`({ nodes: document.querySelectorAll('[data-pptg="node"]').length, groups: document.querySelectorAll('[data-pptg="group"]').length, build: !!document.querySelector('[data-pptg="build-index"]'), text: (document.querySelector('.pptg-main, [data-ppt-map]')?.innerText || document.body.innerText).slice(0, 300) })`).catch(e => ({ error: String(e) }));
  await shot('f14-map').catch(() => {});
  check('F14 库地图打开有内容或给出建图入口', report.metrics.map.nodes > 0 || report.metrics.map.groups > 0 || report.metrics.map.build, report.metrics.map);

  }

  // ---- F15 做页：一句话三版 ----
  if (!skipAi) {
    await click('[data-ppt-tab="make"]');
    await until(`!!document.querySelector('[data-pptk-brief]')`, '做页', 30000);
    await typeInto('[data-pptk-brief]', '上行 SRS 测量用于下行预编码，三项措施逐级叠加后小区吞吐提升 18%，边缘用户提升 32%');
    const t = Date.now();
    await click('[data-pptk="auto"]');
    const notes = [];
    let first = null, all = null, lastNote = '';
    const end = Date.now() + 15 * 60000;
    while (Date.now() < end) {
      const st = await c.eval(`require('electron').ipcRenderer.invoke('company-assistant:ppt-make-status', {}).catch(() => null)`).catch(() => null);
      const note = (await text('[data-ppt-notice]')) + ' | ' + (await c.eval(`(document.querySelector('.pptk-stage, [data-pptk-stage]')?.innerText || '').slice(0, 160)`).catch(() => ''));
      if (note !== lastNote) { lastNote = note; notes.push({ s: Math.round((Date.now() - t) / 1000), note: note.slice(0, 200) }); }
      const variants = await c.eval(`[...document.querySelectorAll('[data-pptk="variant"]')].map(b => b.innerText.slice(0, 40))`).catch(() => []);
      const doneN = await c.eval(`[...document.querySelectorAll('[data-pptk="variant"]')].filter(b => !/…|✕/.test(b.innerText)).length`).catch(() => 0);
      const errN = await c.eval(`[...document.querySelectorAll('[data-pptk="variant"]')].filter(b => /✕/.test(b.innerText)).length`).catch(() => 0);
      if (variants.length >= 3 && doneN + errN >= 3) { all = errN ? null : Math.round((Date.now() - t) / 1000); report.metrics.makeErrors = errN; break; }
      if (!first && await c.eval(`!!document.querySelector('.pptk-stage svg, [data-pptk-stage] svg, [data-pptk="open"]')`).catch(() => false)) { first = Math.round((Date.now() - t) / 1000); await shot('f15-first').catch(() => {}); }
      if (/没有完成|出错|失败/.test(note) && Date.now() - t > 60000 && !variants.length) break;
      await sleep(3000);
      void st;
    }
    await shot('f15-end').catch(() => {});
    const files = (() => { try { const d = path.join(dataDir, 'company-assistant'); const found = []; const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else if (/\.pptx$/i.test(e.name)) found.push({ f: path.relative(dataDir, f), kb: Math.round(fs.statSync(f).size / 1024) }); } }; walk(d); return found; } catch (e) { return [String(e)]; } })();
    // 逐版核对（2026-11-28 负责人 P1：5 个文件里 3 个几乎相同，查是不是同一版重交）：按方案按钮的 jobId 取每版最后交付的文件、
    // 提交次数与骨架；每次提交（含按自查提醒修改）都会新写一个文件，所以「文件数」不等于「版数」，比较的是各版最终文件。
    const ids = await c.eval(`[...document.querySelectorAll('[data-pptk="variant"]')].map(b => b.dataset.id)`).catch(() => []);
    const versions = [];
    for (const id of ids) {
      const r = await c.eval(`require('electron').ipcRenderer.invoke('company-assistant:ppt-make-status', { jobId: ${JSON.stringify(id)} }).catch(e => ({ error: String(e) }))`).catch(e => ({ error: String(e) }));
      const j = r && r.job || {};
      versions.push({ variant: j.variant, skeleton: j.skeleton, skeletonId: j.skeletonId, state: j.state, rev: j.rev, submits: j.submits, file: j.path ? path.basename(j.path) : '', title: j.spec && String(j.spec.title || '').slice(0, 60), specText: j.spec ? JSON.stringify(j.spec) : '', error: r && r.error });
    }
    const sim = (a, b) => { const g = t => { const m = new Map(); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; }; const A = g(a), B = g(b); let x = 0, n = 0; for (const [k, v] of A) { x += Math.min(v, B.get(k) || 0); n += v; } for (const v of B.values()) n += v; return n ? Math.round(200 * x / n) / 100 : 0; };
    const pairs = [];
    for (let i = 0; i < versions.length; i++) for (let k = i + 1; k < versions.length; k++) pairs.push([versions[i].variant, versions[k].variant, sim(versions[i].specText, versions[k].specText)]);
    const distinctFiles = new Set(versions.map(v => v.file).filter(Boolean)).size, distinctSkel = new Set(versions.map(v => v.skeletonId).filter(Boolean)).size;
    for (const v of versions) delete v.specText;
    report.metrics.make = { firstSeconds: first, allSeconds: all, notes: notes.slice(0, 25), pptx: files.slice(0, 10), versions, versionSimilarity: pairs };
    check('F15 三版是三个不同的方案：各自的最终文件不同、骨架不同、页面说明两两相似度 < 0.9', versions.length >= 3 && distinctFiles === versions.length && distinctSkel === versions.length && pairs.every(x => x[2] < 0.9), { versions, pairs });
    check('F15 一句话 15 分钟内出第一版', first != null, { first });
    check('F15 三版都出来', all != null, { all, notes: notes.slice(-3) });
    check('F15 生成了可编辑 PPTX 文件', files.some(x => typeof x === 'object'), files.slice(0, 5));
  }
}

// 关 Hub：优雅退出失败就记进报告并保留 hub 引用，再只结束这个脚本自己拉起、核实过的主进程（hub.child），不按进程树或进程名收。
async function closeHub(why) {
  if (!hub) return true;
  try { await gracefulQuit(hub); hub = null; return true; }
  catch (e) {
    (report.quitErrors ||= []).push({ why, error: String(e && e.message || e).slice(0, 300) });
    try { if (hub.child && hub.child.pid === hub.pid && hub.child.exitCode == null) hub.child.kill(); } catch (k) { report.quitErrors.push({ why: why + ' kill', error: String(k) }); }
    await sleep(3000);
    if (hub.isAlive && !hub.isAlive()) { hub = null; return false; }
    report.hubLeft = { pid: hub.pid };   // 仍在：报告里写明 PID，交给人工核实后处理
    return false;
  }
}

main().catch(e => { report.error = String(e && e.stack || e); log('出错', report.error); })
  .finally(async () => {
    const closed = await closeHub('收尾');
    report.finishedAt = new Date().toISOString();
    if (report.modelSwapCard) report.checks.push({ name: '没有出现需要用户去点的换模型卡片', ok: false, detail: report.modelSwapCard });
    report.passed = require('./helpers/e2e-verdict').e2ePassed(report, closed);
    save();
    console.log('REPORT ' + path.join(out, 'report.json'));
    process.exit(report.passed ? 0 : 1);
  });

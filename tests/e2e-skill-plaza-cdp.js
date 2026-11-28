'use strict';
// 「技能广场」页真实界面检查：隔离 Hub + 独立 CDP，鼠标点选。
//   默认用界面假数据桩（tests/fixtures/skill-plaza-stub.js，全部自造技能）接管 skill-plaza:* 接口；
//   加 --real 则走主进程真实处理器（要求已合入 core/skill-plaza，并用临时 HOME 下的自造技能目录）。
// 覆盖：入口与互斥、一屏不滚、分类筛选、来源勾选、搜索、详情、需改写勾选门禁、一键导入与移除后的状态变化、
//   委托档、员工助手没装时的灰字说明；冷白与深色主题各截图（1440×900）。
// 用法：node tests/e2e-skill-plaza-cdp.js [输出目录] [--real]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { installSource } = require('./fixtures/skill-plaza-stub');
const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const REAL = args.includes('--real');
const out = path.resolve(args.find(a => !a.startsWith('--')) || 'artifacts/skill-plaza-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-plaza-')), dataDir = path.join(root, 'data'), home = path.join(root, 'home');
  fs.mkdirSync(dataDir); fs.mkdirSync(home);
  // 真实模式的自造夹具：员工助手三档各一个 + Claude 已装一个；CodeAgent、Claude 两个目标在，Codex 那一家不在。
  const skill = (dir, name, description, body = '') => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${name}
description: ${description}
---
${body}
`); };
  if (REAL) {
    const wc = path.join(home, '.config', 'weclaw', 'opencode', 'skills');
    skill(path.join(wc, 'demo-doc-proof'), 'demo-doc-proof', 'Word 文档校对，检查错别字并输出报告', '按段落检查。');
    skill(path.join(wc, 'demo-meeting-notes'), 'demo-meeting-notes', '会议纪要与逐字稿整理', '运行 weclaw-cli meeting list 取会议。');
    skill(path.join(wc, 'skill-todo-worker'), 'skill-todo-worker', '待办执行助手', '在员工助手里执行待办。');
    skill(path.join(home, '.claude', 'skills', 'demo-sim'), 'demo-sim', '仿真作业：改配置、提交并取回结果');
    skill(path.join(home, '.cac', 'skills', 'demo-review'), 'demo-review', '代码审查：按团队规范审查改动');
  }
  const result = { passed: false, mode: REAL ? 'real' : 'stub', testRoot: root, checks: [], shots: [] };
  let hub, c;
  const stop = async () => { if (hub) { result.teardown = await gracefulQuit(hub); hub = null; } if (c) { await c.close(); c = null; } };
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'skill-plaza', extraEnv: {
      // 真实模式不给 CLAUDE_HUB_SKILL_PLAZA_WECLAW：隔离环境里没有员工助手主程序（同「装在自选目录、默认位置认不出」），只凭技能目录也要列出（2026-11-28 反馈）
      ...(REAL ? { CLAUDE_HUB_HOME_DIR: home, AI_HUB_CODEAGENT_CONFIG_DIR: path.join(home, '.cac') } : {}),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline test' }, foreign: { ok: false, error: 'offline test' } }),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(`(()=>{try{return !!(${expr})}catch{return false}})()`).catch(() => false)) return; await _waitMs(120); } throw Error('Timeout: ' + expr); };
    const click = async selector => {
      const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      if (!point) throw Error('找不到 ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const shot = async name => { await _waitMs(250); const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name + '.png'); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); };
    const cards = () => c.eval(`[...document.querySelectorAll('#skill-plaza-page .spz-card')].map(e=>e.dataset.id)`);
    const typeSearch = async text => { await c.eval(`(()=>{const i=document.querySelector('#skill-plaza-page .spz-search');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}))})()`); };
    const ready = `!!document.getElementById('btn-skill-plaza') && typeof window.__skillPlazaShow==='function'`;
    const openPlaza = async () => {
      await until(ready);
      if (!REAL) await c.eval(installSource());
      // 「广场」在规则组里，悬停展开后再点
      await c.eval(`document.getElementById('btn-rail-group-rules')?.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}))`);
      await _waitMs(300);
      const visible = await c.eval(`(()=>{const b=document.getElementById('btn-skill-plaza');return b.offsetWidth>0&&!b.closest('[hidden]')})()`);
      if (visible) await click('#btn-skill-plaza'); else await c.eval(`document.getElementById('btn-skill-plaza').click()`);
      await until(`!!document.querySelector('#skill-plaza-page:not([hidden]) .spz-card')`);
    };

    await openPlaza();
    const scroll = await c.eval(`(()=>{const p=document.querySelector('#skill-plaza-page .spz-root');const g=document.querySelector('#skill-plaza-page .spz-grid');return{fits:p.scrollHeight<=p.clientHeight+1&&g.scrollHeight<=g.clientHeight+1,cur:document.getElementById('btn-skill-plaza').getAttribute('aria-current')}})()`);
    assert.ok(scroll.fits, '一屏不滚');
    result.checks.push(`打开：入口在规则组，页面一屏不滚，左栏当前项=${scroll.cur || '无'}`);
    await shot('20261127-skill-plaza-1-codex-all');

    if (!REAL) {
      // 分页
      const pager = await c.eval(`document.querySelector('#skill-plaza-page .spz-pager').textContent`);
      result.checks.push('分页：' + pager.trim());
      // 分类筛选
      await click('#skill-plaza-page [data-cat="ppt"]');
      let ids = await cards();
      assert.deepEqual(ids.sort(), ['local:demo-ppt-check', 'weclaw:demo-slide-factory']);
      result.checks.push('分类「PPT」只剩 2 张卡');
      await click('#skill-plaza-page [data-cat="mine"]');
      ids = await cards(); assert.equal(ids.length, 3); assert.ok(ids.every(i => i.startsWith('local:')));
      result.checks.push('分类「我已装的」= 本机 3 个');
      await click('#skill-plaza-page [data-cat="all"]');
      // 来源勾选
      await click('#skill-plaza-page [data-spz-source="weclaw"]');
      ids = await cards(); assert.ok(ids.length > 0 && ids.every(i => !i.startsWith('weclaw:')));
      result.checks.push(`取消勾选「员工助手」后剩 ${ids.length} 张，无员工助手卡`);
      await click('#skill-plaza-page [data-spz-source="weclaw"]');
      // 搜索
      await typeSearch('纪要');
      ids = await cards(); assert.deepEqual(ids, ['weclaw:demo-meeting-notes']);
      result.checks.push('搜索「纪要」只剩「会议纪要与逐字稿」');
      // 需改写：详情 + 勾选门禁
      await click('#skill-plaza-page .spz-card[data-id="weclaw:demo-meeting-notes"] [data-spz="detail"]');
      await until(`!!document.querySelector('#skill-plaza-page .spz-drawer:not([hidden]) .spz-map')`);
      const gate0 = await c.eval(`document.querySelector('#skill-plaza-page .spz-drawer [data-spz="import"]').disabled`);
      assert.equal(gate0, true, '没勾确认前导入按钮不可点');
      const greyed = await c.eval(`document.querySelector('#skill-plaza-page .spz-drawer [data-target="agents"]').disabled`);
      assert.equal(greyed, true, '没装的目标置灰');
      const layout = await c.eval(`(()=>{const d=document.querySelector('#skill-plaza-page .spz-drawer').getBoundingClientRect();const cs=[...document.querySelectorAll('#skill-plaza-page .spz-card, #skill-plaza-page .spz-pager > *')].map(e=>e.getBoundingClientRect().right);return{drawerLeft:Math.round(d.left),maxRight:Math.round(Math.max(...cs))}})()`);
      assert.ok(layout.maxRight <= layout.drawerLeft, '抽屉不压卡片和分页：' + JSON.stringify(layout));
      const leak = await c.eval(`(()=>{const t=document.querySelector('#skill-plaza-page .spz-drawer').innerText;return /\\b(name|description|license)\\b/.test(t)})()`);
      assert.equal(leak, false, '详情不露英文键名');
      result.checks.push('详情抽屉让位：卡片与分页都在抽屉左边；详情不露英文键名');
      await shot('20261127-skill-plaza-2-codex-detail-fix');
      await click('#skill-plaza-page .spz-drawer [data-spz-ack]');
      await until(`document.querySelector('#skill-plaza-page .spz-drawer [data-spz="import"]')?.disabled===false`);
      result.checks.push('需改写：详情有对照表与迁移说明；没勾「我知道导入后需要改写」时导入不可点，勾上后可点；没装的目标置灰');
      await click('#skill-plaza-page .spz-drawer [data-spz="import"]');
      await until(`/已导入/.test(document.querySelector('#skill-plaza-page .spz-drawer .spz-line')?.textContent||'')`);
      const call = await c.eval(`window.__spzStub.calls.filter(x=>x.op==='import').pop()`);
      assert.equal(call.payload.acknowledgeRewrite, true); assert.deepEqual(call.payload.targets.sort(), ['claude', 'codeagent']);
      await until(`document.querySelector('#skill-plaza-page .spz-card[data-id="weclaw:demo-meeting-notes"]')?.dataset.use==='installed'`);
      const where = await c.eval(`document.querySelector('#skill-plaza-page .spz-drawer .spz-db').innerText`);
      assert.match(where, /已装到\s*CodeAgent、Claude/);
      const forced = await c.eval(`window.__spzStub.calls.filter(x=>x.op==='list').pop()?.payload?.refresh===true`);
      assert.ok(forced, '导入后强制重扫');
      result.checks.push('导入：入参带确认标记、装到 CodeAgent 与 Claude；之后强制重扫；卡片变「已导入」，详情写「已装到 CodeAgent、Claude」');
      await shot('20261127-skill-plaza-3-codex-imported');
      // 移除
      await click('#skill-plaza-page .spz-drawer [data-spz="remove"]');
      await until(`document.querySelector('#skill-plaza-page .spz-card[data-id="weclaw:demo-meeting-notes"]')?.dataset.use==='fix'`);
      result.checks.push('移除：卡片回到「需改写」');
      await click('#skill-plaza-page [data-spz="close-detail"]');
      // 直接用：卡片上一键导入
      await typeSearch('');
      await click('#skill-plaza-page .spz-card[data-id="weclaw:demo-doc-proof"] [data-spz="import"]');
      await until(`document.querySelector('#skill-plaza-page .spz-card[data-id="weclaw:demo-doc-proof"]')?.dataset.use==='installed'`);
      const noteHidden = await c.eval(`document.querySelector('#skill-plaza-page .spz-note').hidden`);
      assert.equal(noteHidden, true, '成功只弹提示，页首不重复');
      const total = await c.eval(`({btn:document.querySelector('#skill-plaza-page [data-spz="rescan"]').textContent,all:document.querySelector('#skill-plaza-page [data-cat="all"] em').textContent})`);
      assert.ok(total.btn.includes(`（${total.all}）`), '重扫按钮数字=总数 ' + JSON.stringify(total));
      result.checks.push(`直接用：卡片上一键导入，只弹提示、页首不重复；重扫按钮「${total.btn}」与总数一致`);
      // 委托档
      await typeSearch('工时');
      await click('#skill-plaza-page .spz-card[data-id="weclaw:demo-timesheet"]');
      await until(`!!document.querySelector('#skill-plaza-page .spz-drawer [data-spz="delegate"]')`);
      const delegateNoImport = await c.eval(`!document.querySelector('#skill-plaza-page .spz-drawer [data-spz="import"]')`);
      assert.ok(delegateNoImport);
      const dtext = await c.eval(`document.querySelector('#skill-plaza-page .spz-drawer').innerText`);
      assert.ok(!/导入前后对照|目录名|不影响导入/.test(dtext) && /为什么交给员工助手/.test(dtext) && /会怎样/.test(dtext), '委托档详情只讲为什么和会怎样');
      await shot('20261127-skill-plaza-4-codex-detail-delegate');
      await click('#skill-plaza-page .spz-drawer [data-spz="delegate"]');
      await until(`/复制建议提示词/.test(document.querySelector('#skill-plaza-page .spz-drawer .spz-line')?.textContent||'')`);
      result.checks.push('委托档：详情只有「委托给员工助手」，没有导入；点后一行提示已复制提示词');
      await click('#skill-plaza-page [data-spz="close-detail"]'); await typeSearch('');
      // 员工助手没装
      await c.eval(`window.__spzStub.weclawPresent=false`);
      await click('#skill-plaza-page [data-spz="rescan"]');
      await until(`!document.querySelector('#skill-plaza-page .spz-tip').hidden`);
      const noWeclaw = await c.eval(`({src:!!document.querySelector('#skill-plaza-page [data-spz-source="weclaw"]'),tip:document.querySelector('#skill-plaza-page .spz-tip').textContent})`);
      assert.equal(noWeclaw.src, false);
      result.checks.push('员工助手没装：来源里没有员工助手，页首灰字说明怎么获得更多技能');
      await shot('20261127-skill-plaza-5-codex-no-weclaw');
      // 一路失败不拖垮整个广场：本机已装读失败 → 页首一行红字带「重试」，员工助手与 AgentCenter 卡片照常；点重试恢复
      await c.eval(`window.__spzStub.weclawPresent=true; window.__spzStub.fail={local:'读本机各家 AI 的技能超过 25 秒没读完'}`);
      await click('#skill-plaza-page [data-spz="rescan"]');
      await until(`!!document.querySelector('#skill-plaza-page .spz-tip:not([hidden]) .spz-tl.bad[data-source="local"]')`);
      const partial = await c.eval(`({cards:document.querySelectorAll('#skill-plaza-page .spz-card').length,weclaw:!!document.querySelector('#skill-plaza-page .spz-card[data-source="weclaw"]'),text:document.querySelector('#skill-plaza-page .spz-tl.bad').innerText,fits:(()=>{const p=document.querySelector('#skill-plaza-page .spz-root');return p.scrollHeight<=p.clientHeight+1})()})`);
      assert.ok(partial.weclaw && partial.cards > 0 && /没读到/.test(partial.text) && /重试/.test(partial.text) && partial.fits, JSON.stringify(partial));
      await shot('20261128-skill-plaza-8-one-source-failed');
      await c.eval(`window.__spzStub.fail={}`);
      await click('#skill-plaza-page .spz-tl.bad [data-spz="rescan"]');
      await until(`document.querySelector('#skill-plaza-page .spz-tip').hidden && !!document.querySelector('#skill-plaza-page .spz-card[data-source="local"]')`);
      result.checks.push('一路失败：本机已装读失败时页首一行原因 + 「重试」，员工助手等其余卡片照常、一屏不滚；点「重试」恢复');
      await c.eval(`window.__spzStub.weclawPresent=false`);
      await click('#skill-plaza-page [data-spz="rescan"]');
      await until(`!document.querySelector('#skill-plaza-page .spz-tip').hidden`);
      // 主进程发 skill-plaza:changed：界面强制重扫（这里用员工助手「装上」来看出变化）
      await c.eval(`window.__spzStub.weclawPresent=true`);
      await c.eval(`require('electron').ipcRenderer.emit('skill-plaza:changed', {}, {})`);
      await until(`document.querySelector('#skill-plaza-page .spz-tip').hidden && !!document.querySelector('#skill-plaza-page [data-spz-source="weclaw"]')`);
      assert.equal(await c.eval(`window.__spzStub.calls.filter(x=>x.op==='list').pop()?.payload?.refresh===true`), true);
      result.checks.push('收到 skill-plaza:changed 后强制重扫，列表跟着变');
    }
    if (REAL) {
      const W = 'weclaw:';
      const card = n => `#skill-plaza-page .spz-card[data-id="${n}"]`;
      await until(`!!document.querySelector('${card(W + 'demo-meeting-notes')}')`);
      const uses = await c.eval(`Object.fromEntries([...document.querySelectorAll('#skill-plaza-page .spz-card')].map(e=>[e.dataset.id,e.dataset.use]))`);
      result.uses = uses;
      assert.equal(uses[W + 'demo-doc-proof'], 'ok'); assert.equal(uses[W + 'demo-meeting-notes'], 'fix'); assert.equal(uses[W + 'skill-todo-worker'], 'delegate');
      assert.equal(uses['local:demo-sim'], 'installed');
      assert.equal(uses['local:demo-review'], 'installed', 'CodeAgent 已装技能出现在本机已装');
      result.checks.push('真实扫描：员工助手三档（直接用/需改写/交员工助手执行）与本机已装（Claude、CodeAgent 各 1 个）都正确显示');
      assert.ok(await c.eval(`!!document.querySelector('#skill-plaza-page [data-spz-source="weclaw"]') && document.querySelector('#skill-plaza-page .spz-tip').hidden`), '主程序认不出时员工助手来源照样在、不提示没找到');
      result.checks.push('主程序路径认不出（隔离环境没有员工助手主程序）：只凭技能目录照样列出员工助手来源，页首不报「没找到」');
      await typeSearch('纪要');
      assert.deepEqual(await cards(), [W + 'demo-meeting-notes']);
      await click(`${card(W + 'demo-meeting-notes')} [data-spz="detail"]`);
      await until(`!!document.querySelector('#skill-plaza-page .spz-drawer:not([hidden]) .spz-map')`);
      assert.equal(await c.eval(`document.querySelector('#skill-plaza-page .spz-drawer [data-spz="import"]').disabled`), true);
      assert.equal(await c.eval(`document.querySelector('#skill-plaza-page .spz-drawer [data-target="agents"]').disabled`), true);
      const realText = await c.eval(`document.querySelector('#skill-plaza-page .spz-drawer').innerText`);
      assert.ok(!/\b(name|description|license)\s*[：:]/.test(realText) && !/^\s*(name|description)\s*$/m.test(realText), '真实详情不露英文键名');
      result.checks.push('真实详情：对照表与迁移说明不露英文键名');
      await shot('20261127-skill-plaza-real-1-detail-fix');
      await click('#skill-plaza-page .spz-drawer [data-spz-ack]');
      await until(`document.querySelector('#skill-plaza-page .spz-drawer [data-spz="import"]')?.disabled===false`);
      await click('#skill-plaza-page .spz-drawer [data-spz="import"]');
      await until(`document.querySelector('${card(W + 'demo-meeting-notes')}')?.dataset.use==='installed'`);
      const dirs = ['.claude/skills', '.cac/skills'].map(d => path.join(home, d, 'weclaw-demo-meeting-notes'));
      for (const d of dirs) { assert.ok(fs.existsSync(path.join(d, 'SKILL.md')), d); assert.ok(fs.existsSync(path.join(d, '_origin.json')), d); }
      result.importLine = await c.eval(`document.querySelector('#skill-plaza-page .spz-drawer .spz-line')?.textContent||''`);
      result.checks.push('真实导入（需改写）：勾确认后装进 Claude 与 CodeAgent 两处，带 _origin.json；卡片变已导入。提示：' + result.importLine);
      await shot('20261127-skill-plaza-real-2-imported');
      await click('#skill-plaza-page .spz-drawer [data-spz="remove"]');
      await until(`document.querySelector('${card(W + 'demo-meeting-notes')}')?.dataset.use==='fix'`);
      for (const d of dirs) assert.ok(!fs.existsSync(d), '移除后目录不在：' + d);
      result.checks.push('真实移除：两处目录删干净，卡片回到需改写');
      await click('#skill-plaza-page [data-spz="close-detail"]'); await typeSearch('');
      await click(`${card(W + 'demo-doc-proof')} [data-spz="import"]`);
      await until(`document.querySelector('${card(W + 'demo-doc-proof')}')?.dataset.use==='installed'`);
      assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'weclaw-demo-doc-proof', 'SKILL.md')));
      result.checks.push('真实一键导入（直接用）：卡片上点导入即装好');
      await click(card(W + 'skill-todo-worker'));
      await until(`!!document.querySelector('#skill-plaza-page .spz-drawer [data-spz="delegate"]')`);
      assert.ok(await c.eval(`!document.querySelector('#skill-plaza-page .spz-drawer [data-spz="import"]')`));
      result.checks.push('委托档：详情只有「委托给员工助手」（不点，避免写系统剪贴板、拉起员工助手）');
      await click('#skill-plaza-page [data-spz="close-detail"]');
      await click(`${card('local:demo-sim')} [data-spz="manage"]`);
      await until(`!document.getElementById('hub-workspace').hidden && document.getElementById('skill-plaza-page').hidden`);
      result.checks.push('本机已装「管理」：打开「资源 → 工具」，广场收起');
      await openPlaza();
    }
    // 互斥：点「规则」后广场收起
    await c.eval(`document.getElementById('btn-rules').click()`);
    await until(`document.getElementById('skill-plaza-page').hidden`);
    result.checks.push('互斥：打开「规则」后广场自动收起');
    // Ctrl+K 那样代点入口（el.click()）：主页、账号
    for (const id of ['btn-home', 'btn-rail-accounts']) {
      await openPlaza();
      await c.eval(`document.getElementById(${JSON.stringify(id)}).click()`);
      await until(`document.getElementById('skill-plaza-page').hidden`);
    }
    // 只改自己显隐、不挂 body 类名的面板（以进展页为例）
    await openPlaza();
    await c.eval(`(()=>{const p=document.getElementById('progress-panel');if(p){p.hidden=false;p.style.display='flex';}})()`);
    if (await c.eval(`!!document.getElementById('progress-panel')`)) {
      await until(`document.getElementById('skill-plaza-page').hidden`);
      await c.eval(`(()=>{const p=document.getElementById('progress-panel');p.style.display='none';})()`);
    }
    result.checks.push('Ctrl+K 式代点「主页」「账号」、只改显隐的面板打开时，广场都会收起');

    // 深色主题
    await c.eval(`localStorage.setItem('hub.theme','dark')`);
    await c.send('Page.reload', {});
    await until(`document.documentElement.dataset.theme==='dark'`);
    await openPlaza();
    await shot('20261127-skill-plaza-6-dark-all');
    const tones = await c.eval(`(()=>{const a=document.querySelector('#skill-plaza-page .spz-tag.s-weclaw'),b=document.querySelector('#skill-plaza-page .spz-use.b');return a&&b?[getComputedStyle(a).color,getComputedStyle(b).color]:null})()`);
    if (tones) { assert.notEqual(tones[0], tones[1], '深色下来源标签与委托档分开配色'); result.checks.push('深色：「员工助手」标签与「交员工助手执行」颜色不同 ' + tones.join(' / ')); }
    if (!REAL) {
      await typeSearch('汇报页工厂');
      await click('#skill-plaza-page .spz-card[data-id="weclaw:demo-slide-factory"]');
      await until(`!!document.querySelector('#skill-plaza-page .spz-drawer:not([hidden]) .spz-map')`);
      await shot('20261127-skill-plaza-7-dark-detail-fix');
    }
    result.checks.push('深色主题截图');
    await c.eval(`localStorage.removeItem('hub.theme')`);
    result.passed = true;
  } catch (error) {
    result.error = error.stack; result.logTail = error.logTail; process.exitCode = 1;
    if (c) try { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(s.data, 'base64')); } catch {}
  } finally { await stop(); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: result.passed, mode: result.mode, checks: result.checks.length, error: result.error?.split('\n')[0] })); }
})();

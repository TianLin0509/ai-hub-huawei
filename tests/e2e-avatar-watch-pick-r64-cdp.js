'use strict';
// R64「盯消息只盯几个群」真实界面检查：隔离数据目录 + 假 welink-cli + 合成的 30 个群，不登录、不碰真实 WeLink。
//   第一轮：全新用户建「帮我盯消息」→ 默认「只盯选中的」、已替他选上 3 个最近 @过他 / 消息多的群 → 搜索找群、增删 → 创建，配置写成白名单。
//   第二轮：升级前建的「全部会话」盯消息分身 → 范围页写清盯了哪些 → 一键改成只盯几个，替他先选上建议的群。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const D = require('../core/company-assistant/data');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/avatar-watch-pick-r64');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const ME = 'user001', h16 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const NAMES = ['项目周会群', '午饭拼单群', '版本发布群', '工具用户群', '算法讨论群', '读书会', '羽毛球群', '项目评审群', '值班群', '部门通知群'];

function seedSnapshot(dataDir, now) {
  let n = 0;
  const m = (conv, name, account, text, ago, extra = {}) => ({ sourceId: `msg:${conv}:${++n}`, conv, convName: name, key: String(n), at: now - ago * 60000, sender: name, account, mine: account === ME, atMe: false, text, contentType: 'TEXT_MSG', displayTime: '', preview: text, ...extra });
  const groups = Array.from({ length: 30 }, (_, i) => ({ id: `g${String(i + 1).padStart(3, '0')}`, name: `${NAMES[i % NAMES.length]}${i >= NAMES.length ? Math.floor(i / NAMES.length) + 1 : ''}`, group: true }));
  const people = [['c001', '同事甲'], ['c002', '同事乙'], ['b001', '上级甲']].map(([id, name]) => ({ id, name, group: false }));
  const snap = { at: now - 120000, day: D.dayKey(now), login: { ok: true, uid: ME }, conversations: [...groups, ...people], messages: {}, meetings: [], calendar: [], mails: [], errors: [] };
  // g005 被 @ 3 次、g012 被 @ 1 次；g002（午饭拼单群）消息最多但没 @——默认起点应是 g005、g012、g002。
  snap.messages.g005 = [1, 2, 3].map(k => m('g005', groups[4].name, 'c002', `@我 帮忙看下第 ${k} 项`, 30 - k, { atMe: true }));
  snap.messages.g012 = [m('g012', groups[11].name, 'c001', '@我 明天评审', 20, { atMe: true })];
  snap.messages.g002 = Array.from({ length: 8 }, (_, k) => m('g002', groups[1].name, 'c001', `拼单 ${k}`, 50 - k));
  snap.messages.g001 = [m('g001', groups[0].name, 'c001', '周会改到下午', 60)];
  const dir = path.join(dataDir, 'company-assistant'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `raw-${snap.day}.json`), JSON.stringify(snap));
  return snap;
}
function seedLegacy(dataDir, now, snap) {
  const root = path.join(dataDir, 'avatar', h16(ME)); fs.mkdirSync(root, { recursive: true });
  const av = { id: 'vw', tpl: 'watch', name: '帮我盯消息', enabled: true, kind: 'all', action: 'remind', atOnly: false, targets: [], only: [], skip: [{ id: 'g002', name: '午饭拼单群', type: 'group' }], persona: '', notes: '', authorities: [], sources: [], prefix: '我的数字分身', backend: { account: 'auto', model: '', effort: '' }, hideModel: true, createdAt: now };
  fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify({ version: 1, paused: false, avatars: [av] }));
  const d = path.join(root, 'agents', 'vw'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ cursor: Object.fromEntries(snap.conversations.map(c => [c.id, now])), items: {}, log: [], stats: { day: D.dayKey(now) } }));
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-avatar-r64-')), dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: true, forum: false }));
  const now = Date.now(), snap = seedSnapshot(dataDir, now), cliLog = path.join(root, 'welink-commands.jsonl');
  const result = { passed: false, testRoot: root, checks: [], fixture: '隔离 Hub，假 welink-cli，合成 30 个群 + 3 个私聊；不登录、不碰真实 WeLink' };
  const fleetFile = path.join(dataDir, 'avatar', h16(ME), 'fleet.json');
  let hub, c;
  const stop = async () => { if (hub) { result.teardown = await gracefulQuit(hub); hub = null; } if (c) { await c.close(); c = null; } };
  try {
    for (let round = 0; round < 2; round++) {
      if (round === 1) { fs.rmSync(path.join(dataDir, 'avatar'), { recursive: true, force: true }); seedLegacy(dataDir, now, snap); }
      hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'avatar-r64', extraEnv: {
        AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
        AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
        CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
        CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
        CLAUDE_HUB_WELINK_CLI: path.join(repo, 'tests/fixtures/welink-cli-standin.js'), WELINK_STANDIN_LOG: cliLog, WELINK_STANDIN_ANY_GROUP: '1',
        CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline test' }, foreign: { ok: false, error: 'offline test' } }),
      } });
      c = await connectFirstPage(hub);
      await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      const until = async (expr, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(100); } throw Error('Timeout: ' + expr); };
      const click = async selector => {
        await until(`!!document.querySelector(${JSON.stringify(selector)})`);
        const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
      };
      const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
      const text = sel => c.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent||''`);
      const oneScreen = async (name, sel = '') => {
        const m = await c.eval(`(()=>{const p=document.getElementById('avatar-page'),k=${sel ? `document.querySelector(${JSON.stringify(sel)})` : `p.querySelector('.avx-body')||p.querySelector('.avx-root')`},r=p.getBoundingClientRect();return{over:k.scrollHeight-k.clientHeight,root:p.scrollHeight-p.clientHeight,doc:document.documentElement.scrollHeight-innerHeight,wide:p.scrollWidth-p.clientWidth}})()`);
        assert.ok(m.over <= 1 && m.root <= 1 && m.doc <= 1 && m.wide <= 1, `${name} 出现滚动：${JSON.stringify(m)}`);
        return m;
      };
      const pickedIds = () => c.eval(`[...document.querySelectorAll('#avatar-page [data-pick-body="wiz"] .avx-pk.on')].map(e=>e.dataset.id).join()`);
      await until(`(()=>{const b=document.getElementById('btn-avatar');return !!b&&!b.hidden&&getComputedStyle(b).display!=='none'})()`);
      await click('#btn-avatar');
      await until(`!document.getElementById('avatar-page')?.hidden`);
      if (round === 0) {
        await until(`document.querySelectorAll('#avatar-page .avx-tpl').length===4`);
        assert.ok((await text('#avatar-page .avx-tpl[data-t="watch"]')).includes('选定的群和人'), '模板卡写明只盯选定的');
        await click('#avatar-page .avx-tpl[data-t="watch"]');
        await until(`!!document.querySelector('#avatar-page [data-pick-body="wiz"] .avx-pk')`);
        await until(`document.querySelectorAll('#avatar-page [data-pick-body="wiz"] .avx-pk.on').length===3`);
        assert.equal(await text('#avatar-page [data-av="wiz-kind"].on'), '只盯选中的（推荐）');
        assert.equal(await pickedIds(), 'g002,g005,g012', '默认替他先选上 @过他 / 消息多的 3 个群');
        assert.match(await text('#avatar-page .avx-md'), /先替你选上了最近 @过你、消息最多的 3 个群/);
        assert.equal(await c.eval(`document.querySelectorAll('#avatar-page [data-pick-body="wiz"] .avx-pk').length`), 14, '一页 14 个，其余翻页');
        await shot('1-wizard-default'); result.wizard = await oneScreen('向导默认', '#avatar-page .avx-md');
        result.checks.push('新建「帮我盯消息」：默认「只盯选中的」，已替他选上最近 @过他、消息最多的 3 个群（g005、g012、g002），一页 14 个翻页，不出滚动条');
        // 搜索：中文输入只改列表那一块，输入框不丢焦点
        await click('#avatar-page [data-pick-q="wiz"]');
        await c.send('Input.insertText', { text: '项目' });
        await until(`[...document.querySelectorAll('#avatar-page [data-pick-body="wiz"] .avx-pk')].every(e=>e.textContent.includes('项目'))`);
        const found = await c.eval(`document.querySelectorAll('#avatar-page [data-pick-body="wiz"] .avx-pk').length`);
        assert.equal(found, 6, '30 个群里名字带「项目」的 6 个');
        assert.equal(await c.eval(`document.activeElement?.dataset?.pickQ`), 'wiz', '输入框不丢焦点');
        await shot('2-wizard-search');
        await click('#avatar-page [data-pick-body="wiz"] .avx-pk[data-id="g001"]');
        await until(`document.querySelectorAll('#avatar-page .avx-md .avx-chips')[0]?.textContent.includes('项目周会群')`);
        // 再点掉一个默认选的（已选区里的 ×）
        await click('#avatar-page .avx-md .avx-pk.on button[data-id="g002"]');
        await until(`!document.querySelector('#avatar-page .avx-md .avx-pk.on button[data-id="g002"]')`);
        assert.equal(await c.eval(`document.querySelector('#avatar-page [data-pick-q="wiz"]').value`), '项目', '点选后搜索词还在');
        result.checks.push('搜索「项目」只剩 6 个名字带「项目」的群，输入框不丢焦点；点选加 1 个、在已选里点 × 去掉 1 个，搜索词保留');
        // 切到「全部会话」看一眼，再切回来，已选不丢
        await click('#avatar-page [data-av="wiz-kind"][data-k="all"]');
        await until(`(document.querySelector('#avatar-page .avx-md')?.textContent||'').includes('不想让它看的群')`);
        await shot('3-wizard-all');
        await click('#avatar-page [data-av="wiz-kind"][data-k="pick"]');
        await until(`(document.querySelectorAll('#avatar-page .avx-md .avx-chips')[0]?.textContent||'').includes('项目周会群')`);
        await click('#avatar-page [data-av="wiz-go"]');
        await until(`[...document.querySelectorAll('#avatar-page .avx-row')].some(e=>e.textContent.includes('帮我盯消息'))`, 30000);
        const saved = JSON.parse(fs.readFileSync(fleetFile, 'utf8')).avatars[0];
        assert.equal(saved.kind, 'pick');
        assert.deepEqual(saved.targets.map(t => t.id).sort(), ['g001', 'g005', 'g012']);
        assert.ok(saved.targets.every(t => t.action === 'remind'));
        result.saved = { kind: saved.kind, targets: saved.targets.map(t => `${t.name}(${t.action})`) };
        result.checks.push('创建后 fleet.json：kind=pick，只盯 项目周会群、g005、g012 三个，动作都是提醒');
        await click('#avatar-page .avx-tabs [data-k="scope"]');
        await until(`!!document.querySelector('#avatar-page [data-pick-body="scope"] .avx-pk')`);
        assert.equal(await text('#avatar-page .avx-seg button.on'), '只盯选中的群或人');
        await shot('4-scope-pick'); result.scopePick = await oneScreen('范围页（只盯几个）');
        result.checks.push('范围页：选中「只盯选中的群或人」，左边列已盯的 3 个，右边搜索 + 翻页选群，一屏');
      } else {
        await click('#avatar-page .avx-row[data-id="vw"]');
        await click('#avatar-page .avx-tabs [data-k="scope"]');
        await until(`(document.querySelector('#avatar-page [data-sc="pk"]')?.textContent||'').includes('现在盯的是')`);
        const note = await text('#avatar-page [data-sc="pk"]');
        assert.match(note, /全部会话（最近的 29 个群、3 个私聊都在内）/);
        assert.match(note, /不看：午饭拼单群/);
        assert.equal(JSON.parse(fs.readFileSync(fleetFile, 'utf8')).avatars[0].kind, 'all', '升级后已有设置不变');
        await shot('5-legacy-all'); result.legacy = await oneScreen('范围页（全部会话）');
        result.checks.push('升级前的「全部会话」分身打开后设置不变，范围页写清「全部会话（最近的 29 个群、3 个私聊都在内）；不看：午饭拼单群」');
        await click('#avatar-page [data-sc="pk"] [data-av="kind"][data-k="pick"]');
        await until(`!!document.querySelector('#avatar-page [data-pick-body="scope"]')`);
        const after = JSON.parse(fs.readFileSync(fleetFile, 'utf8')).avatars[0];
        assert.equal(after.kind, 'pick');
        assert.deepEqual(after.targets.map(t => t.id), ['g005', 'g012', 'g001'], '替他先选建议的群，不看的午饭拼单群不在内');
        assert.ok(after.targets.every(t => t.action === 'remind'));
        await _waitMs(200);
        await shot('6-legacy-switched'); result.switched = await oneScreen('改成只盯几个之后');
        result.checks.push('点「改成只盯几个群」：kind 改成 pick，先替他选上 g005、g012、项目周会群（跳过他原来不看的午饭拼单群），动作是提醒');
      }
      await stop();
    }
    result.passed = true;
  } catch (error) {
    result.error = error.stack; result.logTail = error.logTail; process.exitCode = 1;
    if (c) try { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(s.data, 'base64')); } catch {}
  } finally { await stop(); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
})();

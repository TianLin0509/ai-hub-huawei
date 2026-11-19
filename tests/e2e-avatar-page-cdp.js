'use strict';
// 「分身」页真实界面检查：隔离数据目录 + 假 welink-cli + 合成消息，不登录、不碰真实 WeLink。
//   第一轮：全新用户，看到 Beta 入口和模板 → 三步建一个群答疑分身。
//   第二轮：预置待确认事项 → 各页签一屏 → 上级应承要确认两次 → 发送时核对假 CLI 收到的命令。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const D = require('../core/company-assistant/data');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/avatar-page-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const ME = 'user001', h16 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function seedSnapshot(dataDir, now) {
  let n = 0;
  const m = (conv, name, account, text, ago, extra = {}) => ({ sourceId: `msg:${conv}:${++n}`, conv, convName: name, key: String(n), at: now - ago * 60000, sender: account === ME ? '我' : name, account, mine: account === ME, atMe: false, text, contentType: 'TEXT_MSG', displayTime: '', preview: text, ...extra });
  const people = [['c001', '同事甲'], ['c002', '同事乙'], ['b001', '上级甲']];
  const snap = { at: now - 120000, day: D.dayKey(now), login: { ok: true, uid: ME }, conversations: [...people.map(([id, name]) => ({ id, name, group: false })), { id: 'g001', name: '工具用户群', group: true }, { id: 'g002', name: '午饭拼单群', group: true }], messages: {}, meetings: [], calendar: [], mails: [], errors: [] };
  snap.messages.c001 = [m('c001', '同事甲', 'c001', '评审材料啥时候对下', 42)];
  snap.messages.b001 = [m('b001', '上级甲', 'b001', '这个下周能给我吗', 18)];
  snap.messages.g001 = [m('g001', '工具用户群', 'c002', '导出按钮在哪里？', 12, { sender: '同事乙' })];
  const dir = path.join(dataDir, 'company-assistant'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `raw-${snap.day}.json`), JSON.stringify(snap));
  return snap;
}
function seedFleet(dataDir, now, snap) {
  const root = path.join(dataDir, 'avatar', h16(ME)); fs.mkdirSync(root, { recursive: true });
  const base = { enabled: true, action: 'draft', atOnly: false, only: [], skip: [], persona: '我发消息很短。', notes: '', authorities: [], sources: [], backend: { account: 'auto', model: '', effort: '' }, hideModel: true, createdAt: now };
  const avatars = [{ ...base, id: 'vqa', tpl: 'qa', name: '工具答疑', kind: 'pick', targets: [{ id: 'g001', name: '工具用户群', type: 'group', action: 'draft' }], prefix: '工具答疑分身' }, { ...base, id: 'vdr', tpl: 'draft', name: '帮我起草回复', kind: 'all', atOnly: true, targets: [], prefix: '我的数字分身' }];
  fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify({ version: 1, paused: false, avatars }));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ roster: { people: { b001: { name: '上级甲', rel: 'leader', protected: true } }, groups: {} } }));
  const item = (conv, name, group, account, ago, text, extra) => { const key = snap.messages[conv].at(-1).key; return [`${conv}:${key}`, { id: `${conv}:${key}`, conv, convName: name, group, account, who: group ? '同事乙' : name, firstKey: key, lastKey: key, since: now - ago * 60000, at: now - ago * 60000, count: 1, text, action: 'draft', level: 3, state: 'ready', senders: [account], flags: [], confidence: 72, why: '已写好草稿，等你确认', basis: '历史问答', ...extra }]; };
  const cursor = Object.fromEntries(snap.conversations.map(c => [c.id, now]));
  const write = (id, items, log) => { const d = path.join(root, 'agents', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ cursor, items: Object.fromEntries(items), log, stats: { day: D.dayKey(now), read: 245, model: 14, ready: 3, remind: 1, sent: 2 }, memoryLines: 96, memoryAt: now })); };
  write('vqa', [item('g001', '工具用户群', true, 'c002', 12, '导出按钮在哪里？', { draft: '同事乙 关于『导出』：在右上角菜单里。' })], Array.from({ length: 12 }, (_, i) => ({ at: now - i * 600000, itemId: 'x' + i, where: '工具用户群', who: '同事' + i, text: '历史消息 ' + i, act: i % 3 ? 'skip' : 'draft', confidence: 70, result: i % 3 ? '跳过' : '等你确认', why: '示例原因 ' + i })));
  write('vdr', [item('b001', '上级甲', false, 'b001', 18, '这个下周能给我吗', { draft: '好的，我今天给您', flags: ['leader', 'commit'] }), item('c001', '同事甲', false, 'c001', 42, '评审材料啥时候对下', { draft: '下午四点后可以' })], []);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-avatar-page-')), dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: true, forum: false }));
  const now = Date.now(), snap = seedSnapshot(dataDir, now), cliLog = path.join(root, 'welink-commands.jsonl');
  const result = { passed: false, testRoot: root, checks: [], fixture: '隔离 Hub，假 welink-cli，合成消息；不登录、不碰真实 WeLink' };
  let hub, c;
  const stop = async () => { if (hub) { result.teardown = await gracefulQuit(hub); hub = null; } if (c) { await c.close(); c = null; } };
  try {
    for (let round = 0; round < 2; round++) {
      if (round === 1) seedFleet(dataDir, now, snap);
      hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'avatar-page', extraEnv: {
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
      // 一屏：页面和内容区都不出纵向滚动，页面没有被别的面板盖住。
      const oneScreen = async name => {
        const m = await c.eval(`(()=>{const p=document.getElementById('avatar-page'),k=p.querySelector('.avx-body')||p.querySelector('.avx-root'),r=p.getBoundingClientRect(),t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{over:k.scrollHeight-k.clientHeight,root:p.scrollHeight-p.clientHeight,doc:document.documentElement.scrollHeight-innerHeight,wide:p.scrollWidth-p.clientWidth,covered:!p.contains(t)}})()`);
        assert.ok(m.over <= 1 && m.root <= 1 && m.doc <= 1 && m.wide <= 1, `${name} 出现滚动：${JSON.stringify(m)}`);
        assert.equal(m.covered, false, `${name} 被别的面板盖住`);
        return m;
      };
      const sends = () => (fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : []).filter(a => a[1] === 'send-to-user' || a[1] === 'send-to-group');
      await until(`(()=>{const b=document.getElementById('btn-avatar');return !!b&&!b.hidden&&getComputedStyle(b).display!=='none'})()`);
      assert.ok((await text('#btn-avatar')).includes('分身') && (await text('#btn-avatar')).includes('Beta'), '左侧栏入口标了 Beta');
      await click('#btn-avatar');
      await until(`!document.getElementById('avatar-page')?.hidden`);
      if (round === 0) {
        await until(`document.querySelectorAll('#avatar-page .avx-tpl').length===4`);
        assert.ok((await text('.avx-head h1')).includes('Beta'));
        await shot('1-first-use'); await oneScreen('首次使用');
        result.checks.push('全新用户：左侧栏和页头都标 Beta，直接看到 4 个模板，不需要填任何东西');
        await click('#avatar-page .avx-tpl[data-t="qa"]');
        await until(`[...document.querySelectorAll('#avatar-page .avx-pk')].some(e=>e.textContent==='工具用户群')`);
        assert.equal(await c.eval(`document.querySelector('#avatar-page [data-av="wiz-go"]').disabled`), true, '没选群不能创建');
        await click('#avatar-page .avx-pk[data-id="g001"]');
        await shot('2-wizard'); await click('#avatar-page [data-av="wiz-go"]');
        await until(`[...document.querySelectorAll('#avatar-page .avx-row')].some(e=>e.textContent.includes('工具用户群答疑'))`, 30000);
        const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'avatar', h16(ME), 'fleet.json'), 'utf8')).avatars[0];
        assert.equal(saved.tpl, 'qa'); assert.equal(saved.targets[0].id, 'g001'); assert.equal(saved.targets[0].action, 'draft');
        await shot('3-created'); await oneScreen('创建后');
        result.checks.push('选模板、选群、创建三步走通，配置写入本机；默认动作是起草');
        assert.equal(sends().length, 0); result.checks.push('创建和起草过程没有发出任何消息');
        await click('#btn-home'); await until(`document.getElementById('avatar-page').hidden`);
        result.checks.push('切到主页时分身页收起');
      } else {
        await until(`document.querySelectorAll('#avatar-page .avx-it').length===3`);
        assert.equal(sends().length, 0);

        await c.eval(`[...document.querySelectorAll('#avatar-page .avx-it')].find(e=>e.textContent.includes('上级甲')).click()`);
        await until(`document.querySelector('#avx-draft')?.value.includes('今天给您')`);
        await shot('4-inbox-leader'); await oneScreen('待确认');
        await click('#avatar-page [data-av="send"]');
        await until(`document.querySelector('#avatar-page [data-av="send"]')?.textContent==='确认发送'`);
        assert.equal(sends().length, 0, '第一次点击没有发出');
        await shot('5-need-ack'); result.checks.push('回上级的应承话：第一次点发送只提示，没有发出');
        await c.eval(`[...document.querySelectorAll('#avatar-page .avx-it')].find(e=>e.textContent.includes('同事甲')).click()`);
        await until(`document.querySelector('#avx-draft')?.value.includes('下午四点')`);
        await click('#avx-draft'); await c.send('Input.insertText', { text: '吧' });
        await click('#avatar-page [data-av="send"]');
        await until(`document.querySelectorAll('#avatar-page .avx-it').length===2`);
        let sent = sends(); assert.equal(sent.length, 1); assert.deepEqual(sent[0].slice(0, 4), ['im', 'send-to-user', '--receiver', 'c001']); assert.ok(!sent[0][5].includes('🤖'));
        result.checks.push('私聊草稿：只发给这条消息所在的会话，以本人名义，不带前缀');
        await c.eval(`[...document.querySelectorAll('#avatar-page .avx-it')].find(e=>e.textContent.includes('导出')).click()`);
        await until(`document.querySelector('#avx-draft')?.value.includes('右上角')`);
        await click('#avatar-page [data-av="send"]');
        await until(`document.querySelectorAll('#avatar-page .avx-it').length===1`);
        sent = sends(); assert.deepEqual(sent[1].slice(0, 4), ['im', 'send-to-group', '--group-id', 'g001']); assert.ok(sent[1][5].startsWith('🤖【工具答疑分身】'));
        result.checks.push('群答疑草稿：发到原来的群，带 🤖 前缀');
        await until(`!!document.querySelector('#avatar-page .avx-bn [data-av="recall"]')`);
        await click('#avatar-page .avx-bn [data-av="recall"]');
        await until(`fetchRecall()`.replace('fetchRecall()', `(document.querySelector('.avx-bn.b')?.textContent||'').includes('已撤回')`));
        assert.ok(fs.readFileSync(cliLog, 'utf8').includes('"recall-message","--group-id","g001","--message-id","900100"'));
        result.checks.push('发出后可以一键撤回，撤回的就是刚发的那一条');
        await click('#avatar-page .avx-row[data-id="vqa"]');
        for (const [tab, name, probe] of [['log', '6-log', `document.querySelectorAll('#avatar-page .avx-t tr.ck').length===9`], ['scope', '7-scope', `document.querySelector('#avatar-page .avx-seg button.on')?.textContent==='指定群或人'`], ['ctx', '8-context', `(document.querySelector('.avx-c3')?.textContent||'').includes('96 条')`], ['back', '9-backend', `!!document.querySelector('#avx-preview')`]]) {
          await click(`#avatar-page .avx-tabs [data-k="${tab}"]`); await until(probe); await _waitMs(150);
          await shot(name); result[name] = await oneScreen(name);
        }
        assert.equal(await c.eval(`[...document.querySelectorAll('#avatar-page option')].some(o=>/auto|自动发/.test(o.value+o.textContent))`), false, 'Beta 没有自动发选项');
        await click('#avatar-page .avx-tabs [data-k="scope"]'); await until(`!!document.querySelector('#avatar-page select[data-chg="target-action"]')`);
        assert.equal(await c.eval(`[...document.querySelectorAll('#avatar-page select[data-chg="target-action"] option')].map(o=>o.value).join()`), 'watch,remind,draft');
        result.checks.push('运行记录、生效范围、上下文、后端四个页签各一屏；界面上没有自动发选项');
        await click('#avatar-page [data-av="pause-all"]'); await until(`(document.querySelector('.avx-bn.r')?.textContent||'').includes('全部分身已暂停')`);
        await shot('10-paused'); result.checks.push('一键全部暂停有醒目提示');
      }
      await stop();
    }
    result.passed = true;
  } catch (error) {
    result.error = error.stack; process.exitCode = 1;
    if (c) try { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(s.data, 'base64')); } catch {}
  } finally { await stop(); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
})();

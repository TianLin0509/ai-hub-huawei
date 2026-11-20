'use strict';
// 输入框「/」命令与技能选择框（2026-11-20）在真实 Hub 界面里走一遍：隔离数据目录、隐藏窗口、
// Claude Code / Codex 用替身 CLI，CodeAgent 用替身 CLI，DSH / pi 用传入的真实安装（--dsh-root / --pi-root，可省略）。
// 每家：输入 / 弹框 → 列表与夹具目录逐条核对 → 冷白、深色各截一张 → 过滤、上下键、Tab 插入不发送、Esc 保留原文；
// 另测中文输入法组字（CDP imeSetComposition）不弹不吞字、单独「、」唤起、500 条技能下每次按键耗时。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const options = { entry: REPO, out: path.join(REPO, 'artifacts', 'composer-slash-' + Date.now()), 'dsh-root': '', 'pi-root': '' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!(key in options) || !process.argv[i + 1]) throw Error('Expected --entry / --out / --dsh-root / --pi-root');
  options[key] = path.resolve(process.argv[i + 1]);
}
function skill(root, name, description) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
}

async function run() {
  fs.mkdirSync(options.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-slash-e2e-'));
  const data = path.join(root, 'data'), work = path.join(root, 'work'), home = path.join(root, 'home'), bin = path.join(root, 'bin');
  const claudeConfig = path.join(root, 'claude-config'), codexHome = path.join(root, 'codex-home'), piAgent = path.join(root, 'pi-agent'), caConfig = path.join(root, 'cac');
  for (const dir of [data, work, home, bin, path.join(work, '.git'), path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  // 公司版 DSH 要先选模型来源：给一个不会连通的自有接口，只为让终端界面能起来（不发模型请求）。
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ acp: { companyApi: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-fixture-not-real', model: 'fixture-model' } } }));
  // 夹具：每家各自目录 + 项目目录，期望值由这里直接推出，不经过被测代码。
  skill(path.join(claudeConfig, 'skills'), 'progress-brief', '向负责人汇报进展：用领域因果讲清进展、差距和要拍板的事');
  skill(path.join(claudeConfig, 'skills'), 'report-style', 'HTML 报告与界面设计规范');
  skill(path.join(work, '.claude', 'skills'), 'sim-helper', '生成仿真数据并编排实验');
  fs.mkdirSync(path.join(claudeConfig, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claudeConfig, 'commands', 'weekly.md'), '---\ndescription: 生成本周周报\n---\n');
  skill(path.join(codexHome, 'skills'), 'codex-own', 'Codex 账号里的技能');
  skill(path.join(home, '.agents', 'skills'), 'shared-agents', '~/.agents 共享技能');
  skill(path.join(work, '.agents', 'skills'), 'proj-agents', '项目 .agents 技能');
  skill(path.join(work, '.dsh', 'skills'), 'dsh-proj', '项目 .dsh 技能');
  skill(path.join(piAgent, 'skills'), 'pi-own', 'pi 自己目录里的技能');
  skill(path.join(work, '.pi', 'skills'), 'pi-proj', '项目 .pi 技能');
  fs.mkdirSync(path.join(piAgent, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(piAgent, 'prompts', 'review-pr.md'), '---\ndescription: 按团队口径审 PR\n---\n');
  // CodeAgent 替身（同 e2e-home-mid-composer-cdp.js）。
  { const { writeProbed } = require(path.join(options.entry, 'core/codeagent-model-probe'));
    fs.mkdirSync(caConfig, { recursive: true });
    fs.writeFileSync(path.join(caConfig, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'slash', expiresAt: Date.now() + 86400000 } }));
    fs.writeFileSync(path.join(caConfig, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
    writeProbed(path.join(caConfig, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
    skill(path.join(caConfig, 'skills'), 'welink-reply', 'WeLink 待回复消息起草'); }
  // Claude / Codex 替身：只需要在 PTY 里活着，选择框不依赖它们的输出。
  fs.copyFileSync(path.join(REPO, 'tests/fixtures/fake-claude.ps1'), path.join(bin, 'fake-claude.ps1'));
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fake-claude.ps1" %*\r\n');
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\necho fake codex ready\r\npowershell -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 900"\r\n');
  const pathDirs = [bin];
  if (options['pi-root']) { fs.writeFileSync(path.join(options['pi-root'], 'pi.cmd'), '@echo off\r\n'); pathDirs.push(options['pi-root']); }
  if (options['dsh-root']) { fs.writeFileSync(path.join(options['dsh-root'], 'dsh.cmd'), '@echo off\r\n'); pathDirs.push(options['dsh-root']); }

  const evidence = { entry: options.entry, root, kinds: {}, checks: [], rendererErrors: [] };
  const check = (label, ok, detail) => { evidence.checks.push({ label, ok: !!ok, ...(detail ? { detail } : {}) }); console.log((ok ? 'PASS ' : 'FAIL ') + label); };
  let hub, c, failure, shot = async () => {};
  try {
    hub = await launchIsolatedHub({ entryPath: options.entry, cwd: options.entry, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'composer-slash', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, USERPROFILE: home, HOME: home, PATH: pathDirs.join(';') + ';' + process.env.PATH,
      CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: piAgent, AI_HUB_TOKEN_PLAN_KEY: 'sk-fixture-not-real',
      AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: caConfig,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'),
      HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* CDP framing */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => {
      let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e.message; } await sleep(150); }
      throw Error('Timeout ' + label + (last ? ': ' + last : ''));
    };
    const key = async (k, extra = {}) => {
      const codes = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36 };
      for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: codes[k], ...extra });
    };
    const box = '#terminal-panel .floating-input-box';
    const focusBox = async () => {
      const xy = await wait(`(()=>{const e=document.querySelector(${JSON.stringify(box)});if(!e||e.offsetParent===null)return null;const r=e.getBoundingClientRect();return {x:r.x+20,y:r.y+r.height/2}})()`, 'composer');
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    const clear = () => c.eval(`(()=>{const b=document.querySelector(${JSON.stringify(box)});b.focus();document.execCommand('selectAll');document.execCommand('delete');return b.textContent})()`);
    const popVisible = `(()=>{const p=[...document.querySelectorAll('.hub-slash-pop,.fi-skill-picker')].find(p=>!p.hidden&&p.getClientRects().length>0);return !!p})()`;
    const rows = sel => c.eval(`[...document.querySelectorAll('${sel}')].filter(r=>r.offsetParent!==null).map(r=>r.dataset.insert)`);
    const text = () => c.eval(`document.querySelector(${JSON.stringify(box)}).textContent`);
    await wait('typeof selectSession === "function" && typeof themeController === "object"', 'renderer ready');
    await c.eval(`window.__sent=[];{const send=ipcRenderer.send.bind(ipcRenderer),invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.send=(ch,p)=>{if(ch==='terminal-input')__sent.push(p);return send(ch,p)};ipcRenderer.invoke=(ch,p,...r)=>{if(ch==='session:send-prompt')__sent.push(p);return invoke(ch,p,...r)}}`);
    shot = async (name, rect) => {
      const clip = rect ? { ...rect, scale: 1 } : undefined;
      fs.writeFileSync(path.join(options.out, name), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) })).data, 'base64'));
    };
    const clipRect = () => c.eval(`(()=>{const p=[...document.querySelectorAll('.hub-slash-pop,.fi-skill-picker')].find(p=>!p.hidden);const b=document.querySelector(${JSON.stringify(box)}).closest('.composer')||document.querySelector(${JSON.stringify(box)});const a=p.getBoundingClientRect(),q=b.getBoundingClientRect();const x=Math.max(0,Math.min(a.left,q.left)-16),y=Math.max(0,a.top-16);return {x,y,width:Math.min(innerWidth-x,Math.max(a.right,q.right)-x+16),height:Math.min(innerHeight-y,q.bottom-y+16)}})()`);

    const want = {
      claude: { kind: 'claude', skills: ['/sim-helper', '/progress-brief', '/report-style'], other: ['/weekly'], cmd: '/compact' },
      codex: { kind: 'codex', skills: ['$codex-own', '$proj-agents', '$shared-agents'], other: [], cmd: '/review' },
      dsh: { kind: 'deepseek-acp', skills: ['/dsh-proj', '/proj-agents'], other: [], cmd: '/btw', needs: 'dsh-root' },
      pi: { kind: 'pi', skills: ['/skill:pi-own', '/skill:pi-proj', '/skill:proj-agents', '/skill:shared-agents'], other: ['/review-pr'], cmd: '/tree', needs: 'pi-root' },
      codeagent: { kind: 'codeagent', skills: null, cmd: null, opts: { codeagentAccount: 'personal' } },
    };
    for (const [name, spec] of Object.entries(want)) {
      const record = evidence.kinds[name] = {};
      if (spec.needs && !options[spec.needs]) { record.skipped = '未提供 --' + spec.needs; console.log('SKIP ' + name); continue; }
      let created;
      try { created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: spec.kind, opts: { cwd: work, title: '斜杠 ' + name, ...(spec.opts || {}) } })})`); }
      catch (error) { created = { error: error.message.slice(0, 400) }; }
      if (!created?.id) { record.createError = created; check(name + ': 会话创建', false, created); continue; }
      record.sessionId = created.id;
      await c.eval(`selectSession(${JSON.stringify(created.id)})`);
      await wait(`(()=>{const b=document.querySelector(${JSON.stringify(box)});return b&&b.offsetParent!==null})()`, name + ' composer', 45000);
      await sleep(1500);
      record.placeholder = await c.eval(`document.querySelector(${JSON.stringify(box)}).getAttribute('data-placeholder')`);
      check(name + ': 占位提示写「/ 查看命令和技能」', /\/ 查看命令和技能/.test(record.placeholder || ''));
      // Codex 首次启动会往 CODEX_HOME/skills/.system 放自带技能；等它落盘再读，避免清单和磁盘对比时撞上半途状态。
      if (name === 'codex') for (let i = 0; i < 40 && !fs.existsSync(path.join(codexHome, 'skills', '.system')); i++) await sleep(250);
      if (name === 'codex') await sleep(1000);
      await focusBox(); await clear();
      await c.send('Input.insertText', { text: '/' });
      await wait(popVisible, name + ' popup', 15000);
      const rowSel = name === 'codeagent' ? '.fi-skill-picker:not([hidden]) .fi-skill-option' : '.hub-slash-pop:not([hidden]) .hub-slash-row';
      if (name === 'codeagent') {
        await wait(`[...document.querySelectorAll('${rowSel}')].some(r=>r.textContent.includes('welink-reply'))`, 'codeagent skill row', 20000);
        check('codeagent: 原有选择框照常弹出并列出技能', true);
        record.buttonKept = await c.eval(`!!document.querySelector('#terminal-panel .composer-skills')`);
        check('codeagent: 「技能 ▾」按钮保持不动', record.buttonKept);
        record.otherPickerAbsent = await c.eval(`![...document.querySelectorAll('.hub-slash-pop')].some(p=>!p.hidden)`);
        check('codeagent: 不会同时弹出新选择框', record.otherPickerAbsent);
      } else {
        await wait(`document.querySelectorAll('${rowSel}').length>3`, name + ' rows', 15000);
        const all = await rows(rowSel + '[data-group]');
        const listed = { skill: await rows(rowSel + '[data-group=skill]'), other: await rows(rowSel + '[data-group=other]'), command: await rows(rowSel + '[data-group=command]') };
        record.listed = listed;
        // Codex 自带的系统技能（CODEX_HOME/skills/.system）也会加载，按磁盘上实际有的补进期望。
        const system = name === 'codex' && fs.existsSync(path.join(codexHome, 'skills', '.system')) ? fs.readdirSync(path.join(codexHome, 'skills', '.system'), { withFileTypes: true })
          .filter(e => e.isDirectory() && fs.existsSync(path.join(codexHome, 'skills', '.system', e.name, 'SKILL.md'))).map(e => '$' + e.name) : [];
        const expected = [...spec.skills, ...system].sort();
        record.expectedSkills = expected;
        check(name + ': 技能逐条对上磁盘目录（' + expected.length + ' 条，其中系统 ' + system.length + ' 条）', JSON.stringify([...listed.skill].sort()) === JSON.stringify(expected), listed.skill);
        check(name + ': 其他（自定义命令/模板）对上', JSON.stringify([...listed.other].sort()) === JSON.stringify(spec.other), listed.other);
        check(name + ': 内置命令含 ' + spec.cmd, listed.command.includes(spec.cmd), listed.command.length + ' 条');
        record.total = all.length;
      }
      for (const theme of ['codex', 'dark']) {
        await c.eval(`themeController.applyTheme(${JSON.stringify(theme)})`); await sleep(250);
        await shot(`${name}-${theme === 'codex' ? 'light' : 'dark'}.png`, await clipRect());
      }
      await c.eval(`themeController.applyTheme('codex')`);
      if (name === 'codeagent') { await key('Escape'); await clear(); continue; }
      // 过滤 + 上下键 + Tab 插入不发送；Esc 保留原文。
      const sentBefore = await c.eval('__sent.length');
      const q = spec.skills[0].replace(/^[/$]/, '').replace(/^skill:/, '').slice(0, 4);
      await c.send('Input.insertText', { text: spec.skills[0].startsWith('/skill:') ? 'skill:' + q : q });
      await sleep(250);
      const filtered = await rows(rowSel);
      check(name + ': 输入过滤后列表缩小且含目标', filtered.length < record.total && filtered.includes(spec.skills[0]), filtered.slice(0, 6));
      await key('ArrowDown'); await key('ArrowUp');
      const selected = await c.eval(`document.querySelector('${rowSel}[aria-selected=true]')?.dataset.insert`);
      await key('Tab'); await sleep(200);
      record.inserted = await text();
      check(name + ': Tab 插入「' + selected + ' 」、不发送、框关闭', record.inserted.trim() === selected && !(await c.eval(popVisible)) && (await c.eval('__sent.length')) === sentBefore, record.inserted);
      await clear(); await c.send('Input.insertText', { text: '/zz' }); await wait(popVisible, 'reopen');
      await key('Escape'); await sleep(150);
      check(name + ': Esc 关闭且原文保留', (await text()) === '/zz' && !(await c.eval(popVisible)));
      await clear();
    }

    // 真机核对：DSH、pi 在终端里自己的命令菜单是否也认出了夹具技能（直接往终端敲字，读终端缓冲区）。
    for (const [name, typed, expect] of [['dsh', '/dsh-pro', 'dsh-proj'], ['pi', '/skill:pi-', 'pi-own'], ['pi', '/skill:pi-p', 'pi-proj']]) {
      const id = evidence.kinds[name]?.sessionId; if (!id) continue;
      await sleep(4000);
      // pi 打开带 .pi 的项目会先问是否信任（信任后才加载项目技能）；替用户点一次「Trust」。
      if (name === 'pi' && /Trust/.test(String(await c.eval(`ipcRenderer.invoke('debug:get-session-buffer',${JSON.stringify(id)})`) || '').slice(-3000))) {
        evidence.kinds.pi.trustPrompt = true;
        await c.eval(`ipcRenderer.send('terminal-input',{sessionId:${JSON.stringify(id)},data:'\\r'})`); await sleep(3000);
      }
      await c.eval(`ipcRenderer.send('terminal-input',{sessionId:${JSON.stringify(id)},data:${JSON.stringify(typed)}})`);
      let seen = false, tail = '';
      for (let i = 0; i < 40 && !seen; i++) { await sleep(250); const buf = String(await c.eval(`ipcRenderer.invoke('debug:get-session-buffer',${JSON.stringify(id)})`) || ''); tail = buf.slice(-1500); seen = buf.includes(expect); }
      evidence.kinds[name].nativeMenuTail = tail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-600);
      check(name + ': 终端里 ' + name + ' 自己的菜单也列出 ' + expect + '（目录核对）', seen);
      await c.eval(`ipcRenderer.send('terminal-input',{sessionId:${JSON.stringify(id)},data:'\x15'})`);
    }

    // 中文输入法与「、」：在 Claude 会话上测。
    if (evidence.kinds.claude?.sessionId) {
      await c.eval(`selectSession(${JSON.stringify(evidence.kinds.claude.sessionId)})`); await sleep(800);
      await focusBox(); await clear();
      const sentBefore = await c.eval('__sent.length');
      await c.send('Input.imeSetComposition', { text: 'mingling', selectionStart: 8, selectionEnd: 8 });
      await sleep(200);
      check('输入法: 组字中不弹框', !(await c.eval(popVisible)));
      await key('Enter', { isComposing: true }); await sleep(150);
      await c.send('Input.insertText', { text: '命令' }); await sleep(250);
      check('输入法: 上屏后文字完整、不弹、没发送', (await text()) === '命令' && !(await c.eval(popVisible)) && (await c.eval('__sent.length')) === sentBefore, await text());
      await clear();
      await c.send('Input.insertText', { text: '、' }); await wait(popVisible, '、 popup', 8000);
      check('「、」: 整框只有它时唤起', true);
      await key('Escape'); await sleep(150);
      check('「、」: Esc 后原样保留', (await text()) === '、' && !(await c.eval(popVisible)));
      await c.send('Input.insertText', { text: '好的' }); await sleep(200);
      check('「、」: 后接中文不弹', !(await c.eval(popVisible)) && (await text()) === '、好的');
      await clear();
      await c.send('Input.insertText', { text: '、' }); await wait(popVisible, '、 popup 2', 8000);
      await key('Tab'); await sleep(150);
      check('「、」: 选中后换成命令写法', /^\/\S+ $/.test(await text()), await text());
      await clear();
      await c.send('Input.insertText', { text: '/co' }); await wait(popVisible, 'home popup', 8000);
      await key('Home'); await sleep(200);
      check('光标移到行首（Home）后选择框关闭', !(await c.eval(popVisible)) && (await text()) === '/co');
      await clear();
      await c.send('Input.insertText', { text: '看下 D:/AIWork' }); await sleep(250);
      check('消息中间的 / 不唤起', !(await c.eval(popVisible)));
      await clear();
      // 500 条技能下的按键耗时：替换本会话清单后逐字输入。
      await c.eval(`(()=>{const items=[];for(let i=0;i<500;i++)items.push({group:'skill',name:'skill-'+i,insert:'/skill-'+i,description:'压力测试 '+i,source:'个人'});const orig=ipcRenderer.invoke;window.__origInvoke=orig;ipcRenderer.invoke=(ch,p,...r)=>ch==='composer:slash-catalog'?Promise.resolve({ok:true,label:'压力测试',sourceNote:'500 条',items}):orig(ch,p,...r)})()`);
      await c.send('Input.insertText', { text: '/' }); await wait(`document.querySelectorAll('.hub-slash-pop:not([hidden]) .hub-slash-row').length>=200`, 'stress rows');
      const times = [];
      // 隐藏窗口里 requestAnimationFrame 被节流到约 1 秒，量不准；改为在页面内同步计时：
      // execCommand 插字会同步触发 input → 过滤 → 重画列表，量到的就是每次按键的脚本加排版耗时。
      for (const ch of 'skill-4') times.push(Math.round(await c.eval(`(()=>{const b=document.querySelector(${JSON.stringify(box)});b.focus();const t=performance.now();document.execCommand('insertText',false,${JSON.stringify(ch)});document.querySelector('.hub-slash-pop').getBoundingClientRect();return performance.now()-t})()`) * 10) / 10);
      evidence.stressMs = times;
      check('500 条技能: 每次按键过滤+重画 < 50 ms（' + times.join('/') + ' ms）', Math.max(...times) < 50);
      await shot('stress-500.png', await clipRect());
      await key('Escape'); await clear();
      await c.eval('ipcRenderer.invoke=window.__origInvoke');
    }
    check('渲染进程无报错', evidence.rendererErrors.length === 0, evidence.rendererErrors.slice(0, 3));
    evidence.ok = evidence.checks.every(x => x.ok);
  } catch (error) {
    failure = error; evidence.ok = false; evidence.error = error.stack;
    try { evidence.debug = await c.eval(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');const bar=b&&b.closest('.floating-input-bar');return {text:b&&b.textContent,focused:document.activeElement===b,active:document.activeElement&&document.activeElement.className,picker:!!(bar&&bar._slashPicker),pops:document.querySelectorAll('.hub-slash-pop').length,kind:bar&&sessions.get(bar.dataset.sessionId)?.kind,bars:document.querySelectorAll('.floating-input-bar').length}})()`); } catch (e) { evidence.debugError = e.message; }
    try { await shot('failure.png'); } catch (e) { evidence.shotError = e.message; }
  }
  finally {
    if (hub) { try { evidence.exit = await gracefulQuit(hub); } catch (e) { evidence.exitError = e.message; } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); fs.writeFileSync(path.join(options.out, 'hub.log'), hub.log().join('\n')); }
    try { await c?.close(); } catch { /* closed */ }
    fs.writeFileSync(path.join(options.out, 'composer-slash-e2e.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, failed: evidence.checks.filter(x => !x.ok).map(x => x.label), out: options.out }));
  }
  if (failure) throw failure;
  if (!evidence.ok) process.exitCode = 1;
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });

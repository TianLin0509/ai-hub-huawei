'use strict';
// 假 welink-cli（测试用，占位数据，不含真实人名）：按公司真机 1.0.14 的回执形状输出今天的会议、会话、消息、邮件。
// 每次调用把参数追加到 WELINK_STANDIN_LOG（验证 Hub 只调了查询命令）。
// WELINK_STANDIN_STATE 指向一个文件：内容为 expired 时 auth status 报过期；auth login 打印二维码，2 秒后写成 ok。
// 邮件和日历：同目录下没有 welink-exchange（mail autodiscover 写的本地配置）时，和真机一样报 Exchange 未配置；
// onebox user-info 返回本人邮箱（WELINK_STANDIN_NO_EMAIL=1 时不带邮箱）。
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.WELINK_STANDIN_LOG) fs.appendFileSync(process.env.WELINK_STANDIN_LOG, JSON.stringify(args) + '\n');
const stateFile = process.env.WELINK_STANDIN_STATE;
const loggedIn = () => !stateFile || !fs.existsSync(stateFile) || fs.readFileSync(stateFile, 'utf8').trim() !== 'expired';
const now = Date.now(), H = 3600000, M = 60000;
const today = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const out = v => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const [group, sub] = args;
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const exchangeFile = stateFile ? require('node:path').join(require('node:path').dirname(stateFile), 'welink-exchange') : null;
const exchangeReady = () => !!exchangeFile && fs.existsSync(exchangeFile);
const phoneFile = stateFile ? require('node:path').join(require('node:path').dirname(stateFile), 'welink-phone-group.jsonl') : null;
const phoneGroup = () => (phoneFile && fs.existsSync(phoneFile) ? fs.readFileSync(phoneFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : []);
function addPhoneMessage(sender, content, at = Date.now()) {
  const all = phoneGroup();
  const last = all.length ? BigInt(all[all.length - 1].msgId) : 7300000000000000000n;
  fs.appendFileSync(phoneFile, JSON.stringify({ msgId: String(last + 7n), sender, content, serverSendTime: at }) + '\n');
}
const needExchange = () => { process.stderr.write('Error: Exchange server domain not found. Please run first: welink-cli mail autodiscover --email <your-email>\n'); process.exitCode = 1; };

if (group === '__test' && sub === 'say') {
  // 测试用：模拟在手机上往专用群里发一句（发件人默认本人 user001）。
  addPhoneMessage(arg('--sender') || 'user001', arg('--text') || '', arg('--at') ? Number(arg('--at')) : Date.now()); // --at：模拟旧消息
} else if (group === 'auth' && sub === 'status') {
  out(loggedIn() ? 'UID: user001\nUser Token: VALID\n' : 'UID: user001\nUser Token: EXPIRED\n');
} else if (group === 'auth' && sub === 'login') {
  // 2026-10-22（v3.1.1）：按公司真机 welink-cli 1.0.14 的格式（回执 Q-1021-14）在 stdout 上用半块字符画二维码，
  // 矩阵是 welink-login-qr.json 里离线生成的真实二维码（内容 qrcode_content），框外四周各留 1 个白模块；框后是登录网页地址。
  // WELINK_STANDIN_SCAN_MS：多久后「扫码成功」（默认 2 秒）。WELINK_STANDIN_LOGIN_MODE：空格分开的词——
  //   garbled（按 GB18030 字节输出字符画，模拟编码不对）/ legacy（旧的 data URI）/ timeout（不扫码，到时报超时退出）/ scan=<毫秒>。
  //   E2E 要在同一个 Hub 里换着测：WELINK_STANDIN_STATE 同目录下有 welink-login-mode 文件时以它的内容为准，例如「garbled timeout scan=6000」。
  const modeFile = stateFile ? require('node:path').join(require('node:path').dirname(stateFile), 'welink-login-mode') : null;
  const words = (modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8') : process.env.WELINK_STANDIN_LOGIN_MODE || '').trim().split(/\s+/).filter(Boolean);
  const mode = words.includes('legacy') ? 'legacy' : words.includes('garbled') ? 'garbled' : 'blocks';
  const timeoutOutcome = words.includes('timeout');
  const scanWord = words.find(w => /^scan=\d+$/.test(w));
  const scanMs = Number(scanWord ? scanWord.slice(5) : process.env.WELINK_STANDIN_SCAN_MS || 2000);
  if (mode === 'legacy') {
    out('请用 WeLink 扫码登录：\ndata:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==\n');
    setTimeout(() => { if (stateFile) fs.writeFileSync(stateFile, 'ok'); out('登录成功\n'); }, scanMs);
  } else {
    // 字符画自己画（不借用被测的 welink.js）：每个字符 = 上下两行模块。
    // 按脚本路径找 fixture（单测会在测试进程里直接执行本文件，相对 require 不可靠）。
    const qr = JSON.parse(fs.readFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]), 'welink-login-qr.json'), 'utf8'));
    const n = qr.size + 2, black = (y, x) => qr.rows[y - 1]?.[x - 1] === '1';
    const lines = [];
    for (let y = 0; y < n; y += 2) { let s = ''; for (let x = 0; x < n; x++) { const t = black(y, x), b = y + 1 < n && black(y + 1, x); s += t && b ? '█' : t ? '▀' : b ? '▄' : ' '; } lines.push('|' + s + '|'); }
    const border = '+' + '-'.repeat(n) + '+', art = [border, ...lines, border].join('\n');
    out('Obtaining QR code...\n     WeLink QR Code Login\n\nPlease scan QR code below with WeLink mobile app:\n\n');
    // garbled：按 GB18030 字节写出（Hub 按 UTF-8 解码时就是乱码），模拟控制台代码页不对。
    if (mode === 'garbled') process.stdout.write(Buffer.concat([...art + '\n'].map(ch => ({ '█': Buffer.from('a880', 'hex'), '▀': Buffer.from('81379932', 'hex'), '▄': Buffer.from('a87b', 'hex') }[ch] || Buffer.from(ch)))));
    else out(art + '\n');
    out(`\nIf QR code is not displayed correctly, open this URL to scan:\n${qr.url}\n\nWaiting for scan...\n`);
    const started = Date.now();
    const tick = setInterval(() => out(`\rWaiting for scan... (elapsed ${Math.round((Date.now() - started) / 1000)} seconds)`), 1000);
    if (timeoutOutcome) setTimeout(() => { clearInterval(tick); out('\nQR code login timeout, please try again.\n'); process.exitCode = 1; }, scanMs);
    else setTimeout(() => {
      clearInterval(tick);
      if (stateFile) fs.writeFileSync(stateFile, 'ok');
      out('\nScan successful! Obtaining login credentials...\n');
      setTimeout(() => out('Login successful.\n'), 1500); // 真机换令牌要一会儿：面板此时显示「已扫码，正在登录…」
    }, scanMs);
  }
} else if (!loggedIn()) {
  process.stderr.write('Token expired, please run: welink-cli auth login\n');
  process.exitCode = 1;
} else if (group === 'meeting' && sub === 'query-list' && ['--page', '--size', '--meeting-start-time', '--meeting-end-time', '--type', '--meeting-sort'].some(k => !arg(k))) {
  process.stderr.write(['--page', '--size', '--meeting-start-time', '--meeting-end-time', '--type', '--meeting-sort'].find(k => !arg(k)) + ' is required\n');
  process.exitCode = 106;
} else if (group === 'meeting' && sub === 'query-list' && (!Number.isInteger(Number(arg('--size'))) || Number(arg('--size')) < 1 || Number(arg('--size')) > 30)) {
  out({ code: '400', message: { message: 'BAD_REQUEST', details: 'synthetic: meeting size must be between 1 and 30' } });
} else if (group === 'meeting' && sub === 'query-list') {
  // 「马上要开的会」定在第一次查询后 12 分钟，之后每次查询返回同一时间（Hub 取数和助理会话自己查，时间要一致）。
  const anchorFile = stateFile ? require('node:path').join(require('node:path').dirname(stateFile), 'welink-anchor') : null;
  if (anchorFile && !fs.existsSync(anchorFile)) fs.writeFileSync(anchorFile, String(now + 12 * M));
  const soon = anchorFile ? Number(fs.readFileSync(anchorFile, 'utf8')) : now + 10 * M;
  const all = [
    { enMeetingId: 'e1', meetingId: 'm-soon', subject: '方案评审（占位）', location: '会议室A', meetingStartTime: soon, meetingEndTime: soon + H, meetingUsers: [{}, {}, {}], files: [{}] },
    { enMeetingId: 'e2', meetingId: 'm-a', subject: '周例会（占位）', location: '会议室B', meetingStartTime: today(13, 0), meetingEndTime: today(14, 30), meetingUsers: [{}, {}] },
    { enMeetingId: 'e3', meetingId: 'm-b', subject: '对齐会（占位）', location: '线上', meetingStartTime: today(14, 30), meetingEndTime: today(16, 0), meetingUsers: [{}] },
    { enMeetingId: 'e4', meetingId: 'm-c', subject: '一对一（占位）', location: '线上', meetingStartTime: today(15, 30), meetingEndTime: today(16, 30), meetingUsers: [{}] },
  ];
  const page = Number(arg('--page')), size = Number(arg('--size'));
  out({ code: 200, data: { data: all.slice((page - 1) * size, page * size), page, size, start: (page - 1) * size, total: all.length } });
} else if (group === 'contact' && sub === 'detail') {
  const names = { user001: '用户甲', colleague_a: '同事甲', colleague_b: '同事乙', colleague_c: '同事丙', colleague_d: '同事丁', colleague_e: '同事戊', colleague_f: '同事己', colleague_g: '同事庚', colleague_h: '同事辛', colleague_z: '示例发言人' };
  const accounts = args.slice(2);
  out(accounts.some(a => names[a]) ? { code: '0', message: 'SUCCESS', users: accounts.filter(a => names[a]).map(a => ({ w3Account: a, personAccount: a, chineseName: names[a], workId: '00000001', employeeNumber: '12345678912345678' })) }
    : { code: '47111', message: 'Query users info does not exist or has been deleted.', users: [] });
} else if (group === 'calendar' && sub === 'list') {
  if (!exchangeReady()) needExchange();
  else {
    const max = Number(arg('--max') ?? 20);
    if (!Number.isInteger(max) || max < 0 || max > 500) { process.stderr.write('calendar max must be between 0 and 500'); process.exitCode = 1; }
    else {
      const begin = arg('--start') ? Date.parse(arg('--start') + 'T00:00:00+08:00') : -Infinity;
      const end = arg('--end') ? Date.parse(arg('--end') + 'T00:00:00+08:00') : Infinity;
      const rows = [{ id: 'cal-1', subject: '晨会（日历占位）', start: new Date(today(6, 0)).toISOString(), end: new Date(today(6, 30)).toISOString(), location: '线上', isAllDay: false, isCancelled: false }]
        .filter(e => Date.parse(e.start) < end && Date.parse(e.end) > begin).slice(0, max);
      out(rows.length ? rows : 'No events found.\n');
    }
  }
} else if (group === 'onebox' && sub === 'user-info') {
  out({ accountId: 1, name: '用户甲', loginName: 'user001', email: process.env.WELINK_STANDIN_NO_EMAIL === '1' ? '' : 'user001@example.com', status: 'normal' });
} else if (group === 'im' && sub === 'query-recent-conversation' && stateFile && fs.existsSync(stateFile) && fs.readFileSync(stateFile, 'utf8').trim() === 'conversations-failed') {
  process.stderr.write('合成故障：最近会话查询暂时失败\n'); process.exitCode = 1;
} else if (group === 'im' && sub === 'query-recent-conversation') {
  // 和真机同形（Q-1018-10）：每个会话 8 个字段，没有时间、免打扰、置顶、未读；单聊 group_id 是 "0"。
  // --count 默认 10、上限 50：中间垫 12 个没有消息往来的旧单聊，不带 --count 时只能拿到前 10 个，正好漏掉后面的会话。
  const p2p = (account, name) => ({ cross_instance: false, group_id: '0', group_name: '', group_type: 'NORMAL_GROUP', native_name: name, recent_conversation_type: 'CHAT_TYPE_P2P_MSG', staff_name: account + ' 00000000', target_account: account });
  const grp = (id, name) => ({ cross_instance: false, group_id: id, group_name: name, group_type: 'NORMAL_GROUP', native_name: '', recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', staff_name: '', target_account: '' });
  const all = [p2p('colleague_a', '同事甲'), grp('g-100', '项目群A'), grp('g-phone', '助理 CodeAgent'),
    // 垫着的空旧单聊个数：WELINK_STANDIN_PAD，默认 12；单测设 0 省时间
    ...Array.from({ length: Number(process.env.WELINK_STANDIN_PAD ?? 12) }, (_, i) => p2p('old_' + i, '老同事' + i)), grp('g-200', '部门大群'), p2p('colleague_d', '同事丁')];
  const count = Math.min(100, Math.max(1, Number(arg('--count') || 10)));
  // Q-1021-08：最近会话的明确成功码，不能用泛化的 0 代替真机契约。
  out({ app_service_id: 'x', conversation_info: all.slice(0, count), error: { error_code: 'IM.0000', error_msg: 'success' } });
} else if (group === 'im' && sub === 'query-history-message' && arg('--group-id') === 'g-phone') {
  // 手机对话的专用群：消息存在 WELINK_STANDIN_STATE 同目录的 welink-phone-group.jsonl（测试往里写「手机发的」消息）。
  // 和真机一样：msgId 是超过 JS 安全整数的长整数；--query-direction 1 取比 --message-id 更新的（help 写反了）。
  const all = phoneGroup();
  const from = arg('--message-id'), dir = arg('--query-direction'), count = Number(arg('--query-count') || 20);
  let list = from ? all.filter(m => dir === '1' ? BigInt(m.msgId) > BigInt(from) : BigInt(m.msgId) < BigInt(from)) : all.slice(-count);
  list = dir === '1' ? list.slice(0, count) : list.slice(-count);
  const body = list.map(m => `{"at":"","atAccountList":[],"content":${JSON.stringify(m.content)},"contentType":"TEXT_MSG","groupId":"g-phone","groupType":0,"msgId":${m.msgId},"receiver":"g-phone","sender":${JSON.stringify(m.sender)},"serverSendTime":${m.serverSendTime}}`);
  out(`{"respData":{"chatInfo":[${body.join(',')}],"msgTotalCount":${list.length}},"resultCode":"0","resultContext":"Operate Success"}`);
} else if (group === 'im' && sub === 'send-to-group') {
  if (arg('--group-id') !== 'g-phone') { process.stderr.write('group not found\n'); process.exitCode = 1; }
  else { addPhoneMessage('user001', arg('--text') || ''); out('{"code":0,"message":"success"}'); }
} else if (group === 'im' && sub === 'query-group-member') {
  out({ code: 0, data: { memberList: arg('--group-id') === 'g-phone'
    ? [{ account: 'user001', name: '用户甲' }, { account: 'xiaowei_bot', name: '小微助手' }]
    : [{ account: 'user001', name: '用户甲' }, { account: 'colleague_b', name: '同事乙' }, { account: 'colleague_c', name: '同事丙' }] } });
} else if (group === 'im' && sub === 'query-history-message') {
  // 和真机同形（Q-1018-04）：msgId 长整数、sender 是账号、serverSendTime 毫秒、at / atAccountList；
  // 不带 --message-id 取最新的 --query-count 条；direction 0 取更旧的、1 取更新的；每次调用记进日志，测试据此核对翻页。
  const conv = arg('--user-account') || arg('--group-id');
  const base = { colleague_a: 7100000000000000000n, 'g-100': 7200000000000000000n, 'g-200': 7400000000000000000n, colleague_d: 7500000000000000000n }[conv] || 7600000000000000000n;
  const msg = (n, sender, minutesAgo, content, atList = [], at = atList.length > 0) => ({ msgId: String(base + BigInt(n) * 3n), sender, serverSendTime: now - minutesAgo * M, content, at, atAccountList: atList });
  const lists = {
    colleague_a: [msg(1, 'user001', 30 * 60, '好的，我周五前把评估报告发你'), msg(2, 'colleague_a', 5 * 60, '评审材料能先帮我看一下吗？')],
    'g-100': [msg(1, 'colleague_b', 120, '仿真基线已更新，请大家确认'), msg(2, 'colleague_c', 20, '版本转测时间定在下周一'), msg(3, 'colleague_b', 10, '@所有人 明天上午系统维护', [], true)],
    // 150 条的大群（开了免打扰）：两页取不完；第 140 条有人 @ 我；最早的 10 条在 40 小时前（超出 36 小时回看）。
    'g-200': Array.from({ length: 150 }, (_, i) => i === 139 ? msg(i + 1, 'colleague_e', (150 - i) * 12, '@用户甲 周报模板请今天下班前更新一下', ['user001']) : msg(i + 1, 'colleague_' + 'efgh'[i % 4], i < 10 ? 40 * 60 - i : (150 - i) * 12, `第 ${i + 1} 条：日常讨论`)),
    colleague_d: [msg(1, 'colleague_d', 50, '下午的对齐会挪到 4 点了')],
  };
  const all = lists[conv] || [];
  if (process.env.WELINK_STANDIN_FOUNDATION === '1' && conv === 'g-100') {
    all.push(msg(50, 'colleague_z', 1, '本轮验收材料\n' + '背景说明  '.repeat(100) + '\n最终决定：周三交付。'));
  }
  const from = arg('--message-id'), dir = arg('--query-direction'), count = Number(arg('--query-count') || 20);
  // 真机往更旧翻时把起点那条也带上（Q-1018-10：重叠 1 条），往更新翻时同样处理，Hub 要按编号去重。
  let list = from ? all.filter(m => dir === '1' ? BigInt(m.msgId) >= BigInt(from) : BigInt(m.msgId) <= BigInt(from)) : all;
  list = dir === '1' ? list.slice(0, count) : list.slice(-count);
  const body = list.map(m => `{"at":${m.at},"atAccountList":${JSON.stringify(m.atAccountList)},"content":${JSON.stringify(m.content)},"contentType":"TEXT_MSG","groupId":${arg('--group-id') && /^\d+$/.test(arg('--group-id')) ? arg('--group-id') : 0},"groupType":0,"msgId":${m.msgId},"receiver":"","sender":${JSON.stringify(m.sender)},"serverSendTime":${m.serverSendTime}}`);
  const ids = list.map(m => m.msgId);
  out(`{"respData":{"chatInfo":[${body.join(',')}],"maxMsgId":${ids.at(-1) || 0},"minMsgId":${ids[0] || 0},"msgTotalCount":${list.length}},"resultCode":"0","resultContext":"Operate Success"}`);
} else if (group === 'mail' && sub === 'list' && exchangeFile && !exchangeReady()) {
  needExchange();
} else if (group === 'mail' && sub === 'list') {
  out({ mails: [
    { id: 'mail-1', subject: '例会材料征集（今天 17:00 截止）', from: { name: '部门秘书' }, receivedTime: now - 3 * H, importance: 'High' },
    { id: 'mail-2', subject: '周报汇总', from: '同事乙', receivedTime: now - 6 * H },
  ] });
} else if (group === 'mail' && sub === 'autodiscover') {
  if (exchangeFile) fs.writeFileSync(exchangeFile, String(arg('--email') || ''));
  out('Autodiscover OK\n');
} else {
  process.stderr.write('unknown command: ' + args.join(' ') + '\n');
  process.exitCode = 2;
}

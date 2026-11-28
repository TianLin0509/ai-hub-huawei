'use strict';
// 按一键反馈口径脱敏，只留最新 KEEP 份；发送超时的提示能找回同一会话最近一份现场。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { dumpStartTimeout, recentDumpFor, KEEP } = require('../core/cli-start-timeout-dump');

test('超时现场：最后一屏是纯文字、已脱敏，只留最新 KEEP 份，写不了不抛错', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-start-dump-'));
  try {
    const home = os.homedir();
    const screen = '\x1b[2J\x1b[H\x1b[1mCodeAgent\x1b[0m 2.9.0\r\n需要先登录：打开 https://example.invalid/login?token=SECRET123456\r\n'
      + `配置目录：${home}\\.codeagent\r\n等待登录中…\r\n`;
    const file = dumpStartTimeout({ dataDir, sid: '38252b13-2109-4e42-b11d-0c7088262966', kind: 'codeagent', buf: screen, waitedMs: 60000 });
    assert.ok(file.startsWith(path.join(dataDir, 'diagnostics', 'cli-start-timeouts')), file);
    assert.match(path.basename(file), /^\d{8}-\d{6}-38252b13-codeagent\.txt$/);
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /等了 60 秒/);
    assert.match(body, /需要先登录[\s\S]*等待登录中/, '还原后的最后一屏里能看到它停在哪');
    assert.ok(!/\x1b\[/.test(body.split('原始字节末尾')[0]), '最后一屏是纯文字');
    assert.ok(!body.includes(home), '去掉了用户目录');
    assert.ok(!body.includes('SECRET123456'), '去掉了链接里的 token');
    assert.equal(recentDumpFor({ dataDir, sid: '38252b13-2109-4e42-b11d-0c7088262966' }), file, '发送超时能找回这一份');
    assert.equal(recentDumpFor({ dataDir, sid: 'ffffffff-0000' }), '', '别的会话找不到');
    assert.equal(recentDumpFor({ dataDir, sid: '38252b13-2109', now: Date.now() + 10 * 60 * 1000 }), '', '太久之前的不算');
    const dir = path.dirname(file);
    for (let i = 0; i < KEEP + 5; i++) fs.writeFileSync(path.join(dir, `20200101-0000${String(i).padStart(2, '0')}-old-codeagent.txt`), 'x');
    dumpStartTimeout({ dataDir, sid: 'abc', kind: 'codeagent', buf: 'x' });
    assert.equal(fs.readdirSync(dir).length, KEEP, '只保留最新 KEEP 份');
    assert.ok(fs.readdirSync(dir).some(n => n.includes('38252b13')), '新的留下、旧的删掉');
    assert.equal(dumpStartTimeout({ dataDir: path.join(dataDir, 'nul\0bad'), sid: 'x', kind: 'codeagent', buf: '' }), '', '写不了只返回空串，不抛错');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// 审查阻断（20261128-审查-cli-start-dump-m10-m4.md）：原始字节末尾先转义再脱敏时，Windows 路径的反斜杠成双、
// 用户目录对不上而漏网；换行已变成 \r\n 字面，token 规则碰不到空白，把后面整段吞掉。
test('原始字节末尾：Windows 用户目录照样去掉，token 后面的内容不被吞', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-start-dump-raw-'));
  const realHome = os.homedir;
  const home = String.raw`C:\Users\zhangsan01`;
  os.homedir = () => home; // sanitize 每次调用时读 os.homedir()，这样用例与运行机器无关
  try {
    const raw = '\x1b[1mCodeAgent\x1b[0m\r\n'
      + `配置目录：${home}\\.codeagent\\settings.json\r\n`
      + '登录链接 https://x.invalid/a?token=SECRET123456\r\n'
      + '后面这行要留下：等待登录中\r\n';
    const file = dumpStartTimeout({ dataDir, sid: 'rawtest1', kind: 'codeagent', buf: raw, waitedMs: 60000 });
    const tail = fs.readFileSync(file, 'utf8').split('原始字节末尾')[1];
    assert.ok(tail, '有原始字节末尾段');
    assert.ok(!tail.includes('zhangsan01'), '转义段里没有用户目录');
    assert.ok(!tail.includes('SECRET123456'), 'token 已去掉');
    assert.match(tail, /后面这行要留下：等待登录中/, 'token 之后的内容没有被吞');
    assert.match(tail, /\.codeagent\\\\settings\.json/, '路径其余部分保留（转义后的反斜杠）');
  } finally {
    os.homedir = realHome;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('接线：60 秒就绪检查失败的提示带现场文件；CodeAgent 发送超时的提示也补上', () => {
  const watcher = fs.readFileSync(path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), 'utf8');
  const branch = watcher.slice(watcher.indexOf("await logStartupBlock(sid, 'cli-not-ready', buf);"), watcher.indexOf("sessionManager.setGroupChatReady(sid, true);\n  }"));
  assert.match(branch, /dumpStartTimeout\(\{ sid, kind, buf, waitedMs: 60000 \}\)/);
  assert.match(branch, /终端最后一屏已存：\$\{screenFile\}/);
  const submit = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js'), 'utf8');
  assert.match(submit, /未能接收消息，本条未发送；请检查终端状态后重新发送。' \+ startScreenNote\(request\?\.sessionId\)/);
});

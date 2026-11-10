'use strict';

// This tool only prepares a file. It never runs CodeAgent or sends a prompt.
const fs = require('node:fs');
const path = require('node:path');
const { forkClaudePrefix, listTranscriptTurns, readStableTranscript, projectSlug, reasonText } = require('../core/claude-prefix-fork');
const { resolveCodeAgentConfig } = require('../core/codeagent-config');
const { getHubDataDir } = require('../core/data-dir');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HELP = `截断复制手动测试（先等源会话回答结束）
  node scripts/codeagent-prefix-fork-try.js --list [--cwd <目录>] [--config-dir <目录>]
  node scripts/codeagent-prefix-fork-try.js --session <ID> [--cwd <目录>] [--config-dir <目录>]
  node scripts/codeagent-prefix-fork-try.js --session <ID> --before <轮号> [--cwd <目录>] [--config-dir <目录>]

没有 Node 时，在 PowerShell 用 Hub 自带的 Electron 运行同一脚本：
  $env:ELECTRON_RUN_AS_NODE = '1'
  & 'C:\\Hub\\electron.exe' '.\\scripts\\codeagent-prefix-fork-try.js' --list --cwd 'C:\\example-project'
  Remove-Item Env:ELECTRON_RUN_AS_NODE
将 electron.exe 路径换成 Hub 实际附带的可执行文件路径；其余参数和 Node 运行方式一致。
默认工作目录为当前目录，默认账号目录由 Hub 的 CodeAgent 配置解析器读取。
号池账号请显式传入 --config-dir，勿用其他号的目录。新会话输入框应为空，不预填问题。
只复制聊天上下文，不回滚项目文件或工具的操作。
`;

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (['--help', '--list'].includes(name)) {
      if (opts[name]) throw new Error('参数重复');
      opts[name] = true;
    } else if (['--session', '--before', '--cwd', '--config-dir'].includes(name)) {
      if (opts[name] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数缺少值或重复');
      opts[name] = args[++i];
    } else throw new Error('不认识的参数，请使用 --help');
  }
  if (opts['--help']) return opts;
  if (!!opts['--list'] === !!opts['--session'] || opts['--list'] && opts['--before']) throw new Error('请选择 --list 或 --session');
  if (opts['--session'] && !UUID.test(opts['--session'])) throw new Error('会话 ID 必须是完整 UUID');
  if (opts['--before'] && (!/^[1-9]\d*$/.test(opts['--before']) || !Number.isSafeInteger(Number(opts['--before'])))) throw new Error('轮号必须是从 1 开始的整数');
  return opts;
}

function appendRunLog(entry) {
  const line = JSON.stringify({ sessionId: entry.sessionId || null, newSessionId: entry.newSessionId || null,
    sessionIds: entry.sessionIds || [], keptLines: entry.keptLines || 0, droppedLines: entry.droppedLines || 0,
    reason: entry.reason }) + '\n';
  try {
    const dir = path.join(getHubDataDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'codeagent-prefix-fork.log'), line, 'utf8');
  } catch {
    fs.appendFileSync(path.join(process.cwd(), 'codeagent-prefix-fork.log'), line, 'utf8');
  }
}

function psLiteral(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function statText(stat) { return `size=${stat.size} bytes, mtime=${new Date(stat.mtimeMs).toISOString()} (${stat.mtimeMs})`; }

function run(args) {
  const log = { reason: 'invalid-arguments' };
  try {
    let opts;
    try { opts = parseArgs(args); }
    catch (error) { console.error('未执行：' + error.message); return 1; }
    if (opts['--help']) { console.log(HELP); log.reason = 'help'; return 0; }
    log.reason = 'file-access-failed';
    const config = resolveCodeAgentConfig(), configDir = path.resolve(opts['--config-dir'] || config.configDir);
    const cwd = path.resolve(opts['--cwd'] || process.cwd()), bucket = path.join(configDir, 'projects', projectSlug(cwd));
    if (opts['--list']) {
      const names = fs.existsSync(bucket) ? fs.readdirSync(bucket).filter(name => UUID.test(name.replace(/\.jsonl$/, '')) && name.endsWith('.jsonl')) : [];
      const files = names.map(name => ({ id: name.slice(0, -6), file: path.join(bucket, name), stat: fs.statSync(path.join(bucket, name)) }))
        .filter(row => row.stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 5);
      console.log('会话 ID | 修改时间 | 轮数');
      log.sessionIds = files.map(row => row.id);
      for (const row of files) {
        const read = readStableTranscript(row.file);
        console.log(`${row.id} | ${new Date(row.stat.mtimeMs).toISOString()} | ${read.ok ? listTranscriptTurns(read.rows).length : reasonText(read.reason)}`);
      }
      if (!files.length) console.log('该工作目录没有找到会话记录。');
      log.reason = 'listed';
      return 0;
    }
    log.sessionId = opts['--session'];
    const file = path.join(bucket, opts['--session'] + '.jsonl'), read = readStableTranscript(file);
    if (!read.ok) { log.reason = read.reason; console.error('未执行：' + reasonText(read.reason)); return 1; }
    const turns = listTranscriptTurns(read.rows);
    if (!opts['--before']) {
      console.log('轮号 | 用户 UUID | 问题前 30 字');
      turns.forEach((turn, index) => console.log(`${index + 1} | ${turn.uuid} | ${Array.from(turn.text.replace(/\s+/g, ' ')).slice(0, 30).join('')}`));
      if (!turns.length) console.log('没有可定位的真实提问轮次。');
      log.keptLines = read.rows.length;
      log.reason = 'turns-listed';
      return 0;
    }
    const selected = turns[Number(opts['--before']) - 1];
    if (!selected) { log.reason = 'invalid-turn-number'; console.error('未执行：该轮号不存在。'); return 1; }
    const before = fs.statSync(file);
    const result = forkClaudePrefix({ sourceFile: file, configDir, cwd, cutUserUuid: selected.uuid });
    const after = fs.statSync(file);
    console.log('源文件截断前：' + statText(before));
    console.log('源文件截断后：' + statText(after));
    console.log('源文件 size/mtime 一致：' + (before.size === after.size && before.mtimeMs === after.mtimeMs ? '是' : '否（源会话可能仍在写入，请先停止操作）'));
    Object.assign(log, { newSessionId: result.newSessionId, keptLines: result.keptLines, droppedLines: result.droppedLines, reason: result.reason || 'created' });
    if (!result.ok) { console.error('未执行：' + reasonText(result.reason)); return 1; }
    console.log('新会话 ID：' + result.newSessionId);
    console.log('新会话文件：' + result.file);
    console.log(`保留 ${result.keptLines} 行，去掉 ${result.droppedLines} 行（非空 JSON 记录）。`);
    console.log('下一步在 PowerShell 执行（本工具没有启动 CLI）：');
    console.log('Set-Location -LiteralPath ' + psLiteral(cwd));
    console.log('$env:' + config.configDirEnv + ' = ' + psLiteral(configDir));
    console.log('& ' + psLiteral(config.command) + ' --resume ' + psLiteral(result.newSessionId));
    return 0;
  } catch {
    console.error('未执行：参数或文件读取失败，请检查目录和权限，使用 --help 查看用法。');
    return 1;
  } finally {
    try { appendRunLog(log); }
    catch { console.error('运行日志无法写入 Hub 日志目录或当前目录。'); }
  }
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));
module.exports = { run };

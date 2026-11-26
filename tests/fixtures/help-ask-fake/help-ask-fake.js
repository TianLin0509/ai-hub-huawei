'use strict';
// 「问问 Hub」端到端用的假 CodeAgent：-p 单次问答时读标准输入，回一条 JSON result（不调用任何模型）；
// --help 照公司 CodeAgent 1.2615 实际有的参数回一份（2026-11-19 维护人取回），引擎据此加只读参数；
// 没收到只读参数 --tools "" 就回错误，端到端顺带验证参数经 cmd 传到了。
// 其余调用（版本、交互会话等）原样交给号池测试用的假 CodeAgent。
const path = require('path');
const args = process.argv.slice(2);
const HELP = ['Usage: codeagent [options]', '  -p, --print', '  --model <model>', '  --output-format <format>', '  --effort <level>',
  '  --tools <tools...>', '  --permission-mode <mode>', '  --strict-mcp-config', '  --no-session-persistence', '  --disable-update', '  --skip-safe-check', ''].join('\n');
const reply = obj => process.stdout.write(JSON.stringify(obj) + '\n', () => process.exit(0));

if (args[0] === '--help') {
  process.stdout.write(HELP, () => process.exit(0));
} else if (args.includes('-p') || args.includes('--print')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    const readOnly = args.includes('--tools') && args[args.indexOf('--tools') + 1] === '' && args.includes('--strict-mcp-config');
    if (!readOnly) return reply({ type: 'result', is_error: true, result: '测试替身：没收到只读参数' });
    const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'CLI 默认';
    if (model === 'fixture-auth-failure') return reply({ type: 'result', is_error: true, result: 'Not logged in: fixture auth failure' });
    const q = (/【用户问题】\n([\s\S]*)$/.exec(input) || [])[1] || '';
    if (model === 'fixture-model-denied' || q.includes('换模型仍失败出口')) return reply({ type: 'result', is_error: true,
      result: `您当前的模型 ${model} 可能已经升级或被调整了权限` });
    const hasManual = input.includes('【使用说明书开始】') && input.includes('## 2. 界面地图');
    const answer = `【测试替身】${hasManual ? '已收到说明书' : '没收到说明书'}，只读参数已带上，模型：${model}。你问的是：${q.trim()}\n\n设置菜单 →「⚙️ 设置」→「回车键」。`;
    setTimeout(() => reply({ type: 'result', is_error: false, result: answer }), 2500);
  });
} else {
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'codeagent-pool-fake', 'codeagent-fake.js'), ...args], { stdio: 'inherit', windowsHide: true });
  process.exit(r.status == null ? 1 : r.status);
}

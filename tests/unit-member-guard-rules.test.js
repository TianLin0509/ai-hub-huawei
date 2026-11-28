'use strict';
// 每类至少 2 个应拦、3 个不应拦；误拦一次的代价大于漏拦，所以不应拦的样例故意贴着边界写。
const test = require('node:test');
const assert = require('node:assert');
const { classify, redirectTargets } = require('../core/member-guard-rules');

const CWD = 'D:\\Work\\20261123-组队任务';
const JOINED = Date.parse('2026-11-23T10:00:00Z');
const branches = {
  'd:\\work\\20261123-member-guard-m3': 'feat/member-guard-20261123-m3',
  'd:\\src\\core-repo': 'master',
  'd:\\work\\20261123-组队任务': null,
  'd:\\work\\other-main': 'main',
};
const births = {
  'd:\\work\\20261123-member-guard-m3': JOINED + 5 * 60 * 1000, // 成员入队后自己建的 worktree
  'd:\\work\\20261001-老项目': JOINED - 30 * 24 * 3600 * 1000,
  'c:\\work\\other-task': JOINED - 3600 * 1000,
};
const ctx = (extra = {}) => ({
  cwd: CWD, access: 'write', joinedAt: JOINED,
  env: { USERPROFILE: 'C:\\Users\\you', TEMP: 'D:\\Temp' },
  allowRoots: [CWD, 'D:\\Temp', 'D:\\Temp\\claude\\scratch'],
  tempRoots: ['D:\\Temp'],
  workRoots: ['D:\\Work', 'C:\\Work'],
  hubDataDir: 'C:\\Users\\you\\.ai-hub-community',
  hubProgramDir: 'D:\\Src\\core-repo',
  protectedPids: new Set([4242]),
  branchOf: async dir => branches[dir.toLowerCase()] ?? null,
  dirBirth: async dir => dir.toLowerCase() in births ? births[dir.toLowerCase()] : null,
  ...extra,
});
const bash = command => ({ toolName: 'Bash', toolInput: { command } });
async function expectBlock(input, category, c = ctx()) {
  const hit = await classify(typeof input === 'string' ? bash(input) : input, c);
  assert.ok(hit, `应拦：${JSON.stringify(input)}`);
  assert.strictEqual(hit.category, category, `${JSON.stringify(input)} 应归 ${category}，实际 ${hit.category}：${hit.reason}`);
}
async function expectAllow(input, c = ctx()) {
  const hit = await classify(typeof input === 'string' ? bash(input) : input, c);
  assert.strictEqual(hit, null, `不应拦：${JSON.stringify(input)} → ${hit && hit.reason}`);
}

test('① git push、合入或改写 master/main', async () => {
  await expectBlock('git push origin feat/x', 'git');
  await expectBlock('cd D:/Work/20261123-member-guard-m3 && git push', 'git');
  await expectBlock('python scripts/merge_task.py --branch feat/x', 'git');
  await expectBlock('git -C D:/Src/core-repo merge feat/x', 'git');
  await expectBlock('git -C D:/Src/core-repo commit -m "x"', 'git');
  await expectBlock('git branch -f master HEAD~1', 'git');
  await expectBlock('git -C D:/Work/other-main reset --hard HEAD~2', 'git');
  // 不应拦：只读 git、worktree 里的 commit、别的项目 main 上的本地提交、中止合并
  await expectAllow('git status --short && git log --oneline -5 && git diff HEAD~1');
  await expectAllow('git -C D:/Work/20261123-member-guard-m3 commit -m "feat: guard"');
  await expectAllow('git -C D:/Work/20261123-member-guard-m3 merge master');
  await expectAllow('git -C D:/Work/other-main commit -m "wip"');
  await expectAllow('git -C D:/Src/core-repo log --oneline -3');
  await expectAllow('git -C D:/Src/core-repo merge --abort');
  await expectAllow('git worktree add -b feat/y D:/Work/20261123-y-m3 master');
  await expectAllow('echo "remember to git push later" > D:/Temp/note.txt');
});

test('② 关闭、重启或成批杀进程（含按命令行子串）', async () => {
  await expectBlock('taskkill /F /IM "AI Hub Community.exe"', 'hub');
  await expectBlock('Get-Process electron | Stop-Process -Force', 'hub');
  await expectBlock('Stop-Process -Name node -Force', 'hub');
  await expectBlock('Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*ai-hub-community*" } | ForEach-Object { Stop-Process -Id $_.ProcessId }', 'hub');
  await expectBlock('pkill -f hub-launcher', 'hub');
  await expectBlock('taskkill /PID 4242 /F', 'hub');
  // 不应拦：按 PID 结束自己起的隔离 Hub / 测试进程、只看进程、起隔离 Hub
  await expectAllow('taskkill /PID 31337 /T /F');
  await expectAllow('Stop-Process -Id 31337 -Force');
  await expectAllow('Get-Process electron | Select-Object Id, StartTime');
  await expectAllow('node tests/helpers/hub-launcher.js --data-dir D:/Temp/hub-iso --cdp 9333');
  await expectAllow('kill 31337');
});

test('③ 删除任务目录以外的文件', async () => {
  await expectBlock('rm -rf C:/Users/you/Documents/report', 'del');
  await expectBlock('Remove-Item -Recurse -Force D:\\Work\\20261001-老项目\\out', 'del');
  await expectBlock('del /s /q C:\\Work\\other-task\\*.log', 'del');
  await expectBlock('rm ../20261001-老项目/a.txt', 'del');
  // 不应拦：自己的工作目录、自己入队后建的 worktree、临时目录、相对路径、变量路径
  await expectAllow('rm -rf build/tmp && rm out.json');
  await expectAllow('rm -f D:/Work/20261123-member-guard-m3/tests/tmp.json');
  await expectAllow('Remove-Item -Recurse D:\\Temp\\hub-iso-9333');
  await expectAllow('rm -rf "$SCRATCH_DIR/x"');
  await expectAllow('cmd /c rmdir D:\\Work\\20261123-member-guard-m3\\node_modules');
  await expectAllow('git rm --cached foo.txt');
});

test('④ 改 Hub 生产数据目录下的配置与状态', async () => {
  await expectBlock({ toolName: 'Write', toolInput: { file_path: 'C:\\Users\\you\\.ai-hub-community\\config.json', content: '{}' } }, 'data');
  await expectBlock({ toolName: 'Edit', toolInput: { file_path: 'C:/Users/you/.ai-hub-community/team/867526c7.json' } }, 'data');
  await expectBlock('echo {} > C:/Users/you/.ai-hub-community/config.json', 'data');
  await expectBlock('Set-Content -Path $env:USERPROFILE\\.ai-hub-community\\state.json -Value "{}"', 'data');
  // 不应拦：读取、写 Hub 允许的工作区（transcripts / orchestration / artifacts）、隔离 Hub 的数据目录
  await expectAllow('cat C:/Users/you/.ai-hub-community/config.json | head');
  await expectAllow({ toolName: 'Write', toolInput: { file_path: 'C:\\Users\\you\\.ai-hub-community\\orchestration\\project-briefs\\x.md' } });
  await expectAllow('echo x > C:/Users/you/.ai-hub-community/transcripts/note.txt');
  await expectAllow({ toolName: 'Write', toolInput: { file_path: 'D:\\Temp\\hub-iso\\config.json' } });
  await expectAllow('Get-Content C:\\Users\\you\\.ai-hub-community\\team\\a.json');
});

test('⑤ 读取或使用按量计费 API 密钥', async () => {
  await expectBlock('echo $DEEPSEEK_API_KEY', 'api');
  await expectBlock('python -c "import os; print(os.environ[\'ANTHROPIC_API_KEY\'])"', 'api');
  await expectBlock('curl https://api.openai.com/v1/chat/completions -H "Authorization: Bearer x"', 'api');
  // 公司语境：Hub 保存的部门 API key（api-gateway/gateway.json）直接读也算
  await expectBlock('cat C:/Users/you/.ai-hub-community/api-gateway/gateway.json', 'api');
  await expectBlock(String.raw`Get-Content $env:USERPROFILE\.ai-hub-community\api-gateway\gateway.json`, 'api');
  // 不应拦：CodeAgent CLI、直接访问部门网关（不带 key 调不通；拿不准放行）、普通联网
  await expectAllow('codeagent -p "hi"');
  await expectAllow('curl -s https://gateway.example.com/v1/models');
  await expectAllow('ls C:/Users/you/.ai-hub-community/api-gateway');
  await expectAllow('curl -s https://api-docs.deepseek.com/zh-cn/quick_start/pricing | head');
  await expectAllow('grep -rn "apiKey" core/ | head');
  await expectAllow('grep -rn "DEEPSEEK_API_KEY" core/ scripts/ | head');
  await expectBlock('Write-Output $env:OPENAI_API_KEY', 'api');
});

test('只读成员：拒写文件，允许读与跑测试', async () => {
  const ro = ctx({ access: 'read' });
  await expectBlock({ toolName: 'Write', toolInput: { file_path: CWD + '\\a.md' } }, 'read', ro);
  await expectBlock({ toolName: 'Edit', toolInput: { file_path: 'core/x.js' } }, 'read', ro);
  await expectBlock('git commit -am x', 'read', ro);
  await expectBlock('echo hi > notes.md', 'read', ro);
  await expectBlock('sed -i s/a/b/ core/x.js', 'read', ro);
  await expectAllow('git status && git diff master...HEAD && git log -3', ro);
  await expectAllow('node --test tests/unit-member-guard-rules.test.js 2>&1 | tail -5', ro);
  await expectAllow({ toolName: 'Write', toolInput: { file_path: 'D:\\Temp\\review-notes.md' } }, ro);
  await expectAllow('grep -rn "x" core > D:/Temp/hits.txt', ro);
  await expectAllow({ toolName: 'Read', toolInput: { file_path: 'core/x.js' } }, ro);
});

test('写权限成员：普通开发不受影响', async () => {
  await expectAllow({ toolName: 'Write', toolInput: { file_path: CWD + '\\a.md' } });
  await expectAllow('npm test 2>&1 > D:/Temp/t.log; echo done');
  await expectAllow('node -e "console.log(1 > 0)"');
});

// ---------- Codex 审查返工（2026-11-23）的回归样本：撤掉对应修复会失败 ----------
test('返工④：cd 之后的命令按新目录判定；master 上 reset HEAD~1 算改写，撤暂存不算', async () => {
  await expectBlock('cd D:/Src/core-repo && git merge feat/x', 'git');
  await expectBlock('cd C:/Users/you/Documents && rm -rf report', 'del');
  await expectBlock(String.raw`Set-Location -Path D:\Src\core-repo; git rebase feat/x`, 'git');
  await expectBlock('git -C D:/Src/core-repo reset HEAD~1', 'git');
  await expectBlock('cd D:/Src/core-repo && git reset 3e720eb7', 'git');
  await expectAllow('cd D:/Work/20261123-member-guard-m3 && rm -rf tests/tmp && git merge master');
  await expectAllow('git -C D:/Src/core-repo reset HEAD core/x.js');
  await expectAllow('git -C D:/Src/core-repo reset -- core/x.js');
  await expectAllow('cd D:/Temp && rm -rf hub-iso');
});

test('返工⑤：复制生产配置到临时目录只算读；只有真正发请求才算调用计费 API', async () => {
  await expectAllow('cp C:/Users/you/.ai-hub-community/config.json D:/Temp/cfg.json');
  await expectAllow(String.raw`Copy-Item C:\Users\you\.ai-hub-community\config.json -Destination D:\Temp\c.json`);
  await expectBlock('cp D:/Temp/c.json C:/Users/you/.ai-hub-community/config.json', 'data');
  await expectBlock(String.raw`Copy-Item D:\Temp\c.json -Destination C:\Users\you\.ai-hub-community\config.json`, 'data');
  await expectAllow('rg api.openai.com core');
  await expectAllow('grep -rn "https://api.deepseek.com" core scripts | head');
  await expectBlock(`node -e "fetch('https://api.openai.com/v1/models')"`, 'api');
  await expectBlock('Invoke-RestMethod -Uri https://api.deepseek.com/chat/completions -Method Post', 'api');
  await expectBlock('powershell -Command "Invoke-RestMethod https://api.anthropic.com/v1/messages"', 'api');
  // 只读成员复制：目标在临时目录放行，在工作区拒绝
  await expectAllow('cp core/x.js D:/Temp/x.js', ctx({ access: 'read' }));
  await expectBlock('cp D:/Temp/x.js core/x.js', 'read', ctx({ access: 'read' }));
});

// ---------- Codex 复审返工 2（2026-11-23）的回归样本 ----------
test('返工2-②：cp/mv -t、--target-directory 写进生产数据目录要拦', async () => {
  await expectBlock('cp -t C:/Users/you/.ai-hub-community/team D:/Temp/a.json', 'data');
  await expectBlock('mv --target-directory=C:/Users/you/.ai-hub-community/team D:/Temp/a.json', 'data');
  await expectBlock('cp --target-directory C:/Users/you/.ai-hub-community/team D:/Temp/a.json', 'data');
  await expectAllow('cp -t D:/Temp C:/Users/you/.ai-hub-community/team/a.json');
});

test('返工2-③：pushd 之后 popd 回到原目录，不误拦', async () => {
  await expectAllow('pushd C:/Users/you/Documents && popd && rm -rf build/tmp');
  await expectAllow('Push-Location D:/Src/core-repo; Pop-Location; git merge master');
  await expectBlock('pushd C:/Users/you/Documents && rm -rf report && popd', 'del');
});

test('返工2-④：带路径的 reset 只改暂存区，不算改写 master', async () => {
  await expectAllow('git -C D:/Src/core-repo reset HEAD~1 core/x.js');
  await expectAllow('git -C D:/Src/core-repo reset HEAD~1 -- core/x.js');
  await expectBlock('git -C D:/Src/core-repo reset HEAD~1', 'git');
});

test('重定向识别：引号里的 > 和 2>&1、/dev/null 不算写', () => {
  assert.deepStrictEqual(redirectTargets('echo "a > b" 2>&1 > /dev/null'), []);
  assert.deepStrictEqual(redirectTargets('cmd >> out.log 2> err.txt'), ['out.log', 'err.txt']);
});

// ---------- HUB-H 公司语境（2026-11-28 移植时新增） ----------
test('HUB-H: trunk/develop are trunks by default; the protected list can be set; Hub image names are covered', async () => {
  const repo = { 'd:\\work\\svc': 'develop', 'd:\\work\\lib': 'trunk', 'd:\\work\\feat': 'feature/x' };
  const c = extra => ctx({ branchOf: async dir => repo[dir.toLowerCase()] ?? null, ...extra });
  await expectBlock('git -C D:/Work/svc rebase origin/feature/x', 'git', c());
  await expectBlock('git -C D:/Work/lib reset --hard HEAD~1', 'git', c());
  await expectBlock('git update-ref refs/heads/develop HEAD~1', 'git', c());
  await expectAllow('git -C D:/Work/feat rebase develop', c());
  await expectAllow('git -C D:/Work/svc rebase origin/feature/x', c({ protectedBranches: ['master'] }));
  await expectBlock('git -C D:/Work/feat merge x', 'git', c({ protectedBranches: ['feature/x'] }));
  await expectBlock('taskkill /IM "AI Hub Community.exe" /F', 'hub');
  await expectBlock('Stop-Process -Name "AI Hub Community"', 'hub');
});

test('HUB-H: the data dir state folders (team roster, account pool, launch settings, API gateway) are protected; work folders are not', async () => {
  const root = 'C:/Users/you/.ai-hub-community';
  for (const sub of ['team/abc.json', 'codeagent-pool/acc.json', 'codeagent-launch/s.json', 'api-gateway/gateway.json', 'state.json'])
    await expectBlock({ toolName: 'Write', toolInput: { file_path: `${root}/${sub}` } }, 'data');
  for (const sub of ['transcripts/a.md', 'orchestration/x.md', 'task-docs/t.md', 'logs/x.log', 'diagnostics/d.json'])
    await expectAllow({ toolName: 'Write', toolInput: { file_path: `${root}/${sub}` } });
});

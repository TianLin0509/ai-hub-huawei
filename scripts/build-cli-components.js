#!/usr/bin/env node
'use strict';
// 打 CLI 一键安装的组件包（2026-11-07），在发布机上跑；只生成文件，不上传任何地方。
//
//   node scripts/build-cli-components.js --out D:\AI-Artifacts\cli-components --key <私钥.pem>
//   node scripts/build-cli-components.js --dry-run                 只打印计划（会查版本号，不下载）
//   node scripts/build-cli-components.js --gen-key <私钥.pem>      生成签名钥匙对，打印公钥（写进 core/cli-tools/catalog.js）
//
// 选项：--only claude,codex,dsh,node   --claude-version latest|stable|x.y.z   --codex-version latest|x.y.z
//       --dsh-version 0.2.1-rc.2 --dsh-tui-version 0.16.1   --dsh-from <已装好的运行环境目录>（直接打包它，不再 npm install）
//       --node-version v22.x.y（默认取 22 系列最新）   --registry https://registry.npmmirror.com
//       --mirror-claude（Claude Code 也放一份到自家源，默认只写官方地址；许可见报告）
//
// 产物：<out>/components/components.json（已签名）和 <out>/components/<组件>/<版本>/<文件>。
// 上传时把 <out>/components 整个目录原样放到自家主机的 /hub-update/components/ 下。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { packTgz, listTree, extractTgz } = require('../core/cli-tools/tar');
const catalogLib = require('../core/cli-tools/catalog');

const DEFAULTS = { registry: 'https://registry.npmmirror.com', claude: 'latest', codex: 'latest', dsh: '0.2.1-rc.2', dshTui: '0.16.1', node: '22' };
const NPMJS = 'https://registry.npmjs.org';
const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases';
const NODE_MIRROR = 'https://registry.npmmirror.com/-/binary/node';

function parseArgs(argv) {
  const o = { only: ['claude', 'codex', 'dsh', 'node'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 缺少参数`); return v; };
    if (a === '--out') o.out = path.resolve(next());
    else if (a === '--key') o.key = path.resolve(next());
    else if (a === '--gen-key') o.genKey = path.resolve(next());
    else if (a === '--only') o.only = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--claude-version') o.claude = next();
    else if (a === '--codex-version') o.codex = next();
    else if (a === '--dsh-version') o.dsh = next();
    else if (a === '--dsh-tui-version') o.dshTui = next();
    else if (a === '--dsh-from') o.dshFrom = path.resolve(next());
    else if (a === '--node-version') o.node = next();
    else if (a === '--registry') o.registry = next().replace(/\/+$/, '');
    else if (a === '--mirror-claude') o.mirrorClaude = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error('不认识的参数：' + a);
  }
  for (const id of o.only) if (!catalogLib.IDS.includes(id)) throw new Error('不认识的组件：' + id);
  return { ...DEFAULTS, ...o };
}

const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
const log = (...args) => console.log('[cli-components]', ...args);

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

// 下载到 dest（先写 .part），边下边算 sha256 / sha512；已存在且 sha 对得上就复用。
async function download(url, dest, { sha512b64, sha256 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const h = await hashFile(dest);
    if ((!sha512b64 || h.sha512b64 === sha512b64) && (!sha256 || h.sha256 === sha256)) { log('复用已下载的', path.basename(dest)); return { ...h, bytes: fs.statSync(dest).size }; }
  }
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`${url} → HTTP ${r.status}`);
  const part = dest + '.part';
  const out = fs.createWriteStream(part);
  const h256 = crypto.createHash('sha256'), h512 = crypto.createHash('sha512');
  let bytes = 0, last = 0;
  for await (const chunk of r.body) {
    const b = Buffer.from(chunk);
    h256.update(b); h512.update(b); bytes += b.length;
    if (!out.write(b)) await new Promise(resolve => out.once('drain', resolve));
    if (Date.now() - last > 3000) { last = Date.now(); log(`  ${path.basename(dest)} ${mb(bytes)}`); }
  }
  await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  const got = { sha256: h256.digest('hex'), sha512b64: h512.digest('base64'), bytes };
  if (sha512b64 && got.sha512b64 !== sha512b64) { fs.rmSync(part, { force: true }); throw new Error(`${url} 的 sha512 与 npm 登记的不一致`); }
  if (sha256 && got.sha256 !== sha256) { fs.rmSync(part, { force: true }); throw new Error(`${url} 的 sha256 与官方清单不一致`); }
  fs.renameSync(part, dest);
  return got;
}
async function hashFile(file) {
  const h256 = crypto.createHash('sha256'), h512 = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) { h256.update(chunk); h512.update(chunk); }
  return { sha256: h256.digest('hex'), sha512b64: h512.digest('base64') };
}
const sha512Of = integrity => { const m = /^sha512-(.+)$/.exec(String(integrity || '')); return m ? m[1] : null; };

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', ...opts },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(String(stdout || '').trim())));
}

async function npmMeta(registry, pkg, spec) { return getJson(`${registry}/${pkg}/${encodeURIComponent(spec)}`); }
function officialTarballs(pkg, file) { return [`https://registry.npmmirror.com/${pkg}/-/${file}`, `${NPMJS}/${pkg}/-/${file}`]; }

// ---------- 各组件的计划 ----------
async function planClaude(o) {
  const pkg = '@anthropic-ai/claude-code-win32-x64';
  const meta = await npmMeta(o.registry, pkg, o.claude);
  const file = path.basename(new URL(meta.dist.tarball).pathname);
  return { id: 'claude', name: 'Claude Code', version: meta.version, pkg, meta, file, license: 'Anthropic 专有许可（见包内 LICENSE.md）',
    preferOfficial: true, mirror: !!o.mirrorClaude, official: officialTarballs(pkg, file),
    install: { strip: 'package', bin: 'claude.exe', pathDirs: ['.'], versionArgs: ['--version'] } };
}
async function planCodex(o) {
  const base = o.codex === 'latest' ? (await npmMeta(o.registry, '@openai/codex', 'latest')).version : o.codex;
  const meta = await npmMeta(o.registry, '@openai/codex', `${base}-win32-x64`);
  const file = path.basename(new URL(meta.dist.tarball).pathname);
  return { id: 'codex', name: 'Codex', version: base, pkg: '@openai/codex', meta, file, license: meta.license || 'Apache-2.0',
    preferOfficial: false, mirror: true, official: officialTarballs('@openai/codex', file),
    install: { strip: 'package/vendor/x86_64-pc-windows-msvc', bin: 'bin/codex.exe', pathDirs: ['bin', 'codex-path'], versionArgs: ['--version'] } };
}
async function planDsh(o) {
  let dsh = o.dsh, tui = o.dshTui;
  if (o.dshFrom) {
    const read = rel => JSON.parse(fs.readFileSync(path.join(o.dshFrom, 'node_modules', rel, 'package.json'), 'utf8'));
    dsh = read('@deepseek-ai/dsh').version; tui = read('@deepseek-harness-tui/dsh-tui').version;
  }
  const version = `${dsh}+tui.${tui}`;
  return { id: 'dsh', name: 'DSH 运行环境', version, dsh, tui, file: `dsh-runtime-${dsh}-tui-${tui}-win32-x64.tgz`, license: 'MIT（@deepseek-ai/dsh、@deepseek-harness-tui/dsh-tui；依赖各自许可）',
    preferOfficial: false, mirror: true, official: [],
    install: { requires: ['node'], minNode: 22, versionArgs: ['--version'], check: ['node_modules/@deepseek-ai/dsh/lib/bin.js', 'node_modules/@deepseek-harness-tui/dsh-tui/package.json'] } };
}
async function planNode(o) {
  let version = o.node;
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    const index = await getJson(`${NODE_MIRROR}/index.json`);
    const hit = index.find(r => r.version.startsWith(`v${String(version).replace(/^v/, '')}.`) && (r.files || []).includes('win-x64-exe'));
    if (!hit) throw new Error('npmmirror 上找不到 Node ' + version + ' 的 Windows 版');
    version = hit.version;
  }
  return { id: 'node', name: 'Node.js 运行环境', version: version.replace(/^v/, ''), nodeTag: version, file: `node-${version}-win-x64.tgz`, license: 'MIT（Node.js）',
    preferOfficial: false, mirror: true, official: [], install: { bin: 'node.exe', pathDirs: ['.'], versionArgs: ['--version'] } };
}

// ---------- 各组件的打包 ----------
async function buildNpmTarball(p, dir, staging) {
  const dest = path.join(dir, p.file);
  const got = await download(p.meta.dist.tarball, dest, { sha512b64: sha512Of(p.meta.dist.integrity) });
  // 解开核对一遍：主程序在不在、能不能跑；Claude 再和官方发布清单里的 claude.exe sha256 对一次。
  const probe = path.join(staging, p.id + '-probe');
  fs.rmSync(probe, { recursive: true, force: true });
  await extractTgz(dest, probe, { strip: p.install.strip });
  const bin = path.join(probe, ...p.install.bin.split('/'));
  if (!fs.existsSync(bin)) throw new Error(`${p.file} 里没有 ${p.install.bin}`);
  if (p.id === 'claude') {
    try {
      const manifest = await getJson(`${CLAUDE_RELEASES}/${p.version}/manifest.json`);
      const want = manifest.platforms?.['win32-x64']?.checksum;
      const have = (await hashFile(bin)).sha256;
      if (want && want !== have) throw new Error('npm 包里的 claude.exe 与官方发布清单的 sha256 不一致，停止');
      log(want ? 'claude.exe 与官方发布清单 sha256 一致' : '官方发布清单里没有 win32-x64 校验值，跳过对照');
    } catch (error) {
      if (/不一致/.test(error.message)) throw error;
      log('警告：读不到 Claude 官方发布清单，跳过对照（' + error.message + '）；需要代理时设 NODE_USE_ENV_PROXY=1');
    }
  }
  p.probeVersion = await run(bin, p.install.versionArgs).catch(error => { throw new Error(`${p.install.bin} 试运行失败：${error.message}`); });
  fs.rmSync(probe, { recursive: true, force: true });
  return { file: dest, bytes: got.bytes, sha256: got.sha256 };
}

async function buildDsh(p, dir, staging, o) {
  let root = o.dshFrom;
  if (!root) {
    root = path.join(staging, 'dsh-runtime');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ai-hub-dsh-runtime', private: true,
      dependencies: { '@deepseek-ai/dsh': p.dsh, '@deepseek-harness-tui/dsh-tui': p.tui } }, null, 2));
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error('找不到 npm：' + npmCli);
    log(`npm install @deepseek-ai/dsh@${p.dsh} @deepseek-harness-tui/dsh-tui@${p.tui}（${o.registry}）…`);
    await run(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--registry', o.registry], { cwd: root });
  }
  for (const rel of p.install.check) if (!fs.existsSync(path.join(root, ...rel.split('/')))) throw new Error('DSH 运行环境不完整：' + rel);
  const entries = listTree(path.join(root, 'node_modules'), 'node_modules');
  for (const name of ['package.json', 'package-lock.json']) if (fs.existsSync(path.join(root, name))) entries.push({ name, file: path.join(root, name) });
  log(`打包 DSH 运行环境：${entries.length} 个文件…`);
  const dest = path.join(dir, p.file);
  await packTgz(entries, dest);
  const h = await hashFile(dest);
  const licenses = ['@deepseek-ai/dsh', '@deepseek-harness-tui/dsh-tui'].map(rel => `${rel} ${JSON.parse(fs.readFileSync(path.join(root, 'node_modules', rel, 'package.json'), 'utf8')).license || '未写'}`);
  p.licenseDetail = licenses.join('；');
  p.fileCount = entries.length;
  return { file: dest, bytes: fs.statSync(dest).size, sha256: h.sha256 };
}

async function buildNode(p, dir, staging) {
  const sums = await getText(`${NODE_MIRROR}/${p.nodeTag}/SHASUMS256.txt`);
  const line = sums.split(/\r?\n/).find(l => /\swin-x64\/node\.exe$/.test(l));
  if (!line) throw new Error('SHASUMS256.txt 里没有 win-x64/node.exe');
  const want = line.split(/\s+/)[0];
  const exe = path.join(staging, 'node', 'node.exe');
  await download(`${NODE_MIRROR}/${p.nodeTag}/win-x64/node.exe`, exe, { sha256: want });
  p.probeVersion = await run(exe, ['--version']);
  const notice = `Node.js ${p.nodeTag} for Windows x64, unmodified official binary (sha256 ${want}).\nLicense: MIT, see https://github.com/nodejs/node/blob/${p.nodeTag}/LICENSE\n`;
  const dest = path.join(dir, p.file);
  await packTgz([{ name: 'node.exe', file: exe }, { name: 'NOTICE.txt', data: notice }], dest);
  const h = await hashFile(dest);
  return { file: dest, bytes: fs.statSync(dest).size, sha256: h.sha256 };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 17).join('\n')); return; }
  if (o.genKey) {
    if (fs.existsSync(o.genKey)) throw new Error('钥匙文件已存在，不覆盖：' + o.genKey);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(o.genKey), { recursive: true });
    fs.writeFileSync(o.genKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log('公钥（写进 core/cli-tools/catalog.js 的 PUBLIC_KEY_HEX）：' + publicKey.export({ type: 'spki', format: 'der' }).toString('hex'));
    return;
  }
  const planners = { claude: planClaude, codex: planCodex, dsh: planDsh, node: planNode };
  const plans = [];
  for (const id of o.only) plans.push(await planners[id](o));
  log('计划：');
  for (const p of plans) {
    const where = [p.mirror ? '自家源' : null, ...(p.official.length ? ['官方地址 ' + p.official.map(u => new URL(u).hostname).join(' / ')] : [])].filter(Boolean).join(' + ');
    log(`  ${p.id.padEnd(6)} ${p.version.padEnd(24)} ${p.file}  [${where}${p.preferOfficial ? '，官方优先' : ''}]  许可：${p.license}`);
  }
  if (o.dryRun) { log('--dry-run：没有下载、没有写文件'); return; }
  if (!o.out) throw new Error('请用 --out 指定输出目录');
  if (!o.key) log('警告：没有 --key，组件目录不签名；Hub 会拒绝未签名的目录');
  const outRoot = path.join(o.out, 'components');
  const staging = path.join(o.out, '.staging');
  fs.mkdirSync(staging, { recursive: true });
  // 已有目录就在它上面增量更新（--only 只重打其中几个时，其余组件保留）。
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(path.join(outRoot, 'components.json'), 'utf8')).components || []; } catch (_) {}
  const components = previous.filter(c => !o.only.includes(c.id));
  const summary = [];
  for (const p of plans) {
    // 不放自家源的组件放到 official-only/，免得和要上传的文件混在一起被误传。
    const dir = p.mirror ? path.join(outRoot, p.id, p.version) : path.join(o.out, 'official-only', p.id, p.version);
    fs.mkdirSync(dir, { recursive: true });
    log(`== ${p.name} ${p.version}`);
    const built = p.id === 'dsh' ? await buildDsh(p, dir, staging, o) : p.id === 'node' ? await buildNode(p, dir, staging) : await buildNpmTarball(p, dir, staging);
    const rel = `${p.id}/${p.version}/${p.file}`;
    // 不放自家源的组件（默认 Claude Code）：文件仍留在输出目录方便核对，但不进目录的 url，也不用上传。
    components.push({ id: p.id, name: p.name, version: p.version, kind: 'tgz', license: p.license, preferOfficial: p.preferOfficial,
      files: [{ name: p.file, bytes: built.bytes, sha256: built.sha256, ...(p.mirror ? { url: rel } : {}), ...(p.official.length ? { official: p.official } : {}) }],
      install: p.install });
    summary.push({ id: p.id, version: p.version, file: rel, bytes: built.bytes, upload: p.mirror, probe: p.probeVersion || '', files: p.fileCount || null, license: p.licenseDetail || p.license });
  }
  components.sort((a, b) => catalogLib.IDS.indexOf(a.id) - catalogLib.IDS.indexOf(b.id));
  let catalog = { schema: 1, publishedAt: new Date().toISOString(), components };
  if (o.key) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(o.key));
    catalog = catalogLib.sign(catalog, privateKey);
    const pub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('hex');
    if (pub !== catalogLib.PUBLIC_KEY_HEX) log('警告：这把私钥和程序里的公钥对不上，Hub 会拒绝这份目录');
    catalogLib.validateCatalog(catalog, { key: crypto.createPublicKey(privateKey) });
  } else catalogLib.validateCatalog(catalog, { key: null });
  fs.writeFileSync(path.join(outRoot, 'components.json'), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  fs.rmSync(staging, { recursive: true, force: true });
  log('完成：' + path.join(outRoot, 'components.json'));
  for (const s of summary) log(`  ${s.id.padEnd(6)} ${s.version.padEnd(24)} ${mb(s.bytes).padStart(9)}  ${s.upload ? '要上传' : '不上传（只走官方地址）'}  ${s.file}${s.files ? `（${s.files} 个文件）` : ''}${s.probe ? `  试运行：${s.probe.split('\n')[0]}` : ''}`);
  log('上传：把 ' + outRoot + ' 下「要上传」的文件和 components.json 按相同相对路径放到自家主机 /hub-update/components/ 下；components.json 最后传。');
}

if (require.main === module) main().catch(error => { console.error('[cli-components] 失败：' + error.message); process.exit(1); });
module.exports = { parseArgs };

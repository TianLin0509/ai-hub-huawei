'use strict';
// 组件包的 .tgz 读写（2026-11-07，CLI 一键安装）。只用 Node 自带的 zlib，不依赖第三方包。
//
// 解压（extractTgz）是流式的：边解 gzip 边写盘，几百 MB 的包也不整个读进内存；写盘全用异步 fs，
// DSH 运行环境约 7 万个小文件，同步写会把 Electron 主进程卡住几十秒。
// 只认普通文件和目录（含 pax / GNU 长文件名头）；链接、设备等一律拒绝，路径不许跳出目标目录。
// strip：只取这个前缀下面的条目，并去掉前缀（npm 包的 package/、Codex 的 vendor 子目录）。
//
// 打包（packTgz）给发布机上的打包脚本和单测用：条目按路径排序、时间戳固定，同样的输入打出同样的字节。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK = 512;

function cleanRel(name) {
  // 统一分隔符，去掉开头的 ./；拒绝绝对路径、盘符、.. 段和空段。
  const raw = String(name || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split('/').filter((p, i, all) => p !== '' || i === all.length - 1);
  if (parts[parts.length - 1] === '') parts.pop();
  if (!parts.length || parts.some(p => p === '..' || p === '.' || p === '' || /[\0<>:"|?*]/.test(p))) return null;
  return parts.join('/');
}

function parseOctal(buf, start, len) {
  const text = buf.toString('ascii', start, start + len).replace(/\0.*$/, '').trim();
  // GNU 大数：首字节最高位为 1 时后面是二进制大端整数。
  if (buf[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + len; i++) n = n * 256 + buf[i];
    return n;
  }
  return text ? parseInt(text, 8) : 0;
}

// pax 扩展头：一串「长度 键=值 换行」记录，长度按字节算（含长度数字本身），所以要在 Buffer 上切。
function parsePax(data) {
  const out = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = Number(data.toString('ascii', at, space));
    if (!Number.isInteger(len) || len <= space - at || at + len > data.length) break;
    const record = data.toString('utf8', space + 1, at + len - 1);
    at += len;
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
  }
  return out;
}

function checksumOk(header) {
  const stored = parseOctal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === stored;
}

// 解压 tgz 到 dest（dest 必须是空目录或不存在）。返回 { files, bytes }。
// onEntry({ files, bytes }) 每写完一个文件回调一次，给界面显示「已解压 n 个文件」。
async function extractTgz(file, dest, { strip = '', signal, onEntry, maxBytes = 4 * 1024 * 1024 * 1024 } = {}) {
  const cleanedStrip = strip ? cleanRel(strip) : '';
  if (strip && !cleanedStrip) throw new Error('解压前缀无效');
  const prefix = cleanedStrip ? cleanedStrip + '/' : '';
  const root = path.resolve(dest);
  await fs.promises.mkdir(root, { recursive: true });
  const made = new Set([root]);
  const ensureDir = async dir => {
    if (made.has(dir)) return;
    await fs.promises.mkdir(dir, { recursive: true });
    made.add(dir);
  };
  const target = rel => {
    const full = path.resolve(root, ...rel.split('/'));
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('包里有越出安装目录的路径：' + rel);
    return full;
  };
  let files = 0, bytes = 0;
  let buf = Buffer.alloc(0);
  // 当前条目：{ remaining, padding, handle, kind }；kind = file / skip / pax / gnu-name
  let entry = null, nextName = null, nextSize = null, ended = false;
  const meta = [];
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  const abort = () => input.destroy(Object.assign(new Error('已取消'), { reason: '已取消' }));
  if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
  try {
    for await (const chunk of input) {
      if (ended) continue;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let offset = 0;
      for (;;) {
        if (entry) {
          if (entry.remaining > 0) {
            const take = Math.min(entry.remaining, buf.length - offset);
            if (!take) break;
            const piece = buf.subarray(offset, offset + take);
            if (entry.handle) await entry.handle.write(piece);
            else if (entry.kind === 'pax' || entry.kind === 'gnu-name') meta.push(Buffer.from(piece));
            entry.remaining -= take;
            offset += take;
            if (entry.remaining > 0) break;
          }
          if (buf.length - offset < entry.padding) break;
          offset += entry.padding;
          const done = entry;
          entry = null;
          if (done.handle) {
            await done.handle.close();
            files += 1;
            onEntry && onEntry({ files, bytes });
          } else if (done.kind === 'pax') {
            const fields = parsePax(Buffer.concat(meta.splice(0)));
            if (fields.path) nextName = fields.path;
            if (fields.size) nextSize = Number(fields.size);
          } else if (done.kind === 'gnu-name') {
            nextName = Buffer.concat(meta.splice(0)).toString('utf8').replace(/\0+$/, '');
          }
          continue;
        }
        if (buf.length - offset < BLOCK) break;
        const header = buf.subarray(offset, offset + BLOCK);
        offset += BLOCK;
        if (header.every(b => b === 0)) { ended = true; break; }
        if (!checksumOk(header)) throw new Error('组件包内容损坏（tar 头校验不通过）');
        const type = String.fromCharCode(header[156] || 48);
        let size = nextSize != null ? nextSize : parseOctal(header, 124, 12);
        const padding = (BLOCK - (size % BLOCK)) % BLOCK;
        if (type === 'x' || type === 'g' || type === 'L') {
          if (size > 1024 * 1024) throw new Error('组件包的扩展头过大');
          entry = { remaining: size, padding, kind: type === 'x' ? 'pax' : type === 'L' ? 'gnu-name' : 'skip' };
          continue;
        }
        let name = nextName;
        if (!name) {
          const short = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
          const ustar = header.toString('ascii', 257, 262) === 'ustar';
          const pre = ustar ? header.toString('utf8', 345, 500).replace(/\0.*$/s, '') : '';
          name = pre ? pre + '/' + short : short;
        }
        nextName = null; nextSize = null;
        const rel = cleanRel(name);
        if (!rel) throw new Error('组件包里有不安全的路径：' + String(name).slice(0, 120));
        let keep = rel;
        if (prefix) keep = (rel + '/').startsWith(prefix) ? rel.slice(prefix.length) : null;
        if (type === '5') {
          if (keep) await ensureDir(target(keep));
          entry = { remaining: size, padding, kind: 'skip' };
          continue;
        }
        if (type !== '0' && type !== '\0' && type !== '7') throw new Error('组件包里有不支持的条目类型（' + type + '）：' + rel);
        if (!keep) { entry = { remaining: size, padding, kind: 'skip' }; continue; }
        bytes += size;
        if (bytes > maxBytes) throw new Error('组件包解压后超过允许大小');
        const full = target(keep);
        await ensureDir(path.dirname(full));
        const handle = await fs.promises.open(full, 'wx');
        entry = { remaining: size, padding, kind: 'file', handle };
      }
      buf = offset >= buf.length ? Buffer.alloc(0) : buf.subarray(offset);
    }
    if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { reason: '已取消' });
    if (entry && (entry.remaining > 0 || entry.handle)) throw new Error('组件包不完整（解压到一半就结束了）');
    if (!ended && files === 0) throw new Error('组件包是空的');
  } catch (error) {
    if (entry && entry.handle) { try { await entry.handle.close(); } catch (_) {} }
    if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { reason: '已取消' });
    if (/incorrect header check|unexpected end of file|invalid/i.test(String(error.message)) && !error.reason) {
      throw new Error('组件包不是有效的 tgz 文件（' + error.message + '）');
    }
    throw error;
  } finally {
    if (signal) signal.removeEventListener('abort', abort);
  }
  return { files, bytes };
}

// ---------- 打包 ----------
function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }

function header(name, size, type) {
  const h = Buffer.alloc(BLOCK);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  // 固定时间戳（2026-01-01）：同样的输入打出同样的字节，sha256 可复现。
  h.write(octal(1767225600, 12), 136, 'ascii');
  h.fill(32, 148, 156);
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

function paxHeader(name) {
  // 记录长度包含长度数字本身：先按不含数字的长度算，再把数字位数加上（位数变了就再加一次）。
  const rest = Buffer.byteLength(` path=${name}\n`);
  let len = rest + String(rest).length;
  if (String(len).length !== String(rest).length) len = rest + String(len).length;
  const body = Buffer.from(`${len} path=${name}\n`, 'utf8');
  return [header('PaxHeader', body.length, 'x'), body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK)];
}

// entries：[{ name, data?: Buffer, file?: 绝对路径, dir?: true }]；写成 gzip 流到 out（文件路径）。
async function packTgz(entries, out, { level = 9 } = {}) {
  const list = entries.map(e => ({ ...e, name: cleanRel(e.name) }));
  if (list.some(e => !e.name)) throw new Error('打包条目里有不安全的路径');
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  await fs.promises.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  const gzip = zlib.createGzip({ level });
  const sink = fs.createWriteStream(out);
  const finished = new Promise((resolve, reject) => { sink.on('finish', resolve); sink.on('error', reject); gzip.on('error', reject); });
  gzip.pipe(sink);
  const write = chunk => new Promise(resolve => { if (gzip.write(chunk)) resolve(); else gzip.once('drain', resolve); });
  for (const e of list) {
    const name = e.dir ? e.name + '/' : e.name;
    const data = e.dir ? Buffer.alloc(0) : e.data != null ? Buffer.from(e.data) : await fs.promises.readFile(e.file);
    if (Buffer.byteLength(name) > 100) for (const part of paxHeader(name)) await write(part);
    await write(header(name, data.length, e.dir ? '5' : '0'));
    if (data.length) {
      await write(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) await write(Buffer.alloc(pad));
    }
  }
  await write(Buffer.alloc(BLOCK * 2));
  gzip.end();
  await finished;
  return out;
}

// 把一个目录下的全部文件列成打包条目（相对路径用 /），可加前缀。
function listTree(dir, prefix = '') {
  const out = [];
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, d.name), r = rel ? rel + '/' + d.name : d.name;
      if (d.isSymbolicLink()) throw new Error('打包目录里有链接，未打包：' + a);
      if (d.isDirectory()) walk(a, r);
      else if (d.isFile()) out.push({ name: (prefix ? prefix + '/' : '') + r, file: a });
    }
  };
  walk(dir, '');
  return out;
}

module.exports = { extractTgz, packTgz, listTree, cleanRel, parsePax };

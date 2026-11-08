#!/usr/bin/env node
'use strict';
// 打会议本地转写的离线组件包（2026-11-07）。只生成文件，不上传。
//
//   node scripts/build-meeting-speech-pack.js --runtime <便携 Python 目录> --model <模型目录> --version sv1-20261107 --out <输出目录>
//
// 便携 Python：python.org 的 3.12 embed 包（npmmirror 有镜像），python312._pth 末行 import site，
//   再 uv pip install --target Lib/site-packages --python-platform x86_64-pc-windows-msvc --python-version 3.12 sherpa-onnx numpy，
//   删掉 Lib/site-packages 下的 Scripts、bin 和 *.lib。
// 模型目录：model.int8.onnx + tokens.txt（SenseVoice-Small，魔搭 pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue）、
//   voiceprint.onnx（3D-Speaker CAM++ 中文声纹，sherpa-onnx speaker-recongition-models）。
//
// 产物：<out>/<version>/ 下若干 ≤16 MB 的分片，和要写进 core/company-assistant/meeting-speech-pack.json 的清单。
// 分片的原因：公司代理下老服务器约 170 KB/s，一个 250 MB 的文件断一次就要从头来；分片每片单独校验、下好的不再下。
// 上传：把 <out>/<version> 整个目录放到老服务器 C:/hub-update/site/meeting-speech/ 下，高速服务器 5 分钟内自动同步。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PART = 16 * 1024 * 1024;
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? a.concat([[v.slice(2), all[i + 1]]]) : a), []));
for (const k of ['runtime', 'model', 'version', 'out']) if (!args[k]) throw new Error('缺少 --' + k);
const dir = path.join(path.resolve(args.out), args.version);
fs.mkdirSync(dir, { recursive: true });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

function split(name, file, extract) {
  const buf = fs.readFileSync(file), parts = [];
  for (let i = 0, n = 0; i < buf.length; i += PART, n++) {
    const piece = buf.subarray(i, i + PART), part = `${name}.${String(n).padStart(3, '0')}`;
    fs.writeFileSync(path.join(dir, part), piece);
    parts.push({ file: part, size: piece.length, sha256: sha(piece) });
  }
  return { name, size: buf.length, sha256: sha(buf), ...(extract ? { extract } : {}), parts };
}

const zip = path.join(path.resolve(args.out), `runtime-${args.version}.zip`);
fs.rmSync(zip, { force: true });
// Windows 自带的 bsdtar 能写 zip，比 Compress-Archive 快得多。
execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', path.resolve(args.runtime), '.'], { windowsHide: true, stdio: 'inherit' });
const files = [split('runtime.zip', zip, 'python')];
for (const f of ['model.int8.onnx', 'tokens.txt', 'voiceprint.onnx']) files.push(split(f, path.join(path.resolve(args.model), f)));
const manifest = { version: args.version, engine: 'sensevoice', files };
const total = files.reduce((n, f) => n + f.size, 0);
fs.writeFileSync(path.join(path.resolve(args.out), `meeting-speech-pack-${args.version}.json`), JSON.stringify(manifest, null, 1) + '\n');
console.log(`共 ${files.reduce((n, f) => n + f.parts.length, 0)} 片，${(total / 1024 / 1024).toFixed(1)} MB → ${dir}`);

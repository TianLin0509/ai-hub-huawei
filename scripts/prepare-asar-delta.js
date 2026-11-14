'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { sha256, packPayload } = require('../core/app-update/payload');

// Use the previous *verified complete* payload, never an unverified ASAR or
// source-tree rebuild. Release index and package must identify the same bytes.
async function prepareDelta(resources, outFile, { previous, localPackage = process.env.AI_HUB_PREVIOUS_PACKAGE,
  fetchImpl = globalThis.fetch, log = console.warn } = {}) {
  if (!previous) return null;
  let baseAsar = null;
  try {
    const asset = previous.document?.incremental;
    if (!asset || !Number.isSafeInteger(asset.bytes) || asset.bytes > 600 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error('Previous complete payload metadata is missing');
    let gz;
    if (localPackage) gz = fs.readFileSync(localPackage);
    else {
      if (!previous.packageUrl) throw Error('Previous complete payload URL is missing');
      const response = await fetchImpl(previous.packageUrl, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
      if (!response.ok || Number(response.headers?.get('content-length')) > asset.bytes) throw Error('Previous complete payload download failed');
      // Bound both network and decompression before trusting any file table.
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; if (size > asset.bytes) throw Error('Previous complete payload is too large');
        chunks.push(Buffer.from(chunk));
      }
      gz = Buffer.concat(chunks);
    }
    if (gz.length !== asset.bytes || sha256(gz) !== asset.sha256) throw Error('Previous complete payload checksum mismatch');
    const body = zlib.gunzipSync(gz, { maxOutputLength: 800 * 1024 * 1024 }), nl = body.indexOf(10);
    if (nl < 0 || nl > 2 * 1024 * 1024) throw Error('Previous complete payload directory is invalid');
    const header = JSON.parse(body.subarray(0, nl).toString('utf8'));
    if (header.schema !== 1 || !Array.isArray(header.files)) throw Error('Previous payload must be complete');
    let offset = nl + 1;
    for (const entry of header.files) {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > body.length - offset) throw Error('Previous payload range is invalid');
      if (entry.path === 'app.asar') {
        if (baseAsar) throw Error('Previous payload contains duplicate ASAR');
        baseAsar = body.subarray(offset, offset + entry.bytes);
        const indexed = previous.index.find(item => item.path === 'app.asar');
        if (!indexed || sha256(baseAsar) !== indexed.sha256 || indexed.sha256 !== entry.sha256) throw Error('Previous ASAR checksum mismatch');
      }
      offset += entry.bytes;
    }
    if (!baseAsar || offset !== body.length) throw Error('Previous payload is incomplete');
    return packPayload(resources, outFile, { previous: previous.index, baseAsar, baseVersion: previous.version });
  } catch (error) {
    log(`ASAR 差量基线不可用，保留原文件级更新包：${error.message}`);
    return packPayload(resources, outFile, { previous: previous.index });
  }
}

module.exports = { prepareDelta };

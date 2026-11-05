'use strict';
// File-protocol fixture: launched as a hidden subprocess, never a GUI program.
const fs = require('node:fs');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const request = JSON.parse(fs.readFileSync(arg('--in'), 'utf8')), action = arg('--hub');
const mode = request.fixture || process.env.PPT_DOCTOR_FIXTURE || 'success';
if (mode === 'timeout') { setTimeout(() => process.exit(0), 30000); }
else if (mode === 'missing-output') process.exitCode = 2;
else {
  const result = { ok: mode !== 'failed', apiVersion: mode === 'old' ? 0 : 1, doctorVersion: '9.9.fixture', requestId: mode === 'wrong-id' ? 'other' : request.requestId, action,
    available: true, indexed_pages: 2, file_status_counts: [{ status: 'ok', files: 1 }], documents: [], warnings: [], scope: { index_id: 'fixture' }, ocr: { installed: true } };
  if (mode === 'failed') { result.code = 'OCR_UNAVAILABLE'; result.error = { code: result.code, message: '请安装 OCR 组件' }; process.exitCode = 3; }
  if (mode === 'search-plan' && action === 'search') {
    const queries = request.plan?.queries;
    const termCount = query => {
      const text = query.replace(/[“”「」《》]/gu, '"');
      const phrases = [...text.matchAll(/"([^"]+)"/gu)];
      return text.replace(/"([^"]+)"/gu, ' ').split(/[\s\u001c-\u001f\u0085]+/u).filter(Boolean).length + phrases.length;
    };
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > 16) {
      result.ok = false; result.code = 'INVALID_PLAN'; result.error = { code: result.code, message: '计划应包含 1–16 个 queries。' }; process.exitCode = 2;
    } else if ([request.plan.query, ...queries.map(q => typeof q === 'string' ? q : q?.query)]
      .filter(q => q !== undefined).some(q => typeof q !== 'string' || !q.trim() || Array.from(q).length > 200 || termCount(q) > 16)) {
      result.ok = false; result.code = 'INVALID_PLAN'; result.error = { code: result.code, message: '每个查询需要1–200字、最多16词，引号短语计为一词。' }; process.exitCode = 2;
    } else {
      result.candidates = []; result.queries = queries; result.truncated = false;
    }
  }
  if (mode === 'progress') {
    fs.writeFileSync(arg('--progress'), JSON.stringify({ ...result, state: 'running' }));
    setTimeout(() => fs.writeFileSync(arg('--out'), JSON.stringify(result)), 1300);
  } else fs.writeFileSync(arg('--out'), mode === 'bad-json' ? '{broken' : JSON.stringify(result));
}

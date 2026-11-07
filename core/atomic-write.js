'use strict';
// 配置类文件的原子写：先写同目录临时文件，再改名覆盖。磁盘满、断电或进程被杀时，原文件要么是旧的完整内容，
// 要么是新的完整内容，不会留下写到一半的空文件。backup:true 时覆盖前把旧文件留一份 .bak，读取方可在主文件损坏时回退。
const nodePath = require('node:path');

function writeFileAtomic(fsModule, file, text, { backup = false } = {}) {
  // 测试里常传只带 writeFileSync 的替身：没有改名能力就退回直接写。
  if (!fsModule || typeof fsModule.renameSync !== 'function') { fsModule.writeFileSync(file, text, 'utf8'); return; }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsModule.writeFileSync(tmp, text, 'utf8');
    if (backup && typeof fsModule.copyFileSync === 'function') {
      try { if (fsModule.statSync(file).size > 0) fsModule.copyFileSync(file, file + '.bak'); } catch { /* 原文件不存在或不可读：没有可备份的 */ }
    }
    fsModule.renameSync(tmp, file);
  } catch (error) {
    try { fsModule.rmSync?.(tmp, { force: true }); } catch { /* 清理失败不遮盖原错误 */ }
    throw error;
  }
}

module.exports = { writeFileAtomic };

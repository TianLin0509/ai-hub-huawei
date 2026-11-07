'use strict';
function createMeetingHandlers(service) {
  const m = service.meetings;
  return {
    'meeting-status': r => m.status(r.id),
    'meeting-start': async r => { const meeting = m.create(r); return { ok: true, meeting, diskWarning: await m.recording.diskWarning() }; },
    'meeting-rename': r => ({ ok: true, meeting: m.rename(r.id, r.title) }),
    'meeting-capture': r => m.capture(r.id, r),
    'meeting-control': r => m.control(r.id, r.op, r.value),
    'meeting-asset': r => ({ ok: true, ...m.asset(r.id, r.seq) }),
    'meeting-recording': r => ({ ok: true, ...m.recording.index(r.id) }),
    'meeting-playback': r => ({ ok: true, ...m.recording.locate(r.id, r.at) }),
    'meeting-open-full': async r => { await m.recording.repairs.get(r.id); const full = m.recording.full(r.id); const error = await require('electron').shell.openPath(full.file); if (error) throw new Error(error); return { ok: true, file: full.file }; },
    'meeting-save-video': async r => {
      await m.recording.repairs.get(r.id); const full = m.recording.full(r.id), { dialog, shell } = require('electron');
      const { canceled, filePath } = await dialog.showSaveDialog({ title: '保存会议视频', defaultPath: m.recording.exportName(r.id), filters: [{ name: '视频', extensions: [full.file.split('.').pop()] }] });
      if (canceled || !filePath) return { ok: true, canceled: true };
      await require('node:fs/promises').copyFile(full.file, filePath); shell.showItemInFolder(filePath); return { ok: true, file: filePath };
    },
    'meeting-delete-video': async r => {
      const { dialog } = require('electron'), { title, recording } = m.load(r.id);
      const size = ((recording?.bytes || 0) / 1024 ** 2).toFixed(0);
      const { response } = await dialog.showMessageBox({ type: 'warning', buttons: ['删除录像', '取消'], defaultId: 1, cancelId: 1, title: '删除录像', message: `删除「${title}」的录像（${size} MB）？`, detail: '只删视频，纪要、转写和截图都保留。删除后不能恢复。' });
      if (response !== 0) return { ok: true, canceled: true };
      return { ok: true, ...m.recording.deleteVideo(r.id) };
    },
    'meeting-frames': async r => ({ ok: true, frames: await m.frames.extract(r.id, r) }),
    'meeting-asr-install': () => ({ ok: true, asr: m.asr.install() }),
    'meeting-export': async r => { const file = m.export(r.id); require('electron').shell.showItemInFolder(file); return { ok: true, file }; },
    'meeting-sources': async () => {
      const sources = await require('electron').desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } });
      return { ok: true, sources: sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })) };
    },
  };
}
module.exports = { createMeetingHandlers };

'use strict';
function createMeetingHandlers(service) {
  const m = service.meetings;
  return {
    'meeting-status': r => m.status(r.id),
    'meeting-start': r => ({ ok: true, meeting: m.create(r) }),
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

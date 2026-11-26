'use strict';
function createMeetingHandlers(service) {
  const m = service.meetings;
  return {
    'meeting-status': r => { m.start(); return m.status(r.id, r.since || null); }, // since：页面手里那一版，对得上只回增量
    // 采集类请求记下发起页面：页面崩溃、关闭或整页重新载入时，这场会议收成「已中断」，重开会议页能接着录或查看（R51）。
    'meeting-start': async (r, event) => { const meeting = m.create(r); m.bindOwner(meeting.id, event?.sender); return { ok: true, meeting, diskWarning: await m.recording.diskWarning() }; },
    'meeting-rename': r => ({ ok: true, meeting: m.rename(r.id, r.title) }),
    'meeting-capture': (r, event) => { const result = m.capture(r.id, r); if (event?.sender && m.owners?.get(r.id) !== event.sender.id) m.bindOwner(r.id, event.sender); return result; },
    'meeting-control': (r, event) => { const result = m.control(r.id, r.op, r.value); if (r.op === 'continue') m.bindOwner(r.id, event?.sender); return result; },
    'meeting-question-log': r => require('./meeting-questions').log(m, r),
    'meeting-search': r => require('./meeting-search').searchMeetings(m, r),
    'meeting-asset': r => ({ ok: true, ...m.asset(r.id, r.seq) }),
    'meeting-recording': r => ({ ok: true, ...m.recording.index(r.id) }),
    'meeting-playback': r => ({ ok: true, ...m.recording.locate(r.id, r.at) }),
    'meeting-open-full': async r => { const full = await m.recording.prepareFull(r.id); const error = await require('electron').shell.openPath(full.file); if (error) throw new Error(error); return { ok: true, file: full.file }; },
    'meeting-save-video': async r => {
      const full = await m.recording.prepareFull(r.id), { dialog, shell } = require('electron');
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
    // 删除整场会议：二次确认在页面里做（Hub 自己的确认框，不弹系统窗口），这里只执行。
    'meeting-delete': async r => ({ ok: true, ...(await m.remove(r.id, { alsoCopies: r.alsoCopies === true })) }),
    'meeting-frames': async r => ({ ok: true, frames: await m.frames.extract(r.id, r) }),
    'meeting-asr-install': () => ({ ok: true, asr: m.asr.install() }),
    'meeting-glossary': () => ({ ok: true, text: m.glossary.text() }),
    'meeting-glossary-save': r => ({ ok: true, ...m.glossary.save(r.text), text: m.glossary.text() }),
    // 打开材料文件夹：选了会议就打开这一场的文件夹（不在了就报错，不建空文件夹冒充），没选就打开会议总目录（不存在时先建好）。
    'meeting-open-folder': async r => {
      const fs = require('node:fs'), dir = r?.id ? m.dir(r.id) : m.root;
      if (r?.id) { if (!fs.existsSync(dir)) throw new Error(`这场会议的文件夹不在了：${dir}，可能被移走或删除了`); }
      else fs.mkdirSync(dir, { recursive: true });
      const error = await require('electron').shell.openPath(dir); if (error) throw new Error(error); return { ok: true, dir };
    },
    'meeting-export': async r => { const file = m.export(r.id); require('electron').shell.showItemInFolder(file); return { ok: true, file }; },
    'meeting-sources': async () => {
      const sources = await require('electron').desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } });
      return { ok: true, sources: sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })) };
    },
  };
}
module.exports = { createMeetingHandlers };

'use strict';

// 「复制为图片」（2026-11-28）：把一张卡片或一段长消息按界面上的真实像素复制成图片。
// 做法：按屏滚动消息所在的滚动区，每屏用窗口截图（capturePage）截下消息那一块，
// 再按位置拼成整张图交主进程写剪贴板。真实像素保证主题、字体、代码块、公式与界面一致；
// 截图期间隐藏悬停按钮、「回到最新」等浮层，结束后恢复原滚动位置和折叠状态。
// 超长内容只截到画布上限（约 3 万像素高），并告诉调用方截了多少。

const PAD = 12;
const MAX_DEVICE_HEIGHT = 30000;

function findScroller(el, win) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return null;
}

function visibleRect(scroller, win) {
  const view = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
  if (!scroller) return view;
  const r = scroller.getBoundingClientRect();
  return { left: Math.max(view.left, r.left), top: Math.max(view.top, r.top),
    right: Math.min(view.right, r.right), bottom: Math.min(view.bottom, r.bottom) };
}

function frames(win, n = 2) {
  return new Promise(resolve => {
    const step = left => (left <= 0 ? resolve() : win.requestAnimationFrame(() => step(left - 1)));
    if (typeof win.requestAnimationFrame !== 'function') setTimeout(resolve, 32); else step(n);
  });
}

// 截图期间：长消息临时展开（图片要的是全文，不是三行预览）；打开的操作菜单收起。
function prepare(el, doc) {
  const restores = [];
  const longFolds = el.matches?.('.conversation-long-frame') ? [el.querySelector('details.conversation-long-message')]
    : [...el.querySelectorAll('details.conversation-long-message')];
  for (const details of longFolds) {
    if (details && !details.open) { details.open = true; restores.push(() => { details.open = false; }); }
  }
  for (const menu of doc.querySelectorAll('details.card-actions-menu[open]')) {
    menu.open = false;
  }
  el.classList.add('hub-image-capture-target');
  doc.body.classList.add('hub-image-capturing');
  restores.push(() => { el.classList.remove('hub-image-capture-target'); doc.body.classList.remove('hub-image-capturing'); });
  return () => restores.reverse().forEach(fn => { try { fn(); } catch { /* 恢复尽力而为 */ } });
}

async function captureSlices(el, { win, capture, maxDeviceHeight = MAX_DEVICE_HEIGHT }) {
  const scroller = findScroller(el, win);
  const view = visibleRect(scroller, win);
  // 截图区域一律取整（CSS 像素），拼接比例才不会因小数宽度偏大而出横缝。
  const vTop = Math.ceil(view.top), vBottom = Math.floor(view.bottom);
  let r = el.getBoundingClientRect();
  const left = Math.max(Math.ceil(view.left), Math.floor(r.left - PAD));
  const right = Math.min(Math.floor(view.right), Math.ceil(r.right + PAD));
  if (right - left < 4 || vBottom - vTop < 4) throw new Error('消息不在可见区域');
  const dpr = win.devicePixelRatio || 1;
  const fullEnd = r.height + PAD;
  const end = Math.min(fullEnd, -PAD + Math.floor(maxDeviceHeight / dpr));
  const truncated = end < fullEnd;
  const fitsNow = r.top - PAD >= vTop && r.top + end <= vBottom;
  const slices = [];
  let y = -PAD;
  // 正文已截完、只剩底部留白却滚不出新像素（消息贴着滚动区底边）时，直接收尾。
  const onlyPaddingLeft = () => slices.length && y >= r.height - 0.5;
  for (let guard = 0; y < end - 0.5 && guard < 400; guard++) {
    if (!fitsNow && scroller) {
      r = el.getBoundingClientRect();
      scroller.scrollTop += (r.top + y) - vTop;
      await frames(win);
      // 滚动被别的逻辑拉走时，宁可失败退回文字，也不交一张缺头的图；滚到顶或底被夹住属正常。
      r = el.getBoundingClientRect();
      const atTop = scroller.scrollTop <= 0, atBottom = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
      if (Math.abs(r.top + y - vTop) > 2 && !atTop && !atBottom) throw new Error('截图时滚动位置被打断');
    }
    r = el.getBoundingClientRect();
    const top = Math.max(vTop, Math.round(r.top + y)), bottom = Math.min(vBottom, Math.round(r.top + end));
    if (bottom - top < 1) { if (onlyPaddingLeft()) break; throw new Error('无法把消息滚动到可见区域'); }
    const rect = { x: left, y: top, width: right - left, height: bottom - top };
    const png = await capture({ ...rect, first: !slices.length });
    slices.push({ offset: top - r.top, rect, png });
    const next = bottom - r.top;
    if (next <= y + 0.5) { if (onlyPaddingLeft()) break; throw new Error('截图没有进展'); }
    y = next;
  }
  if (!slices.length) throw new Error('无法把消息滚动到可见区域');
  // 贴着滚动区顶边时上留白可能截不满：以第一片为起点，整张图不留透明条。
  const base = slices[0].offset;
  for (const s of slices) s.offset = Math.round(s.offset - base);
  const last = slices[slices.length - 1];
  return { slices, width: right - left, height: last.offset + last.rect.height, truncated, fullHeight: fullEnd + PAD };
}

async function stitch({ slices, width, height }, { doc, win }) {
  const bitmaps = [];
  for (const s of slices) bitmaps.push(await win.createImageBitmap(new win.Blob([s.png], { type: 'image/png' })));
  const scale = bitmaps[0].width / slices[0].rect.width;
  // 截到的高度短于请求（区域超出窗口）时宁可退回文字，也不交一张带黑条的图。
  slices.forEach((s, i) => { if (bitmaps[i].height < s.rect.height * scale - 2) throw new Error('截图不完整'); });
  // 每片紧接上一片的实际像素底边摆放（取整误差最多重叠 1 像素），不留透明缝。
  let end = 0;
  const places = slices.map((s, i) => { const y = Math.min(Math.round(s.offset * scale), end); end = y + bitmaps[i].height; return y; });
  const canvas = doc.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.min(Math.round(height * scale), end);
  const ctx = canvas.getContext('2d');
  slices.forEach((s, i) => ctx.drawImage(bitmaps[i], 0, places[i]));
  bitmaps.forEach(b => b.close?.());
  const blob = await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('图片编码失败'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function electronIpc() {
  const { ipcRenderer, webFrame } = require('electron');
  const zoom = () => (webFrame && typeof webFrame.getZoomFactor === 'function' ? webFrame.getZoomFactor() : 1);
  return {
    async capture(rect) {
      const z = zoom();
      const res = await ipcRenderer.invoke('message-image:capture',
        { x: rect.x * z, y: rect.y * z, width: rect.width * z, height: rect.height * z, first: !!rect.first });
      if (!res || !res.ok) throw Object.assign(new Error(res?.error || '截图失败'), { superseded: res?.reason === 'superseded' });
      return res.png;
    },
    async write(png) {
      const res = await ipcRenderer.invoke('message-image:write', png);
      if (!res || !res.ok) throw Object.assign(new Error(res?.error || '写入剪贴板失败'), { superseded: res?.reason === 'superseded' });
      return res;
    },
  };
}

// 把 el 复制成图片；失败时用 fallbackText 复制文字。返回 {ok, image, truncated, percent, fellBack, error}。
let busy = false;
async function copyElementAsImage(el, { doc = el.ownerDocument, win = doc.defaultView, ipc, fallbackText, copyText } = {}) {
  const api = ipc || electronIpc();
  // 一次只做一张：锁一直持有到写完剪贴板，避免先点的旧图覆盖后点的新图。
  if (busy) return { ok: false, error: '上一张图片还在生成，请稍候' };
  busy = true;
  try { return await run(); } finally { busy = false; }

  async function run() {
    let scroller = findScroller(el, win);
    let savedTop = scroller ? scroller.scrollTop : null;
    // 消息区处在「跟随最新」或停在底部时先暂停跟随（点开下拉菜单那一下已被当作用户操作暂停过），
    // 否则截图期间的尺寸变化会把滚动拉回底部；结束后恢复跟随。
    const follow = scroller && scroller._cardFollowController;
    const atBottom = !!scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 3;
    const wasFollowing = !!(follow && (follow.isFollowing() || atBottom));
    if (wasFollowing) follow.pause();
    const restore = prepare(el, doc);
    // 展开折叠的长消息后才出现滚动条的短会话，展开后再找一次滚动区（展开不改变 scrollTop）。
    if (!scroller) { scroller = findScroller(el, win); savedTop = scroller ? scroller.scrollTop : null; }
    let shot, captureError;
    try {
      await frames(win);
      shot = await captureSlices(el, { win, capture: api.capture });
    } catch (error) { captureError = error; }
    restore();
    if (scroller) scroller.scrollTop = savedTop;
    if (wasFollowing) follow.follow();
    if (captureError) return fallback(captureError);
    try {
      const png = await stitch(shot, { doc, win });
      await api.write(png);
      const percent = Math.round(Math.min(1, shot.height / shot.fullHeight) * 100);
      return { ok: true, image: true, truncated: shot.truncated, percent };
    } catch (error) { return fallback(error); }
  }

  async function fallback(error) {
    // 期间用户又复制了别的东西：保留新内容，不再拿旧消息的文字覆盖。
    if (error.superseded) return { ok: false, superseded: true, error: error.message };
    if (typeof copyText !== 'function' || !fallbackText) return { ok: false, error: error.message };
    try {
      const res = await copyText(fallbackText);
      if (res && res.ok === false) throw new Error(res.reason || '复制失败');
      return { ok: true, image: false, fellBack: true, error: error.message };
    } catch (textError) { return { ok: false, error: `${error.message}；文字复制也失败：${textError.message}` }; }
  }
}

// 按钮上就地显示结果，1.8 秒后复原。
function describeResult(result) {
  if (result.superseded) return { label: '已让位新复制', notice: '' };
  if (!result.ok) return { label: '复制失败', notice: `复制为图片失败：${result.error}` };
  if (result.fellBack) return { label: '已复制文字', notice: `图片没生成（${result.error}），已改为复制文字。` };
  if (result.truncated) return { label: '已复制图片', notice: `消息太长，图片只含前 ${result.percent}%；完整内容请用「复制」拿文字。` };
  return { label: '已复制图片', notice: '' };
}

module.exports = { copyElementAsImage, describeResult, captureSlices, findScroller, visibleRect, PAD };

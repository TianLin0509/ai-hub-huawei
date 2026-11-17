'use strict';
// 事件道具（2026-11-17 r27c，方向 B「状态一眼分清」）：每类事件一件矢量小道具，不重画形象。
// 位置全部从当前帧的透明度轮廓算（pet-evolution.js 的 measure：轮廓边界 + 头顶中线），6 个形象（含下载形象）不用手写坐标：
// 头顶类（感叹号、低电量、耳机、「…」）对准头顶中线；手边类（对勾牌、容量条）挂在轮廓右侧中部；礼盒放在脚边。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubPetProps = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const SIGN = '<svg viewBox="0 0 34 52"><rect x="15" y="24" width="4" height="28" rx="2" fill="#c8a47e"/><circle cx="17" cy="15" r="14" fill="#22a45d" stroke="#fff" stroke-width="1.5"/><path d="M10 15l5 5 9-10" stroke="#fff" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // 「…」气泡朝左上冒（右上角是小圆点和卡片的小尾巴），尾巴指回头部。
  const DOTS = '<svg viewBox="0 0 42 34"><g transform="translate(42 0) scale(-1 1)"><path d="M6 2h30a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5H16l-8 7 2-7H6a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z" fill="#fff" stroke="#3478f6" stroke-width="2"/><circle cx="13" cy="14" r="2.6" fill="#3478f6"/><circle cx="21" cy="14" r="2.6" fill="#3478f6"/><circle cx="29" cy="14" r="2.6" fill="#3478f6"/></g></svg>';
  const BANG = '<svg viewBox="0 0 30 28"><path d="M15 2.5 28 25H2z" fill="#e08a2b" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><rect x="13.4" y="10" width="3.2" height="8" rx="1.6" fill="#fff"/><circle cx="15" cy="21" r="1.8" fill="#fff"/></svg>';
  const DROP = '<svg viewBox="0 0 10 14"><path d="M5 0c3 4.5 5 6.8 5 9a5 5 0 0 1-10 0c0-2.2 2-4.5 5-9z" fill="#6bb6ff" stroke="#fff" stroke-width=".8"/></svg>';
  const PHONES = '<svg viewBox="0 0 80 46"><path d="M10 40V30a30 26 0 0 1 60 0v10" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/><path d="M10 40V30a30 26 0 0 1 60 0v10" fill="none" stroke="#4a5568" stroke-width="5" stroke-linecap="round"/><rect x="2" y="28" width="13" height="18" rx="6" fill="#3478f6" stroke="#fff" stroke-width="1.5"/><rect x="65" y="28" width="13" height="18" rx="6" fill="#3478f6" stroke="#fff" stroke-width="1.5"/></svg>';
  const GIFT = '<svg viewBox="0 0 36 34"><rect x="3" y="12" width="30" height="20" rx="3" fill="#3478f6" stroke="#fff" stroke-width="1.2"/><rect x="1" y="8" width="34" height="8" rx="3" fill="#5b93f8" stroke="#fff" stroke-width="1.2"/><rect x="15.5" y="8" width="5" height="24" fill="#ffd166"/><path d="M18 8c-7-8-13-2-7 0zm0 0c7-8 13-2 7 0z" fill="#ffd166"/></svg>';
  const TWINKLE = '<svg viewBox="0 0 10 10"><path d="M5 0l1.2 3.8L10 5 6.2 6.2 5 10 3.8 6.2 0 5l3.8-1.2z" fill="#ffc83d"/></svg>';
  const BATT = '<svg viewBox="0 0 34 18"><rect x="1" y="1" width="28" height="16" rx="4" fill="#fff" stroke="#8a94a6" stroke-width="2"/><rect x="30" y="6" width="3" height="6" rx="1" fill="#8a94a6"/><rect x="4" y="4" width="6" height="10" rx="2" fill="#e0603f"/></svg>';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  // 硬盘提醒的标题形如「C 盘已经用了 94%」：读出盘名和百分比画进容量条；读不出就只画一根满条。
  function diskInfo(title) {
    const m = /^\s*([A-Za-z]{1,3}|[^\s]{1,6}?)\s*盘[^0-9]*?(\d{1,3})\s*%/.exec(String(title || ''));
    const pct = m ? Math.max(0, Math.min(100, Number(m[2]))) : 0;
    return { label: m ? m[1] + ' 盘 ' + pct + '%' : '硬盘快满了', pct: m ? pct : 95 };
  }
  function gauge(title) {
    const d = diskInfo(title);
    return '<svg viewBox="0 0 52 30"><rect x="1" y="1" width="50" height="28" rx="6" fill="#fff" stroke="#d6deeb" stroke-width="1.5"/><rect x="7" y="17" width="38" height="6" rx="3" fill="#eceff4"/>'
      + '<rect x="7" y="17" width="' + (38 * d.pct / 100).toFixed(1) + '" height="6" rx="3" fill="#e0603f"/>'
      + '<text x="7" y="12.5" font-size="9" font-weight="700" fill="#4a5568" font-family="Segoe UI,Microsoft YaHei UI,sans-serif">' + esc(d.label) + '</text></svg>';
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // g：当前帧的透明度几何（占身体方框的比例：left/right/top/bottom/width/height，头顶中线 cx/head）。
  // crown：头饰高出头顶多少（比例），头顶道具要再往上让开。bubble：正在说的这条（硬盘读标题）。
  // 返回 [{ svg, cls, x, y, w | wf, tx, ty }]：x/y 是锚点（比例），w 是原大小下的像素宽，wf 是占身体方框的比例宽，tx/ty 是自身平移百分比。
  function layout(kind, g, { crown = 0, bubble = null } = {}) {
    if (!kind || !g) return [];
    const above = g.head - crown - 0.015;
    const handX = clamp(g.right - g.width * 0.06, 0.12, 0.92), handY = g.top + g.height * 0.62;
    switch (kind) {
      case 'done': return [{ svg: SIGN, cls: 'pr-pop', x: handX, y: handY, w: 34, tx: -50, ty: -100 }];
      // 头顶上方常被通知卡片的下沿盖住：「…」和感叹号放在头的左上侧，汗珠在右侧。
      case 'wait': return [{ svg: DOTS, cls: 'pr-wave pr-blink', x: clamp(g.cx - g.width * 0.26, 0.1, 1), y: g.head + g.height * 0.2, w: 42, tx: -90, ty: -100 }];
      case 'err': return [
        { svg: BANG, cls: 'pr-pop', x: clamp(g.cx - g.width * 0.3, 0.12, 1), y: g.head + g.height * 0.08, w: 30, tx: -70, ty: -100 },
        { svg: DROP, cls: 'pr-drop', x: clamp(g.cx + g.width * 0.3, 0, 0.98), y: g.head + g.height * 0.08, w: 10, tx: -50, ty: 0 },
      ];
      case 'meeting': return [{ svg: PHONES, cls: 'pr-pop', x: g.cx, y: g.head, wf: clamp(g.width * 0.62, 0.34, 0.6), tx: -50, ty: -16 }];
      case 'gift': return [
        { svg: GIFT, cls: 'pr-pop', x: clamp(g.right - g.width * 0.1, 0.1, 0.9), y: g.bottom, w: 36, tx: -20, ty: -100 },
        { svg: TWINKLE, cls: 'pr-tw', x: clamp(g.right + 0.04, 0, 1.05), y: g.bottom - g.height * 0.32, w: 11, tx: -50, ty: -50 },
      ];
      case 'disk': return [
        { svg: gauge(bubble && bubble.title), cls: 'pr-pop', x: clamp(g.right - g.width * 0.15, 0.1, 0.85), y: g.top + g.height * 0.55, w: 52, tx: -10, ty: -50 },
        { svg: DROP, cls: 'pr-drop', x: clamp(g.cx - g.width * 0.28, 0.02, 1), y: g.head + g.height * 0.08, w: 10, tx: -50, ty: 0 },
      ];
      case 'battery': return [{ svg: BATT, cls: 'pr-pop', x: g.cx, y: above, w: 34, tx: -50, ty: -100 }];
      default: return [];
    }
  }
  return { layout, diskInfo };
});

'use strict';
// 纯透明度几何：静态姿态和每个序列帧都走同一算法，避免下载形象需要人工配坐标。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubPetEvolution = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  function measure(data, w, h, reference = null) {
    const alpha = (x, y) => data[(y * w + x) * 4 + 3];
    let left = w, right = -1, top = h, bottom = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (alpha(x, y) <= 24) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    if (right < left) return null;
    const width = right - left + 1, height = bottom - top + 1;
    const runs = [];
    // 上举的尾巴和细发梢都可能比头更高。先找足够宽的连续轮廓作为头部支撑，
    // 再在其上方附近的 22% 高度带里取重心，避免把装饰戴在细长突起上。
    for (let y = top; y <= bottom; y++) {
      const row = [];
      for (let x = left; x <= right; x++) {
        if (alpha(x, y) <= 24) continue;
        const start = x;
        while (x + 1 <= right && alpha(x + 1, y) > 24) x++;
        row.push({ left: start, right: x, width: x - start + 1, y });
      }
      runs.push(row);
    }
    // 伸懒腰时尾巴会连着拱起的背，单看横向宽度仍会认错。
    // 用轮廓内部距离找最上方的厚实区域：尾巴、耳尖、发梢很薄，头和躯干更厚。
    let coreX = reference ? reference.cx * w - 0.5 : null;
    if (!reference) {
      const stride = w + 2, distance = new Float32Array((w + 2) * (h + 2));
      const diagonal = Math.SQRT2;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y + 1) * stride + x + 1;
        if (alpha(x, y) > 24) distance[i] = Math.min(distance[i - 1] + 1, distance[i - stride] + 1, distance[i - stride - 1] + diagonal, distance[i - stride + 1] + diagonal);
      }
      let deepest = 0;
      for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = (y + 1) * stride + x + 1;
        if (distance[i]) distance[i] = Math.min(distance[i], distance[i + 1] + 1, distance[i + stride] + 1, distance[i + stride - 1] + diagonal, distance[i + stride + 1] + diagonal);
        deepest = Math.max(deepest, distance[i]);
      }
      for (let y = top; y <= bottom && coreX == null; y++) {
        let sum = 0, count = 0;
        for (let x = left; x <= right; x++) if (distance[(y + 1) * stride + x + 1] >= deepest * 0.80) { sum += x; count++; }
        if (count) coreX = sum / count;
      }
    }
    // 序列首帧提供头部所在的水平区域；以后仍逐帧量透明度，只用它排除上举尾巴的歧义。
    // 这是图像自己给出的参照，不依赖角色名或手写坐标。
    const support = runs.flat().find(r => r.width >= width * 0.40 && r.left <= coreX && r.right >= coreX);
    if (!support) return null;
    const seed = coreX;
    const bandTop = Math.max(top, support.y - Math.ceil(height * 0.15));
    const bandBottom = Math.min(bottom, support.y + Math.ceil(height * 0.07));
    const supported = r => r.width >= Math.max(3, width * 0.18) && Math.abs((r.left + r.right) / 2 - seed) <= width * 0.28;
    let weight = 0, sum = 0;
    for (let y = bandTop; y <= bandBottom; y++) for (const r of runs[y - top]) {
      if (!supported(r)) continue;
      const min = reference ? Math.max(r.left, Math.ceil(seed - width * 0.18)) : r.left;
      const max = reference ? Math.min(r.right, Math.floor(seed + width * 0.18)) : r.right;
      for (let x = min; x <= max; x++) { const a = alpha(x, y); sum += x * a; weight += a; }
    }
    const cx = weight ? sum / weight : seed;
    const radius = width * 0.08;
    let head = -1;
    // 只在头部中线附近找顶边，耳尖和头外轮廓不参与头饰的垂直定位。
    for (let y = top; y <= bottom && head < 0; y++) {
      for (const r of runs[y - top]) {
        if (supported(r) && r.right >= cx - radius && r.left <= cx + radius) { head = y; break; }
      }
    }
    if (head < 0) return null;
    return { left: left / w, right: (right + 1) / w, top: top / h, bottom: (bottom + 1) / h,
      cx: (cx + 0.5) / w, head: head / h, width: (right - left + 1) / w, height: (bottom - top + 1) / h };
  }
  // 小于 1.5 个显示像素时沿用上一个落点；大动作立即跟随，换图或换形象时由调用端清空。
  function anchor(next, prev, size) {
    if (!next) return null;
    if (!prev) return { x: next.cx, y: next.head };
    return { x: Math.abs(next.cx - prev.x) * size <= 1.5 ? prev.x : next.cx,
      y: Math.abs(next.head - prev.y) * size <= 1.5 ? prev.y : next.head };
  }
  return { measure, anchor };
});

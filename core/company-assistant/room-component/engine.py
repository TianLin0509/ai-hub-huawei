"""抢订引擎：浏览器里的每一步操作。

保留旧版已经连续 18 次成功的做法（选择器、点击方式、各步等待时间），在它外面加：
  1. 登录失效识别：看不到预定表单就明确报“登录失效”，不再等超时；
  2. 网格自动标定：按会议室那一行实际出现的 30px 格子推算起点和格宽，
     页面挪位时自动跟上；标定不出来才退回旧的 472/30；
  3. 结果判定只看“点击后新出现的文字”，页面上原本就有的“成功”字样不会误判；
  4. 首选被抢走时，重新打开页面换下一间会议室再提交。
"""
import json
import math
import os
import threading
import time
from datetime import datetime, timedelta

from . import config as C
from .clock import wait_until

PROFILE_LOCK = threading.Lock()  # 浏览器资料夹同一时刻只能被一个浏览器用

TAKEN_WORDS = ("冲突", "已被预定", "已被预订", "已被占用")

JS_PAGE_STATE = """() => {
  const i = document.querySelector('input.ev_textField_input');
  return { form: !!(i && i.offsetWidth > 0),
           pwd: !!document.querySelector('input[type=password]'),
           url: location.href };
}"""

JS_SET_DATE = """(v) => {
  const input = document.querySelector('input.ev_datepicker_input');
  if (!input) return null;
  input.removeAttribute('readonly');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.value;
}"""

JS_LEAF_CLICK = """(t) => {
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el.children.length > 0) continue;
    if (el.textContent.trim() === t) { el.click(); return true; }
  }
  return false;
}"""

JS_SELECT_TEXT = """(i) => {
  const s = document.querySelectorAll('.ev_selectCom.order-time-select')[i];
  return s ? s.innerText.trim() : null;
}"""

JS_CLICK_DATE_TAB = """(d) => {
  for (const e of document.querySelectorAll('*')) {
    if (e.children.length <= 2 && e.textContent.trim().startsWith(d)) { e.click(); return true; }
  }
  return false;
}"""

JS_ROOM_Y = """(n) => {
  for (const e of document.querySelectorAll('*')) {
    if (e.children.length === 0 && e.textContent.trim() === n) {
      const r = e.getBoundingClientRect();
      if (r.height > 0) return r.y + r.height / 2;
    }
  }
  return null;
}"""

# Only fixed fields: never copy URLs, arbitrary page text, account data or HTML.
JS_ROOM_DIAGNOSTICS = """(name) => {
  const visible = e => { const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && (hit === e || e.contains(hit)); };
  const matches = [...document.querySelectorAll('body *')].filter(e => e.textContent.trim() === name);
  const date = document.querySelector('input.ev_datepicker_input')?.value || '';
  const tabs = ['可用会议室', '全部会议室', '我的收藏'];
  const active = [...document.querySelectorAll('[aria-selected="true"],.active,.is-active,.selected')]
    .map(e => e.textContent.trim()).find(t => tabs.includes(t)) || null;
  return {readyState: document.readyState, formDate: /^\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}$/.test(date) ? date : null,
    activeRoomTab: active, labelMatches: matches.length,
    leafMatches: matches.filter(e => !e.children.length).length,
    visibleMatches: matches.filter(visible).length};
}"""

# 会议室那一行里所有约 30px 宽的格子的 X 坐标、宽度、是否真的显示在屏幕上
# （真实页面的网格从 0:00 排满全天，0:00–8:00 的格子在 DOM 里但被裁在可视区左边）
JS_ROW_CELLS = """(y) => {
  const xs = [], ws = [], vis = [];
  for (const e of document.querySelectorAll('div')) {
    const r = e.getBoundingClientRect();
    if (r.width >= 20 && r.width <= 60 && r.height > 0 && Math.abs(r.y + r.height / 2 - y) < 15) {
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const hit = cx >= 0 && cx < innerWidth ? document.elementFromPoint(cx, cy) : null;
      xs.push(r.x); ws.push(r.width); vis.push(!!hit && (hit === e || e.contains(hit)));
    }
  }
  return { xs, ws, vis };
}"""

JS_CELL_CLASSES = """([xs, y]) => {
  const out = [];
  for (const x of xs) {
    let f = null;
    for (const e of document.querySelectorAll('div')) {
      const r = e.getBoundingClientRect();
      if (Math.abs(r.x - x) < 5 && Math.abs(r.y + r.height / 2 - y) < 15 && r.width >= 28 && r.width <= 32) {
        f = String(e.className); break;
      }
    }
    out.push(f);
  }
  return out;
}"""

JS_CLICK_CELL = """([x, y]) => {
  for (const e of document.querySelectorAll('div')) {
    const r = e.getBoundingClientRect();
    if (Math.abs(r.x - x) < 5 && Math.abs(r.y + r.height / 2 - y) < 15 && r.width >= 28 && r.width <= 32) {
      e.click(); return true;
    }
  }
  return false;
}"""

# 「从页面读取」会议室：找出屏幕上有 8 个以上时段格子的行，取格子左边同一行最靠左的文字当会议室名
JS_LIST_ROOMS = """() => {
  const vis = e => { const r = e.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return false;
    const h = document.elementFromPoint(cx, cy); return !!h && (h === e || e.contains(h)); };
  const cells = [];
  for (const e of document.querySelectorAll('div')) {
    const r = e.getBoundingClientRect();
    if (r.width >= 28 && r.width <= 32 && r.height >= 16 && r.height <= 60 && vis(e)) cells.push({ x: r.x, y: r.y + r.height / 2 });
  }
  cells.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const c of cells) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - c.y) < 6) { last.n++; last.minx = Math.min(last.minx, c.x); }
    else rows.push({ y: c.y, n: 1, minx: c.x });
  }
  const leaves = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.children.length) continue;
    const t = (e.textContent || '').trim();
    if (!t || t.length > 40 || /^\\d{1,2}(:\\d{2})?$/.test(t)) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && vis(e)) leaves.push({ t, x: r.x, right: r.right, y: r.y + r.height / 2 });
  }
  const out = [];
  for (const row of rows) {
    if (row.n < 8) continue;
    const c = leaves.filter(l => Math.abs(l.y - row.y) < 15 && l.right <= row.minx + 2).sort((a, b) => a.x - b.x);
    if (c.length && !out.includes(c[0].t)) out.push(c[0].t);
  }
  return out;
}"""

# Find the scroll owner of the visible grid, rather than wheeling at a fixed
# screen coordinate. Keep a reference during asynchronous/virtual-list paints.
JS_ROOM_SCROLL = """(action) => {
  const shown = e => { const r = e.getBoundingClientRect();
    const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width > 0 && r.height > 0 && !!h && (h === e || e.contains(h)); };
  if (action === 'reset') delete window.__mszRoomScroll;
  let owner = window.__mszRoomScroll;
  if (owner && (!owner.isConnected || !owner.clientHeight)) owner = null;
  let rowHeight = 28;
  if (!owner) {
    const scores = new Map();
    const root = document.scrollingElement;
    for (const cell of document.querySelectorAll('div')) {
      const r = cell.getBoundingClientRect();
      if (r.width < 28 || r.width > 32 || r.height < 16 || r.height > 60 || !shown(cell)) continue;
      rowHeight = Math.max(rowHeight, r.height);
      let candidate = root;
      for (let p = cell.parentElement; p && p !== root; p = p.parentElement) {
        if (p.scrollHeight > p.clientHeight + 1 && p.clientHeight > 0
            && /auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowY)) {
          candidate = p; break;
        }
      }
      // The document can scroll with overflow:visible; it is not an ordinary
      // overflow:auto element. A visible grid still needs a verified owner.
      if (candidate) scores.set(candidate, (scores.get(candidate) || 0) + 1);
    }
    owner = [...scores].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    window.__mszRoomScroll = owner;
  }
  let scroll = null;
  if (owner) {
    const isRoot = owner === document.scrollingElement;
    const height = isRoot ? innerHeight : owner.clientHeight;
    const r = owner.getBoundingClientRect();
    let top = isRoot ? 0 : Math.max(0, r.top + owner.clientTop);
    let bottom = isRoot ? innerHeight : Math.min(innerHeight, r.top + owner.clientTop + height);
    for (let p = isRoot ? null : owner.parentElement; p; p = p.parentElement) {
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowY)) {
        const pr = p.getBoundingClientRect();
        top = Math.max(top, pr.top + p.clientTop);
        bottom = Math.min(bottom, pr.top + p.clientTop + p.clientHeight);
      }
    }
    const viewHeight = Math.max(0, Math.min(height, bottom - top));
    const blocked = !isRoot && /hidden|clip/.test(getComputedStyle(owner).overflowY);
    if (action === 'reset') owner.scrollTop = 0;
    if (action === 'next' && viewHeight > 0) owner.scrollTop += Math.max(1, Math.floor(viewHeight * .8));
    scroll = {top: owner.scrollTop, height, scrollHeight: owner.scrollHeight,
              viewHeight, rowHeight, blocked};
  }
  const names = (""" + JS_LIST_ROOMS + """)();
  const busy = [...document.querySelectorAll('[aria-busy="true"]')].some(shown);
  return {names, scroll, busy};
}"""

JS_CLICK_BUTTON = """(t) => {
  for (const b of document.querySelectorAll('button')) {
    if (b.textContent.trim() === t && b.offsetWidth > 0 && !b.disabled) { b.click(); return true; }
  }
  return false;
}"""

# 与旧版一致：只认文字为「预定」且可见的按钮
JS_CLICK_BOOK = """() => {
  for (const b of document.querySelectorAll('button')) {
    if (b.textContent.trim() === '预定' && b.offsetWidth > 0) { b.click(); return true; }
  }
  return false;
}"""

JS_HAS_BOOK_BUTTON = """() => {
  for (const b of document.querySelectorAll('button')) {
    if (b.textContent.trim() === '预定' && b.offsetWidth > 0) return true;
  }
  return false;
}"""

JS_VISIBLE_TEXTS = """() => {
  const s = new Set();
  for (const el of document.querySelectorAll('*')) {
    if (el.offsetWidth > 0) {
      const t = el.textContent.trim();
      if (t.length > 2 && t.length < 100) s.add(t);
    }
  }
  return [...s];
}"""

# 只看 baseline 里没有的文字；判定词与旧版一致
JS_RESULT = """(base) => {
  const old = new Set(base);
  let err = null;
  for (const el of document.querySelectorAll('*')) {
    const t = el.textContent.trim();
    if (t.length < 100 && t.length > 2 && el.offsetWidth > 0 && !old.has(t)) {
      if (t.includes('成功')) return { s: 'success', m: t };
      if (!err && (t.includes('失败') || t.includes('冲突') || t.includes('已被预定') || t.includes('已被预订') || t.includes('已被占用'))
          && el.getBoundingClientRect().y > 100) err = t;
    }
  }
  return err ? { s: 'error', m: err } : { s: 'unknown' };
}"""


class StopRequested(Exception):
    pass


class LoginRequired(Exception):
    pass


def _short(e):
    s = str(e).strip().splitlines()
    return s[0][:160] if s else type(e).__name__


class Booker:
    def __init__(self, cfg, log, stop_event, clock):
        self.cfg = cfg
        self.log = log
        self.stop = stop_event
        self.clock = clock
        adv = cfg["高级"]
        self.factor = float(adv.get("等待倍率", 1.0) or 1.0)
        self.url = adv.get("网址") or C.DEFAULT_URL
        self.grid_x0 = float(adv.get("网格起点X", 472))
        self.cell_w = float(adv.get("格子宽度", 30))
        gh, gm = map(int, str(adv.get("网格起始时间", "08:30")).split(":"))
        self.grid_start_h = gh + gm / 60
        self.calibrated = False
        self.pw = None
        self.ctx = None
        self.page = None
        self._locked = False
        self.warnings = []
        os.makedirs(C.path("screenshots"), exist_ok=True)

    # ---------- 基础 ----------
    def sleep(self, s):
        end = time.time() + s * self.factor
        while True:
            if self.stop.is_set():
                raise StopRequested()
            left = end - time.time()
            if left <= 0:
                return
            time.sleep(min(0.1, left))

    def sleep_real(self, s):
        """整点提交阶段的等待不受测试倍率影响。"""
        f, self.factor = self.factor, 1.0
        try:
            self.sleep(s)
        finally:
            self.factor = f

    def warn(self, msg):
        self.warnings.append(msg)
        self.log(msg, "warn")

    def shot(self, name):
        try:
            p = C.path("screenshots", name + ".png")
            self.page.screenshot(path=p)
            return p
        except Exception:
            return None

    def launch(self, headless=None):
        if not PROFILE_LOCK.acquire(timeout=120):
            raise RuntimeError("浏览器资料夹一直被占用：请先关掉本程序打开的登录浏览器窗口")
        self._locked = True
        from playwright.sync_api import sync_playwright

        adv = self.cfg["高级"]
        if headless is None:
            headless = bool(adv.get("无界面", False))
        order = {
            "自动": [("msedge", "Edge"), ("chrome", "Chrome"), (None, "内置 Chromium")],
            "Edge": [("msedge", "Edge")],
            "Chrome": [("chrome", "Chrome")],
            "内置Chromium": [(None, "内置 Chromium")],
        }.get(adv.get("浏览器", "自动"), [("msedge", "Edge"), ("chrome", "Chrome"), (None, "内置 Chromium")])
        self.pw = sync_playwright().start()
        last = None
        for ch, name in order:
            kw: dict = dict(
                user_data_dir=C.path("browser_profile"),
                headless=headless,
                viewport={"width": 1400, "height": 900},
                args=["--ignore-certificate-errors"],
                ignore_https_errors=True,
            )
            if ch:
                kw["channel"] = ch
            try:
                self.ctx = self.pw.chromium.launch_persistent_context(**kw)
                self.log(f"已启动浏览器：{name}")
                break
            except Exception as e:
                last = e
                msg = _short(e)
                if "already in use" in msg or "ProcessSingleton" in msg or "lock" in msg.lower():
                    self.close()
                    raise RuntimeError("登录用的浏览器资料夹正被另一个浏览器窗口占用，请关掉它后重试")
                self.log(f"{name} 启动失败：{msg}", "warn")
        if self.ctx is None:
            self.close()
            raise RuntimeError(f"找不到可用的浏览器（Edge、Chrome 都没启动成功）：{_short(last)}")
        self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()
        self.page.set_default_timeout(15000)

    def close(self):
        for fn in (lambda: self.ctx and self.ctx.close(), lambda: self.pw and self.pw.stop()):
            try:
                fn()
            except Exception:
                pass
        self.ctx = self.pw = self.page = None
        if self._locked:
            self._locked = False
            PROFILE_LOCK.release()

    # ---------- 登录 ----------
    def wait_for_form(self, timeout=45):
        deadline = time.time() + timeout
        pwd_since = None
        while time.time() < deadline:
            if self.stop.is_set():
                raise StopRequested()
            try:
                st = self.page.evaluate(JS_PAGE_STATE)
            except Exception:
                st = None  # 页面正在跳转
            if st and st["form"]:
                return True, ""
            if st and st["pwd"]:
                pwd_since = pwd_since or time.time()
                if time.time() - pwd_since > 6:
                    return False, "页面停在了登录页"
            else:
                pwd_since = None
            time.sleep(0.5)
        return False, f"等了 {timeout} 秒仍没看到预定表单（可能登录已失效，或内网/VPN 没连上）"

    def open_page(self, retry=False):
        t0 = time.time()
        if retry:
            # goto(the same hash URL) is a same-document navigation: the failed
            # booking's modal still intercepts form clicks. Reload the document
            # and use the newly rendered form instead of the initial 8 s floor.
            self.page.reload(wait_until="domcontentloaded", timeout=15000)
            self.calibrated = False
            ok, why = self.wait_for_form(timeout=15)
        else:
            self.page.goto(self.url, wait_until="domcontentloaded", timeout=60000)
            ok, why = self.wait_for_form()
        if not ok:
            self.shot("login_required")
            raise LoginRequired(why)
        if retry:
            return
        # 旧版固定等 8 秒让页面数据加载完，这里保留这个下限
        rest = 8 - (time.time() - t0) / self.factor
        if rest > 0:
            self.sleep(rest)

    # ---------- 表单 ----------
    def fill_form(self, topic, date_slash, start, hours, minutes):
        loc = self.page.locator("input.ev_textField_input").first
        loc.click()
        loc.fill("")
        loc.fill(topic)
        self.sleep(0.5)

        v = self.page.evaluate(JS_SET_DATE, date_slash)
        self.page.keyboard.press("Escape")
        self.sleep(1)
        if v != date_slash:
            self.warn(f"日期框写入后显示的是「{v}」，不是 {date_slash}")

        for idx, val in enumerate([start, f"{int(hours):02d}", f"{int(minutes):02d}"]):
            self.page.locator(".ev_selectCom.order-time-select").nth(idx).click()
            self.sleep(1)
            if not self.page.evaluate(JS_LEAF_CLICK, val):
                self.warn(f"下拉框 {idx + 1} 里没找到选项「{val}」")
            self.sleep(0.5)
            shown = self.page.evaluate(JS_SELECT_TEXT, idx)
            if shown is not None and val not in shown:
                self.warn(f"下拉框 {idx + 1} 选完后显示「{shown}」，期望「{val}」")
        self.log(f"已填表：{topic}｜{date_slash}｜{start} 起 {int(hours)} 小时 {int(minutes)} 分")

    # ---------- 会议室弹窗 ----------
    def open_room_dialog(self, date_slash):
        self.page.locator("button.ev_button.primary", has_text="添加会议室").first.click()
        self.sleep(4)
        if not self.page.evaluate(JS_CLICK_DATE_TAB, date_slash):
            self.warn(f"会议室弹窗里没找到日期 {date_slash} 的标签，按弹窗默认日期继续")
        self.sleep(2)

    def _calibrate(self, y):
        """找出「网格起始时间」（默认 8:30）那一格的 X 坐标和格宽。

        一行格子不一定从 8:30 开始：真实页面从 0:00 排满全天，只是滚到 8:30 才显示。
        所以不能把这一行的第一格当成 8:30（v2.0.0 的错误，订成了 5:30–7:30），而是：
          1. 旧坐标（472）上正好有一个显示着的格子 → 沿用旧坐标，只校正格宽（旧版 18 次全成功的定位）；
          2. 旧坐标上没有显示着的格子（页面挪位）→ 取屏幕上能看见的第一格当 8:30；
          3. 判断不出哪些格子在屏幕上 → 不标定，按旧坐标。
        选完格子后 prepare() 还会核对表单上的时间，对不上就不提交。
        """
        data = self.page.evaluate(JS_ROW_CELLS, y)
        xs, vis = [], []
        for x, w, v in sorted(zip(data["xs"], data["ws"], data["vis"])):
            if 28 <= w <= 32:
                if xs and x - xs[-1] <= 3:
                    vis[-1] = vis[-1] or v
                else:
                    xs.append(x)
                    vis.append(v)
        if len(xs) < 6:
            return
        # 找最长一段等间距的格子（下标区间）
        runs, s = [], 0
        for i in range(1, len(xs) + 1):
            if i == len(xs) or not (27 <= xs[i] - xs[i - 1] <= 33 and (i - s < 2 or abs((xs[i] - xs[i - 1]) - (xs[s + 1] - xs[s])) <= 2)):
                runs.append((s, i))
                s = i
        s, e = max(runs, key=lambda r: r[1] - r[0])
        if e - s < 6:
            return
        run, rvis = xs[s:e], vis[s:e]
        step = (run[-1] - run[0]) / (len(run) - 1)
        shown = [x for x, v in zip(run, rvis) if v]
        hidden = len(run) - len(shown)
        if not shown:
            self.log(f"自动标定：这一行有 {len(run)} 个格子，但判断不出哪些显示在屏幕上，按旧坐标 {self.grid_x0:.0f}/{self.cell_w:.0f}", "warn")
            return
        near = [x for x in shown if abs(x - self.grid_x0) <= 3]
        if near:
            x0 = near[0]
            how = "旧坐标上就是格子，沿用"
        else:
            x0 = shown[0]
            how = "旧坐标上没有显示的格子，取屏幕上第一格当网格起始时间"
        detail = f"（这一行共 {len(run)} 格，其中 {hidden} 格不在屏幕上）" if hidden else ""
        if abs(x0 - self.grid_x0) > 3 or abs(step - self.cell_w) > 1:
            self.log(f"自动标定：网格起点 {self.grid_x0:.0f}→{x0:.0f}，格宽 {self.cell_w:.0f}→{step:.1f}，{how}{detail}", "warn")
        else:
            self.log(f"自动标定：网格起点 {x0:.0f}、格宽 {step:.1f}，与旧标定一致{detail}")
        self.grid_x0, self.cell_w = x0, step
        self.calibrated = True

    def check_form_time(self, start, hours, minutes):
        """选完会议室后核对表单上的开始时间和时长。真实页面以选中的格子为准改写表单，
        格子选错时这里会显示错的时间。返回不一致的说明，一致或读不到返回空串。"""
        want = [start, f"{int(hours):02d}", f"{int(minutes):02d}"]
        shown = [self.page.evaluate(JS_SELECT_TEXT, i) for i in range(3)]
        bad = [f"{s}（应为 {w}）" for w, s in zip(want, shown) if s is not None and w not in s]
        return "、".join(bad)

    def slot_xs(self, start, total_min):
        h, m = map(int, start.split(":"))
        first = int(((h + m / 60) - self.grid_start_h) * 2)
        n = max(1, math.ceil(total_min / 30))
        return [self.grid_x0 + (first + i) * self.cell_w for i in range(n)]

    def check_room(self, room, start, total_min):
        """返回 (状态, y, xs)。状态：free / taken / missing / nogrid"""
        y = self.page.evaluate(JS_ROOM_Y, room)
        if y is None:
            return "missing", None, None
        if not self.calibrated and self.cfg["高级"].get("自动标定网格", True):
            self._calibrate(y)
        xs = self.slot_xs(start, total_min)
        classes = self.page.evaluate(JS_CELL_CLASSES, [xs, y])
        if any(c is None for c in classes):
            return "nogrid", y, xs
        if any(("over" in c) or ("order" in c) for c in classes):
            return "taken", y, xs
        return "free", y, xs

    def pick_cells(self, xs, y):
        for i, x in enumerate(xs):
            if not self.page.evaluate(JS_CLICK_CELL, [x, y]):
                self.warn(f"第 {i + 1} 个时段格子没点到")
            self.sleep(1.5 if i == 0 else 0.5)
        self.sleep(1)
        if not self.page.evaluate(JS_CLICK_BUTTON, "确认"):
            raise RuntimeError("会议室弹窗里没找到可点的「确认」按钮")
        self.sleep(2)

    def prepare(self, date_slash, exclude=(), retry=False):
        """返回选中的会议室；未选到返回 None，原因由 selection_failure() 区分。"""
        cfg = self.cfg
        self.room_checks = []
        total_min = int(cfg["时长小时"]) * 60 + int(cfg["时长分钟"])
        if retry:
            self.open_page(retry=True)
        else:
            self.open_page()
        self.fill_form(cfg["主题"], date_slash, cfg["开始时间"], cfg["时长小时"], cfg["时长分钟"])
        self.open_room_dialog(date_slash)
        for room in cfg["优先会议室"]:
            if room in exclude:
                # Only the runner's confirmed booking conflicts enter exclude.
                self.room_checks.append((room, "taken"))
                continue
            st, y, xs = self.check_room(room, cfg["开始时间"], total_min)
            self.room_checks.append((room, st))
            if st == "free":
                self.log(f"选中会议室：{room}（{len(xs)} 个半小时格子都空闲）")
                self.pick_cells(xs, y)
                bad = self.check_form_time(cfg["开始时间"], cfg["时长小时"], cfg["时长分钟"])
                if bad:
                    self.shot("time_mismatch")
                    raise RuntimeError(f"选完格子后表单时间变成了 {bad}，说明格子定位错了，已停止提交以免订错时段"
                                       "（截图 screenshots/time_mismatch.png）")
                return room
            reason = {"taken": "该时段已被占用", "missing": "弹窗里没找到这间", "nogrid": "没定位到时段格子"}[st]
            self.log(f"跳过 {room}：{reason}")
            if st in ("missing", "nogrid"):
                self.log_room_diagnostic(room, st, date_slash)
        return None

    def selection_failure(self):
        checks = getattr(self, "room_checks", [])
        if checks and all(state == "taken" for _, state in checks):
            return "满员", "优先列表全部被占"
        reasons = {"missing": "未找到房间", "nogrid": "未定位到时段格子"}
        detail = "；".join(f"{room}：{reasons.get(state, '状态未确认')}"
                          for room, state in checks if state != "taken")
        return "错误", "会议室识别未完成：" + (detail or "没有可检查的优先会议室") + "。请查看运行日志。"

    def log_room_diagnostic(self, room, reason, date_slash):
        data = {"room": room[:120], "reason": reason, "expectedDate": date_slash,
                "start": self.cfg["开始时间"]}
        try:
            probe = self.page.evaluate(JS_ROOM_DIAGNOSTICS, room)
            # The allowlist also protects against unexpected page/plugin results.
            for key in ("labelMatches", "leafMatches", "visibleMatches"):
                value = probe.get(key)
                if type(value) is int and 0 <= value <= 100000:
                    data[key] = value
            if probe.get("readyState") in ("loading", "interactive", "complete"):
                data["readyState"] = probe["readyState"]
            if probe.get("activeRoomTab") in ("可用会议室", "全部会议室", "我的收藏"):
                data["activeRoomTab"] = probe["activeRoomTab"]
            value = probe.get("formDate")
            if isinstance(value, str) and len(value) <= 10:
                try:
                    datetime.strptime(value.replace("-", "/"), "%Y/%m/%d")
                    data["formDate"] = value
                except ValueError:
                    pass
        except Exception:
            data["probeUnavailable"] = True
        self.log("[会议室诊断] " + json.dumps(data, ensure_ascii=False), "warn")

    def _wait_room_snapshot(self, deadline, previous=None):
        last, since = None, time.monotonic()
        while time.monotonic() < deadline:
            if self.stop.is_set():
                raise StopRequested()
            state = self.page.evaluate(JS_ROOM_SCROLL, "snapshot")
            key = json.dumps(state, sort_keys=True, ensure_ascii=False)
            if key != last:
                last, since = key, time.monotonic()
            scroll = state.get("scroll")
            stale = False
            if previous and scroll and previous.get("scroll"):
                delta = abs(scroll["top"] - previous["scroll"]["top"])
                stale = delta >= scroll["rowHeight"] and state["names"] == previous["names"]
            if (state["names"] and not state["busy"] and not stale
                    and (not scroll or scroll["viewHeight"] > 0)
                    and time.monotonic() - since >= 0.8):
                return state
            self.sleep_real(0.15)
        raise RuntimeError("会议室读取未完成：页面仍在加载或列表没有稳定，请确认页面后重试")

    def list_rooms(self):
        deadline = time.monotonic() + 30
        if self.stop.is_set():
            raise StopRequested()
        self.page.evaluate(JS_ROOM_SCROLL, "reset")
        state = self._wait_room_snapshot(deadline)
        # The list may only have mounted after the initial reset.
        if state.get("scroll") and state["scroll"]["top"] > 0:
            self.page.evaluate(JS_ROOM_SCROLL, "reset")
            state = self._wait_room_snapshot(deadline)
        names, seen = [], set()
        for _ in range(120):
            for name in state["names"]:
                if name not in seen:
                    names.append(name)
                    seen.add(name)
            scroll = state.get("scroll")
            if not scroll:
                raise RuntimeError("会议室读取未完成：无法确认列表滚动区域，请确认页面后重试")
            if scroll.get("blocked") or scroll["viewHeight"] + 1 < scroll["height"]:
                raise RuntimeError("会议室读取未完成：列表被窗口或外层区域裁剪，请展开完整列表后重试")
            if scroll["top"] + scroll["height"] >= scroll["scrollHeight"] - 1:
                return names
            self.page.evaluate(JS_ROOM_SCROLL, "next")
            following = self._wait_room_snapshot(deadline, state)
            if not following.get("scroll") or following["scroll"]["top"] <= scroll["top"]:
                raise RuntimeError("会议室读取未完成：列表未能继续滚动，请确认页面后重试")
            state = following
        raise RuntimeError("会议室读取未完成：列表超出本次读取范围，请缩小网页筛选范围")

    # ---------- 提交 ----------
    def submit(self, open_at, max_retries, interval_ms, tag):
        """等到 open_at（服务器时钟）后连续点「预定」。返回 (结果, 文案)。
        结果：success / taken / fail / unknown
        """
        base = self.page.evaluate(JS_VISIBLE_TEXTS)
        if open_at is not None and self.clock.now() < open_at:
            self.log(f"已就绪，等待开放时刻 {open_at:%H:%M:%S}")
            if not wait_until(self.clock, open_at, self.stop):
                raise StopRequested()
        last_err, gone = None, False
        for attempt in range(1, max_retries + 1):
            clicked = self.page.evaluate(JS_CLICK_BOOK)
            t = self.clock.now()
            self.log(f"第 {attempt} 次点「预定」{'' if clicked else '（没找到按钮）'}  服务器时间 {t:%H:%M:%S}.{t.microsecond // 1000:03d}")
            self.sleep_real(0.5)
            st = self.page.evaluate(JS_RESULT, base)
            self.shot(f"grab_attempt_{tag}_{attempt}")
            if st["s"] == "success":
                self.shot(f"grab_success_{tag}")
                return "success", st["m"]
            if st["s"] == "error":
                last_err = st["m"]
                self.log(f"页面提示：{last_err}", "warn")
            if not clicked and not self.page.evaluate(JS_HAS_BOOK_BUTTON):
                gone = True
                break
            self.sleep_real(interval_ms / 1000)
        self.shot(f"grab_final_{tag}")
        if last_err and any(w in last_err for w in TAKEN_WORDS):
            return "taken", last_err
        if last_err:
            return "fail", last_err
        if gone:
            return "unknown", "「预定」按钮消失了但没看到成功提示，可能已成功，需人工确认"
        return "unknown", "点了预定但页面没有给出成功或失败提示"


def interactive_login(cfg, log, stop_event, timeout=600):
    """弹出浏览器让用户手动登录；看到预定表单即判定登录成功并自动关闭。"""
    b = Booker(cfg, log, stop_event, None)
    try:
        b.launch(headless=False)
        b.page.goto(b.url, wait_until="domcontentloaded", timeout=60000)
        log("已打开浏览器：请在弹出的窗口里完成工号/密码登录，登录成功后会自动关闭")
        end = time.time() + timeout
        while time.time() < end:
            if stop_event.is_set():
                return False
            if b.page.is_closed():
                log("登录窗口被关闭", "warn")
                return False
            try:
                if b.page.evaluate(JS_PAGE_STATE)["form"]:
                    log("登录成功，已看到预定表单", "ok")
                    time.sleep(1.5)
                    return True
            except Exception:
                pass
            time.sleep(1)
        log("等待登录超时（10 分钟）", "warn")
        return False
    finally:
        b.close()


def read_rooms(cfg, log, stop_event, date_slash):
    """从列表顶部逐屏读取；未到稳定的底部不把部分名单当成成功。"""
    b = Booker(cfg, log, stop_event, None)
    try:
        b.launch()
        b.open_page()
        b.fill_form(cfg["主题"], date_slash, cfg["开始时间"], cfg["时长小时"], cfg["时长分钟"])
        b.open_room_dialog(date_slash)
        names = b.list_rooms()
        b.shot("rooms_read")
        log(f"从页面读到 {len(names)} 间会议室" + ("" if names else "（没认出来，截图在 screenshots/rooms_read.png）"),
            "ok" if names else "warn")
        return names
    finally:
        b.close()

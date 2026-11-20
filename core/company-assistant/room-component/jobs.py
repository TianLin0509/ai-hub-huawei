"""一次抢订 / 守护循环 / 登录预检的编排，不依赖界面，测试脚本可直接调用。

phase(key, status, text) 把每一步的进度告诉界面：
  key:    precheck 登录预检 / prepare 填表选房 / submit 整点提交 / post 会后动作
  status: wait 等待 / run 进行中 / ok 完成 / bad 失败 / skip 跳过
"""
import time
from datetime import datetime, timedelta

from . import config as C
from .clock import Clock, measure_offset, wait_until
from .engine import Booker, LoginRequired, StopRequested, _short


def parse_hms(s):
    parts = [int(x) for x in str(s).split(":")] + [0, 0]
    return parts[0], parts[1], parts[2]


class Runner:
    def __init__(self, cfg, log, phase, stop_event, clock=None):
        self.cfg = cfg
        self.log = log
        self.phase = phase
        self.stop = stop_event
        self.clock = clock or Clock()
        self.login_ok = None  # None 未检查 / True / False

    # ---------- 时间 ----------
    def open_time_on(self, day):
        h, m, s = parse_hms(self.cfg["抢订设置"]["开放时间"])
        return datetime(day.year, day.month, day.day, h, m, s)

    def next_open(self):
        now = self.clock.now()
        today = self.open_time_on(now.date())
        return today if now < today else self.open_time_on(now.date() + timedelta(days=1))

    def calibrate_clock(self):
        if not self.cfg["抢订设置"].get("校准服务器时间", True):
            return
        try:
            off, err = measure_offset(self.cfg["高级"]["网址"])
        except Exception as e:
            self.log(f"服务器时间校准没做成（{_short(e)}），按本机时钟", "warn")
            return
        if abs(off) > 30:
            self.log(f"测得本机与服务器相差 {off:+.2f} 秒，差得离谱，不采用；请检查电脑时间", "warn")
            return
        self.clock.offset = off if abs(off) >= 0.05 else 0.0
        self.clock.uncertainty = err
        self.clock.measured_at = datetime.now()
        self.log(f"时间校准：{self.clock.describe()}（误差约 ±{err * 1000:.0f} 毫秒）")

    # ---------- 登录预检 ----------
    def precheck(self):
        self.phase("precheck", "run", "正在打开页面检查登录状态…")
        b = Booker(self.cfg, self.log, self.stop, self.clock)
        try:
            b.launch()
            b.page.goto(b.url, wait_until="domcontentloaded", timeout=60000)
            ok, why = b.wait_for_form()
        except StopRequested:
            raise
        except Exception as e:
            ok, why = False, _short(e)
        finally:
            b.close()
        self.login_ok = ok
        if ok:
            self.phase("precheck", "ok", "登录有效")
            self.log("登录预检：登录有效", "ok")
        else:
            self.phase("precheck", "bad", f"登录失效：{why}")
            self.log(f"登录预检：{why}", "bad")
        self.calibrate_clock()
        return ok

    # ---------- 一次完整抢订 ----------
    def grab(self, open_at, target_date, test=False):
        """open_at 为 None 表示不等开放时刻（已过点）。返回结果 dict。"""
        cfg = self.cfg
        s = cfg["抢订设置"]
        date_str = target_date.strftime("%Y-%m-%d")
        date_slash = target_date.strftime("%Y/%m/%d")
        td = C.time_desc(cfg)
        res = {"date": date_str, "status": "错误", "room": None, "note": "", "test": test}
        if self.clock.measured_at is None:
            self.calibrate_clock()
        self.phase("prepare", "run", f"正在填表、挑会议室（目标 {date_slash}）")
        b = Booker(cfg, self.log, self.stop, self.clock)
        notes = []
        try:
            b.launch()
            t0 = time.time()
            room = b.prepare(date_slash)
            prep_s = time.time() - t0
            self.login_ok = True
            b.shot(f"prepared_{date_str}")
            if room is None:
                b.shot(f"failed_{date_str}")
                status, note = b.selection_failure()
                self.phase("prepare", "bad", note)
                res.update(status=status, note=note)
                return self._finish(res, td)
            lead = self.lead_seconds()
            margin = (open_at - self.clock.now()).total_seconds() if open_at else None
            msg = f"已选好 {room}，用时 {prep_s:.0f} 秒"
            if margin is not None and margin < 0 and not test:
                self.log(f"准备完成时已过开放时刻 {-margin:.1f} 秒：提前量 {lead} 秒不够，建议调大", "warn")
                notes.append(f"准备晚了 {-margin:.0f} 秒")
            self.phase("prepare", "ok", msg)
            armed = [(b.page, room)] + self._arm_backups(b, date_slash, room, open_at, test)
            if len(armed) > 1:
                names = "、".join(r for _, r in armed)
                self.log(f"已备好 {len(armed)} 间（{names}）：首选被占时立即提交下一间", "ok")
                self.phase("prepare", "ok", f"已备好 {len(armed)} 间：{names}")
            if test:
                self.phase("submit", "skip", "测试模式，不提交")
                done = f"备好 {len(armed)} 间（{'、'.join(r for _, r in armed)}），填表用时 {prep_s:.0f} 秒"
                res.update(status="测试", room=room, note=("；".join(b.warnings) or f"{done}，没有异常"))
                return self._finish(res, td)

            tried = []
            deadline = (open_at or self.clock.now()) + timedelta(minutes=3)
            rounds = 0
            queue = armed[1:]
            b.page = armed[0][0]
            while True:
                rounds += 1
                self.phase("submit", "run", f"提交中：{room}")
                outcome, text = b.submit(open_at if rounds == 1 else None, s["最大重试次数"], s["重试间隔毫秒"], f"{date_str}_{rounds}")
                if outcome == "success":
                    if tried:
                        notes.append(f"首选被抢，换到 {room}")
                    res.update(status="成功", room=room)
                    self.phase("submit", "ok", f"抢到了：{room}")
                    break
                if outcome == "unknown":
                    res.update(status="待核验", room=room)
                    notes.append(text)
                    self.phase("submit", "bad", text)
                    break
                # taken / fail
                self.log(f"{room} 没抢到：{text}", "warn")
                if outcome == "taken":
                    tried.append(room)
                if not s.get("抢不到换下一间", True) or self.clock.now() > deadline or rounds >= 3 + len(armed):
                    res.update(status="失败", room=None)
                    notes.append(text)
                    self.phase("submit", "bad", f"没抢到：{text}")
                    break
                # 只有明确「被别人订走」才立即换已备好的候选；其他失败可能其实已订上，走原来的重载核对路径。
                if queue and outcome == "taken":
                    b.page, room = queue.pop(0)
                    self.log(f"立即提交已备好的下一间：{room}")
                    self.phase("submit", "run", f"首选没抢到，立即提交已备好的 {room}")
                    continue
                self.phase("submit", "run", "首选没抢到，重新打开页面换下一间…")
                nxt = b.prepare(date_slash, exclude=tried, retry=True)
                if nxt is None:
                    status, note = b.selection_failure()
                    res.update(status=status, room=None)
                    notes.append(note)
                    self.phase("submit", "bad", note)
                    break
                room = nxt
            res["note"] = "；".join(notes)
            return self._finish(res, td)
        except StopRequested:
            res.update(status="取消", note="手动停止")
            self.phase("submit", "skip", "已停止")
            return self._finish(res, td)
        except LoginRequired as e:
            self.login_ok = False
            res.update(status="错误", note=f"登录失效：{e}")
            self.phase("prepare", "bad", f"登录失效：{e}")
            return self._finish(res, td)
        except Exception as e:
            b.shot("error")
            res.update(status="错误", note=_short(e))
            self.log(f"抢订出错：{_short(e)}", "bad")
            self.phase("prepare", "bad", f"出错：{_short(e)}")
            return self._finish(res, td)
        finally:
            b.close()

    def backup_count(self):
        """开抢前在其他标签页预先备好的候选间数（首选之外），默认 2，0 表示关闭。"""
        n = self.cfg["抢订设置"].get("预备候选间数", 2)
        return n if type(n) is int and 0 <= n <= 3 else 2

    def lead_seconds(self):
        """开始填表的提前量：每多备一间约多花 25–35 秒，保证首选永远先备好。"""
        lead = int(self.cfg["抢订设置"]["提前填表秒数"])
        extra = max(0, min(self.backup_count(), len(self.cfg["优先会议室"]) - 1))
        return max(lead, 60 + 35 * extra)

    def _arm_backups(self, b, date_slash, first, open_at, test):
        armed, used = [], [first]
        for _ in range(self.backup_count()):
            deadline = None
            if not test:
                left = (open_at - self.clock.now()).total_seconds() if open_at else 0
                if left < 40:
                    self.log("离开放时刻不足 40 秒，不再预备更多候选，首选照常提交")
                    break
                deadline = time.time() + left - 5  # 开放前 5 秒必须收手
            try:
                got = b.arm_backup(date_slash, used, deadline)
            except StopRequested:
                raise
            except Exception as e:  # 含候选页登录异常、超时：只放弃候选，首选照常提交
                self.log(f"预备候选没做成（{_short(e)}），不影响首选", "warn")
                break
            if not got:
                break
            armed.append(got)
            used.append(got[1])
        return armed

    def _finish(self, res, td):
        C.add_history(res["date"], td, res["status"], res["room"], res.get("note", ""))
        level = "ok" if res["status"] in ("成功", "测试") else "bad"
        self.log(f"结果：{res['status']}  {res['room'] or ''}  {res.get('note', '')}", level)
        return res

    # ---------- 三种模式 ----------
    def run_once(self, test=False):
        now = self.clock.now()
        open_today = self.open_time_on(now.date())
        target = now.date() + timedelta(weeks=1)
        open_at = open_today if (now < open_today and not test) else None
        if open_at:
            self.log(f"立即抢一次：现在开始准备，到 {open_at:%H:%M:%S} 再提交")
        return self.grab(open_at, target, test=test)

    def run_daemon(self, on_result=None, on_login_bad=None, on_schedule=None):
        s = self.cfg["抢订设置"]
        while not self.stop.is_set():
            open_at = self.next_open()
            target = open_at.date() + timedelta(weeks=1)
            pre_min = int(s.get("登录预检提前分钟", 15) or 0)
            precheck_at = open_at - timedelta(minutes=pre_min)
            prepare_at = open_at - timedelta(seconds=self.lead_seconds())
            weekday_ok = target.isoweekday() in self.cfg.get("抢订日", list(range(1, 8)))
            dup = C.already_booked(target.strftime("%Y-%m-%d"), self.cfg)
            if on_schedule:
                on_schedule(open_at, target, weekday_ok and not dup)
            if not weekday_ok or dup:
                why = "该星期不在抢订日里" if not weekday_ok else "这一天同一时段已经抢到过"
                self.log(f"{target:%m/%d} 跳过：{why}")
                for k in ("precheck", "prepare", "submit"):
                    self.phase(k, "skip", why)
                if not wait_until(self.clock, open_at + timedelta(minutes=2), self.stop):
                    break
                continue
            self.log(f"下一次：{open_at:%m/%d %H:%M:%S} 开放，抢 {target:%m/%d} 的会议室")
            self.phase("precheck", "wait", f"{precheck_at:%H:%M} 检查登录" if pre_min else "未开启")
            self.phase("prepare", "wait", f"{prepare_at:%H:%M:%S} 开始填表")
            self.phase("submit", "wait", f"{open_at:%H:%M:%S} 提交")
            if pre_min and self.clock.now() < prepare_at - timedelta(seconds=60):
                if not wait_until(self.clock, precheck_at, self.stop):
                    break
                try:
                    if not self.precheck() and on_login_bad:
                        on_login_bad()
                except StopRequested:
                    break
            if not wait_until(self.clock, prepare_at, self.stop):
                break
            late = (self.clock.now() - open_at).total_seconds()
            if late > 60:
                self.log(f"已经比开放时刻晚了 {late / 60:.0f} 分钟（电脑可能睡眠过），照样去试", "warn")
            res = self.grab(open_at, target)
            if on_result:
                on_result(res)
            if not wait_until(self.clock, max(open_at, self.clock.now()) + timedelta(minutes=2), self.stop):
                break
        self.log("守护已停止")

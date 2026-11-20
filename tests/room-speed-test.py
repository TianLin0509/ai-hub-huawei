"""2026-11-20 抢订提速的源码回归：等列表、被占即换、预备候选、开抢提前量、防一人两间。

只用标准库；其余模块来自已签名的 2.1.3 包，engine/jobs 用当前源码。
"""
import copy
import importlib.util
from datetime import datetime, timedelta
from pathlib import Path
import sys
import threading
import unittest

BUNDLE = Path(__file__).resolve().parents[1] / 'core/company-assistant/room-component'
sys.path.insert(0, str(BUNDLE / 'msz-code-2.1.3.zip'))
from msz import config as C  # noqa: E402


def source_module(name):
    spec = importlib.util.spec_from_file_location('msz.' + name, BUNDLE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


engine = source_module('engine')
jobs = source_module('jobs')
ROOMS = ['测试楼A-1R', '测试楼A-2R', '测试楼A-3R', '测试楼A-4R']


class FakeClock:
    measured_at = datetime.now()

    def now(self):
        return datetime.now()


def booker(cfg=None):
    b = engine.Booker.__new__(engine.Booker)
    b.cfg = cfg or base_cfg()
    b.warnings, b.logs, b.factor = [], [], 1.0
    b.log = lambda text, level='info': b.logs.append(text)
    b.stop = threading.Event()
    b.clock = FakeClock()
    b.shot = lambda name: None
    return b


def base_cfg():
    cfg = copy.deepcopy(C.DEFAULTS)
    cfg['优先会议室'] = list(ROOMS)
    cfg['抢订设置']['校准服务器时间'] = False
    return cfg


class SubmitPage:
    """按脚本依次给出每次点击后的结果：'ok' / 'taken' / 'silent'。"""

    def __init__(self, script):
        self.script, self.clicks = list(script), 0
        self.current = 'silent'

    def evaluate(self, js, arg=None):
        if js == engine.JS_VISIBLE_TEXTS:
            return []
        if js == engine.JS_CLICK_BOOK:
            self.clicks += 1
            self.current = self.script.pop(0) if self.script else 'silent'
            return True
        if js == engine.JS_RESULT:
            return {'ok': {'s': 'success', 'm': '预定成功'},
                    'taken': {'s': 'error', 'm': '会议室已被预定，请重新选择'}}.get(self.current, {'s': 'unknown'})
        if js == engine.JS_HAS_BOOK_BUTTON:
            return True
        raise AssertionError(js)


class SubmitTests(unittest.TestCase):
    def test_taken_switches_after_one_click(self):
        b = booker()
        b.page = SubmitPage(['taken'])
        self.assertEqual(b.submit(None, 5, 50, 't')[0], 'taken')
        self.assertEqual(b.page.clicks, 1, '被占后不再对同一间连点')

    def test_silent_then_taken_is_not_switched(self):
        b = booker()
        b.page = SubmitPage(['silent', 'taken'])
        outcome, text = b.submit(None, 5, 50, 't')
        self.assertEqual(outcome, 'unknown')
        self.assertIn('可能已是自己订上', text)

    def test_success_returns_quickly(self):
        b = booker()
        b.page = SubmitPage(['ok'])
        t0 = datetime.now()
        self.assertEqual(b.submit(None, 5, 50, 't')[0], 'success')
        self.assertLess((datetime.now() - t0).total_seconds(), 0.3, '结果出来就返回，不固定等 0.5 秒')


class ListPage:
    def __init__(self, appear_after):
        self.calls, self.appear_after, self.nudged = 0, appear_after, 0

    def evaluate(self, js, arg=None):
        if js == engine.JS_ROOM_Y:
            self.calls += 1
            return 100 if self.appear_after is not None and self.calls > self.appear_after else None
        if js == engine.JS_CLICK_DATE_TAB:
            self.nudged += 1
            return True
        raise AssertionError(js)


class RoomListWaitTests(unittest.TestCase):
    def test_waits_until_rows_appear(self):
        b = booker()
        b.page = ListPage(appear_after=len(ROOMS) * 3)
        waited = b.wait_room_list('2026/11/27', timeout=5)
        self.assertIsNotNone(waited)
        self.assertGreater(waited, 0.5)

    def test_times_out_with_warning_and_one_nudge(self):
        b = booker()
        b.page = ListPage(appear_after=None)
        self.assertIsNone(b.wait_room_list('2026/11/27', timeout=1))
        self.assertEqual(b.page.nudged, 1)
        self.assertTrue(any('仍没出现' in w for w in b.warnings))


class ArmedRunnerTests(unittest.TestCase):
    def run_grab(self, outcomes, backups=2, rooms=ROOMS, arm_error=None):
        cfg = base_cfg()
        cfg['优先会议室'] = list(rooms)
        cfg['抢订设置']['预备候选间数'] = backups
        logs, history = [], []
        calls = {'prepare': [], 'arm': [], 'submit': []}
        outcome_iter = iter(outcomes)

        class FakeBooker:
            def __init__(self, *a):
                self.page, self.warnings = 'page-0', []

            def launch(self):
                pass

            def close(self):
                pass

            def shot(self, name):
                pass

            def prepare(self, date_slash, exclude=(), retry=False):
                calls['prepare'].append((tuple(exclude), retry))
                free = [r for r in cfg['优先会议室'] if r not in exclude]
                return free[0] if free else None

            def arm_backup(self, date_slash, used, deadline=None):
                calls['arm'].append(tuple(used))
                calls.setdefault('deadline', []).append(deadline)
                if arm_error:
                    raise arm_error
                free = [r for r in cfg['优先会议室'] if r not in used]
                return ('page-%d' % len(used), free[0]) if free else None

            def submit(self, open_at, *a):
                calls['submit'].append(self.page)
                return next(outcome_iter)

            def selection_failure(self):
                return '满员', '优先列表全部被占'

        original_booker, original_hist = jobs.Booker, C.add_history
        jobs.Booker = FakeBooker
        jobs.C.add_history = lambda *a, **k: history.append(a)
        try:
            r = jobs.Runner(cfg, lambda m, l='info': logs.append(m), lambda *a: None, threading.Event(), FakeClock())
            res = r.grab(datetime.now() + timedelta(seconds=120), datetime.now().date() + timedelta(days=7))
        finally:
            jobs.Booker, jobs.C.add_history = original_booker, original_hist
        return res, calls, logs, r

    def test_primary_taken_uses_armed_backup_without_reload(self):
        res, calls, logs, _ = self.run_grab([('taken', '已被预定'), ('success', '预定成功')])
        self.assertEqual(res['status'], '成功')
        self.assertEqual(res['room'], ROOMS[1])
        self.assertEqual(calls['submit'], ['page-0', 'page-1'])
        self.assertEqual([retry for _, retry in calls['prepare']], [False], '换房没有重载页面')

    def test_all_armed_taken_falls_back_to_reload(self):
        res, calls, _, _ = self.run_grab([('taken', 'x')] * 3 + [('success', 'ok')])
        self.assertEqual(res['room'], ROOMS[3])
        self.assertEqual(calls['prepare'][-1], (tuple(ROOMS[:3]), True))

    def test_backups_disabled_keeps_old_path(self):
        res, calls, _, _ = self.run_grab([('taken', 'x'), ('success', 'ok')], backups=0)
        self.assertEqual(calls['arm'], [])
        self.assertEqual(res['room'], ROOMS[1])
        self.assertTrue(calls['prepare'][-1][1], '没有候选时照旧重载换房')

    def test_backup_prepare_has_deadline_before_open(self):
        _, calls, _, _ = self.run_grab([('success', 'ok')])
        import time
        self.assertTrue(all(d is not None and d < time.time() + 120 - 4 for d in calls['deadline']))

    def test_backup_login_error_keeps_primary(self):
        res, calls, _, _ = self.run_grab([('success', 'ok')], arm_error=engine.LoginRequired('候选页停在登录页'))
        self.assertEqual(res['status'], '成功')
        self.assertEqual(res['room'], ROOMS[0])

    def test_non_taken_failure_does_not_jump_to_backup(self):
        res, calls, _, _ = self.run_grab([('fail', '网络错误'), ('success', 'ok')])
        self.assertEqual(calls['submit'], ['page-0', 'page-0'], '非被占失败不换已备候选，防一人两间')
        self.assertTrue(calls['prepare'][-1][1])

    def test_lead_covers_backups_but_never_below_user_setting(self):
        r = jobs.Runner(base_cfg(), print, print, threading.Event(), FakeClock())
        self.assertEqual(r.lead_seconds(), 130)
        r.cfg['优先会议室'] = ROOMS[:1]
        self.assertEqual(r.lead_seconds(), 60)
        r.cfg['抢订设置']['提前填表秒数'] = 200
        self.assertEqual(r.lead_seconds(), 200)


if __name__ == '__main__':
    unittest.main()

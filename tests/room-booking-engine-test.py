"""Booking source regressions. Other modules come from the shipped signed package.

Run with Python 3, no third-party packages or company network required.
Source overrides are test-only; Hub continues to require a signed component.
"""
import copy
import importlib.util
import json
from datetime import date, datetime, timedelta
from pathlib import Path
import sys
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

BUNDLE = Path(__file__).resolve().parents[1] / 'core/company-assistant/room-component'
sys.path.insert(0, str(BUNDLE / 'msz-code-2.1.3.zip'))
from msz import config as C

def source_module(name):
    spec = importlib.util.spec_from_file_location('msz.' + name, BUNDLE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

engine = source_module('engine')
jobs = source_module('jobs')
ROOMS = ['测试楼B11-3-10R', '测试楼B11-3-09R']

class BookingTests(unittest.TestCase):
    def rig(self, rounds):
        cfg = copy.deepcopy(C.DEFAULTS)
        cfg.update({'优先会议室': ROOMS, '开始时间': '09:00', '时长小时': 1, '时长分钟': 0})
        cfg['高级']['自动标定网格'] = False
        cfg['抢订设置']['校准服务器时间'] = False
        logs, phases = [], []
        b = engine.Booker.__new__(engine.Booker)
        b.cfg, b.calibrated, b.warnings = cfg, False, []
        b.grid_x0, b.cell_w, b.grid_start_h = 472, 30, 8.5
        b.log = lambda text, level='info': logs.append(text)
        class Page:
            round = -1
            navigations = 0
            reloads = 0
            def goto(self, *args, **kwargs):
                self.round += 1
                self.navigations += 1
            def reload(self, **kwargs):
                self.round += 1
                self.reloads += 1
            form_date = None
            def evaluate(self, script, arg=None):
                if script == getattr(engine, 'JS_FORM_DATE', None):
                    return self.form_date
                if script == engine.JS_ROOM_Y:
                    self.state = rounds[self.round][ROOMS.index(arg)]
                    return None if self.state == 'missing' else 100
                if script == engine.JS_CELL_CLASSES:
                    return [None if self.state == 'nogrid' else ('order' if self.state == 'taken' else 'free') for _ in arg[0]]
                if script == engine.JS_ROW_CELLS:
                    return {'xs': [472 + 30*i for i in range(24)], 'ws': [30]*24, 'vis': [True]*24}
                if script == getattr(engine, 'JS_ROOM_DIAGNOSTICS', None):
                    return {'readyState': 'complete', 'formDate': '2026/11/20', 'leafMatches': 0,
                            'activeRoomTab': '全部会议室', 'url': 'https://private.invalid/?token=DO_NOT_LOG'}
                raise AssertionError('unexpected page operation')
        b.page = Page()
        b.launch = b.close = lambda: None
        b.url, b.factor = 'https://example.invalid/#/', 1
        b.wait_for_form = lambda **kwargs: (True, '')
        b.sleep = lambda *args: None
        b.fill_form = b.open_room_dialog = b.pick_cells = b.shot = lambda *args: None
        b.check_form_time = lambda *args: ''
        b.submit = lambda *args: ('taken', '该时段冲突')
        runner = jobs.Runner(cfg, b.log, lambda *args: phases.append(args), threading.Event())
        return b, runner, logs, phases

    def run_booking(self, rounds, test=True):
        b, runner, logs, phases = self.rig(rounds)
        with patch.object(jobs, 'Booker', return_value=b), patch.object(C, 'add_history'):
            result = runner.grab(None, date(2026, 11, 20), test=test)
        return result, logs, phases

    def test_detection_failures_are_not_full(self):
        for states in [('missing', 'missing'), ('nogrid', 'nogrid'), ('taken', 'missing'), ('taken', 'nogrid')]:
            with self.subTest(states=states):
                result, logs, _ = self.run_booking([states])
                self.assertEqual(result['status'], '错误')
                self.assertNotIn('全部被占', result['note'])
                self.assertIn('识别', result['note'])
                self.assertNotIn('DO_NOT_LOG', '\n'.join(logs))

    def test_actual_full_remains_full(self):
        result, _, _ = self.run_booking([('taken', 'taken')])
        self.assertEqual((result['status'], result['note']), ('满员', '优先列表全部被占'))

    def test_free_alternative_keeps_priority_order(self):
        result, _, _ = self.run_booking([('taken', 'free')])
        self.assertEqual((result['status'], result['room']), ('测试', ROOMS[1]))

    def test_default_calibration_and_successful_booking_remain_unchanged(self):
        b, runner, logs, _ = self.rig([('free', 'free')])
        b.cfg['高级']['自动标定网格'] = C.DEFAULTS['高级']['自动标定网格']
        b.submit = lambda *args: ('success', '预定成功')
        with patch.object(jobs, 'Booker', return_value=b), patch.object(C, 'add_history'):
            result = runner.grab(None, date(2026, 11, 20), test=False)
        self.assertEqual((result['status'], result['room']), ('成功', ROOMS[0]))
        self.assertTrue(b.calibrated)
        self.assertFalse(any('[会议室诊断]' in line for line in logs))

    def test_retry_failure_is_not_full(self):
        result, _, _ = self.run_booking([('free', 'free'), ('taken', 'missing')], test=False)
        self.assertEqual(result['status'], '错误')
        self.assertNotIn('都被占', result['note'])

    def test_retry_confirmed_taken_still_full(self):
        result, _, _ = self.run_booking([('free', 'free'), ('taken', 'taken')], test=False)
        self.assertEqual(result['status'], '满员')

    def test_retry_reloads_and_books_next_room_with_combined_changes(self):
        b, runner, _, _ = self.rig([('free', 'free'), ('taken', 'free')])
        outcomes = iter([('taken', '该时段已被预订'), ('success', '预定成功')])
        b.submit = lambda *args: next(outcomes)
        with patch.object(jobs, 'Booker', return_value=b), patch.object(C, 'add_history'):
            result = runner.grab(None, date(2026, 11, 20), test=False)
        self.assertEqual((result['status'], result['room']), ('成功', ROOMS[1]))
        self.assertEqual((b.page.navigations, b.page.reloads), (1, 1))

    def test_site_advance_days_still_reach_the_combined_runner(self):
        # Only the adapter's scheduling logic runs here, not Qt GUI behavior.
        qt_modules = {}
        try:
            import PyQt5
        except ImportError:
            qt = ModuleType('PyQt5')
            qt.QtCore = ModuleType('PyQt5.QtCore')
            qt.QtCore.QTimer = Mock()
            qt_modules = {'PyQt5': qt, 'PyQt5.QtCore': qt.QtCore}
        with patch.dict(sys.modules, qt_modules):
            adapter = source_module('hub_control')
            for days in (7, 3, 120):
                with self.subTest(days=days), patch.object(jobs, 'timedelta', timedelta):
                    b, runner, _, _ = self.rig([('free', 'free')])
                    if days != 7:
                        b.cfg['抢订设置']['提前天数'] = days
                    adapter.install_advance_days(SimpleNamespace(cfg=b.cfg))
                    runner.clock = SimpleNamespace(now=lambda: datetime(2026, 11, 16, 15))
                    runner.grab = Mock()
                    runner.run_once(test=True)
                    self.assertEqual(runner.grab.call_args.args[1], date(2026, 11, 16) + timedelta(days=days))

    def test_target_date_120_days_ahead_crosses_months_and_year(self):
        qt_modules = {}
        try:
            import PyQt5
        except ImportError:
            qt = ModuleType('PyQt5')
            qt.QtCore = ModuleType('PyQt5.QtCore')
            qt.QtCore.QTimer = Mock()
            qt_modules = {'PyQt5': qt, 'PyQt5.QtCore': qt.QtCore}
        with patch.dict(sys.modules, qt_modules), patch.object(jobs, 'timedelta', timedelta):
            adapter = source_module('hub_control')
            b, runner, _, _ = self.rig([('free', 'free')])
            b.cfg['抢订设置']['提前天数'] = 120
            adapter.install_advance_days(SimpleNamespace(cfg=b.cfg))
            runner.clock = SimpleNamespace(now=lambda: datetime(2026, 11, 28, 15))
            runner.grab = Mock()
            runner.run_once(test=True)
            self.assertEqual(runner.grab.call_args.args[1], date(2027, 3, 28))

    def test_form_date_rejected_by_site_stops_before_submit(self):
        b, runner, logs, _ = self.rig([('free', 'free')])
        b.page.form_date = '2026/11/21'
        submitted = []
        b.submit = lambda *args: submitted.append(args) or ('success', '预定成功')
        with patch.object(jobs, 'Booker', return_value=b), patch.object(C, 'add_history'):
            result = runner.grab(None, date(2026, 11, 20), test=False)
        self.assertEqual(result['status'], '错误')
        self.assertIn('没有接受目标日期 2026/11/20', result['note'])
        self.assertIn('提前天数', result['note'])
        self.assertEqual(submitted, [])

    def test_form_date_matching_or_unreadable_still_books(self):
        for shown in ('2026/11/20', '2026-11-20', '2026/11/20 周五', None, '', '明天'):
            with self.subTest(shown=shown):
                b, runner, _, _ = self.rig([('free', 'free')])
                b.page.form_date = shown
                b.submit = lambda *args: ('success', '预定成功')
                with patch.object(jobs, 'Booker', return_value=b), patch.object(C, 'add_history'):
                    result = runner.grab(None, date(2026, 11, 20), test=False)
                self.assertEqual((result['status'], result['room']), ('成功', ROOMS[0]))

    def test_diagnostic_is_bounded_and_preserves_missing_reason(self):
        result, logs, _ = self.run_booking([('missing', 'taken')])
        diagnostics = [line for line in logs if line.startswith('[会议室诊断] ')]
        self.assertEqual(len(diagnostics), 1)
        data = json.loads(diagnostics[0].split(' ', 1)[1])
        self.assertEqual(data['reason'], 'missing')
        self.assertEqual(data['expectedDate'], '2026/11/20')
        self.assertEqual(data['formDate'], '2026/11/20')
        self.assertNotIn('url', data)
        self.assertLess(len(diagnostics[0]), 2048)
        self.assertIn('弹窗里没找到这间', '\n'.join(logs))

    def test_diagnostic_failure_does_not_replace_primary_error(self):
        b, runner, logs, _ = self.rig([('nogrid', 'taken')])
        evaluate = b.page.evaluate
        def failing_probe(script, arg):
            if script == getattr(engine, 'JS_ROOM_DIAGNOSTICS', None):
                raise RuntimeError('secret page content DO_NOT_LOG')
            return evaluate(script, arg)
        b.page.evaluate = failing_probe
        with patch.object(jobs, 'Booker', return_value=b), patch.object(C, 'add_history'):
            result = runner.grab(None, date(2026, 11, 20), test=True)
        self.assertEqual(result['status'], '错误')
        self.assertIn('时段格子', result['note'])
        self.assertNotIn('DO_NOT_LOG', '\n'.join(logs))


class RoomListTests(unittest.TestCase):
    def rig(self, *, height=280, row_height=28, count=23, delay=0, stuck=False, initial=0):
        state = {'time': 0.0, 'top': initial, 'old_top': initial, 'changed_at': -100, 'moves': []}
        names = [f'测试楼-R{i:02d}' for i in range(count)]
        b = engine.Booker.__new__(engine.Booker)
        b.stop = threading.Event()
        b.log = lambda *args: None
        b.sleep_real = lambda seconds: state.update(time=state['time'] + seconds)
        def evaluate(script, action):
            self.assertEqual(script, engine.JS_ROOM_SCROLL)
            if action in ('reset', 'next'):
                state['old_top'] = state['top']
                state['top'] = 0 if action == 'reset' else min(count * row_height - height, state['top'] + int(height * .8))
                state['top'] = max(0, state['top'])
                if stuck and action == 'next':
                    state['top'] = state['old_top']
                state['changed_at'] = state['time']
                state['moves'].append(state['top'])
            painted_top = state['old_top'] if state['time'] - state['changed_at'] < delay else state['top']
            visible = [n for i, n in enumerate(names) if painted_top <= (i + .5) * row_height < painted_top + height]
            return {'names': visible, 'busy': False, 'scroll': {'top': state['top'], 'height': height,
                    'scrollHeight': count * row_height, 'viewHeight': height, 'rowHeight': row_height}}
        b.page = SimpleNamespace(evaluate=evaluate)
        return b, state, names

    def test_short_viewport_does_not_skip_three_middle_rooms(self):
        b, state, names = self.rig()
        with patch.object(engine.time, 'monotonic', side_effect=lambda: state['time']):
            self.assertEqual(b.list_rooms(), names)
        self.assertTrue(any(0 < top < 364 for top in state['moves']))

    def test_different_heights_and_starting_scroll_positions(self):
        for height in (84, 196, 560, 900):
            with self.subTest(height=height):
                b, state, names = self.rig(height=height, initial=max(0, 644-height))
                with patch.object(engine.time, 'monotonic', side_effect=lambda: state['time']):
                    self.assertEqual(b.list_rooms(), names)

    def test_delayed_virtual_rows_are_read_before_advancing(self):
        b, state, names = self.rig(delay=1.6)
        with patch.object(engine.time, 'monotonic', side_effect=lambda: state['time']):
            self.assertEqual(b.list_rooms(), names)

    def test_stalled_scroll_is_error_not_partial_success(self):
        b, state, _ = self.rig(stuck=True)
        with patch.object(engine.time, 'monotonic', side_effect=lambda: state['time']):
            with self.assertRaisesRegex(RuntimeError, '读取未完成'):
                b.list_rooms()

    def test_clipped_or_unknown_owner_is_not_partial_success(self):
        for kind in ('clipped', 'blocked', 'unknown'):
            with self.subTest(kind=kind):
                b, state, _ = self.rig()
                evaluate = b.page.evaluate
                def incomplete(script, action):
                    snapshot = evaluate(script, action)
                    if kind == 'unknown':
                        snapshot['scroll'] = None
                    elif kind == 'blocked':
                        snapshot['scroll']['blocked'] = True
                    else:
                        snapshot['scroll']['viewHeight'] = 140
                    return snapshot
                b.page.evaluate = incomplete
                with patch.object(engine.time, 'monotonic', side_effect=lambda: state['time']):
                    with self.assertRaisesRegex(RuntimeError, '读取未完成'):
                        b.list_rooms()

    def test_empty_loading_page_times_out_and_can_be_cancelled(self):
        b, state, _ = self.rig()
        b.page.evaluate = lambda *args: {'names': [], 'busy': True, 'scroll': None}
        with patch.object(engine.time, 'monotonic', side_effect=lambda: state['time']):
            with self.assertRaisesRegex(RuntimeError, '读取未完成'):
                b.list_rooms()
        self.assertLess(state['time'], 31)
        b.stop.set()
        with self.assertRaises(engine.StopRequested):
            b.list_rooms()

if __name__ == '__main__':
    unittest.main()

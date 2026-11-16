"""Behavioral regression checks against the shipped signed room package."""
import copy
from datetime import datetime, timedelta
import errno
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

try:
    import PyQt5
except ImportError:
    qt = ModuleType('PyQt5')
    qt.QtCore = ModuleType('PyQt5.QtCore')
    qt.QtCore.QTimer = Mock()
    sys.modules['PyQt5'] = qt
    sys.modules['PyQt5.QtCore'] = qt.QtCore
root = Path(__file__).resolve().parents[1] / 'core/company-assistant/room-component'
sys.path.insert(0, str(root / 'msz-code-2.1.3.zip'))
from msz import config as C, engine, jobs
from msz.hub_control import HubControl


class NextRoomTests(unittest.TestCase):
    def booker(self):
        b = engine.Booker.__new__(engine.Booker)
        b.page, b.wait_for_form, b.sleep = Mock(), Mock(return_value=(True, '')), Mock()
        b.url, b.factor, b.calibrated = 'http://localhost/meetingroom/#/', 1, True
        return b

    def test_initial_navigation_preserves_original_eight_second_floor(self):
        b = self.booker()
        with patch('msz.engine.time.time', side_effect=[100, 102]):
            b.open_page()
        b.page.goto.assert_called_once_with(b.url, wait_until='domcontentloaded', timeout=60000)
        b.page.reload.assert_not_called()
        b.wait_for_form.assert_called_once_with()
        b.sleep.assert_called_once_with(6)

    def test_retry_reloads_document_waits_for_new_form_and_resets_grid(self):
        b = self.booker()
        b.open_page(retry=True)
        b.page.reload.assert_called_once_with(wait_until='domcontentloaded', timeout=15000)
        b.page.goto.assert_not_called()
        b.wait_for_form.assert_called_once_with(timeout=15)
        b.sleep.assert_not_called()
        self.assertFalse(b.calibrated)

    def test_failed_reload_does_not_continue_filling_or_submitting(self):
        b = self.booker()
        b.page.reload.side_effect = TimeoutError('reload timeout')
        with self.assertRaises(TimeoutError):
            b.open_page(retry=True)
        b.wait_for_form.assert_not_called()

    def run_grab(self, outcomes, rooms=('R1', 'R2'), enabled=True, test=False):
        cfg = copy.deepcopy(C.DEFAULTS)
        cfg['抢订设置']['抢不到换下一间'] = enabled
        now = datetime(2026, 11, 16, 11, 59, 59)
        clock = SimpleNamespace(now=lambda: now, measured_at=now)
        runner = jobs.Runner(cfg, Mock(), Mock(), threading.Event(), clock)
        b = Mock(warnings=[])
        b.prepare.side_effect = list(rooms)
        b.submit.side_effect = outcomes
        opened = now + timedelta(seconds=1)
        with patch('msz.jobs.Booker', return_value=b), patch('msz.config.add_history'):
            result = runner.grab(opened, now.date() + timedelta(days=7), test=test)
        return b, result, opened

    def test_first_choice_success_keeps_original_submit_schedule(self):
        b, result, opened = self.run_grab([('success', '成功')])
        self.assertEqual(result['status'], '成功')
        self.assertEqual(b.prepare.call_args_list[0].args, ('2026/11/23',))
        self.assertEqual(b.prepare.call_args_list[0].kwargs, {})
        self.assertEqual(b.prepare.call_count, 1)
        self.assertIs(b.submit.call_args.args[0], opened)
        b.close.assert_called_once()

    def test_only_failed_round_requests_reload_and_excludes_taken_room(self):
        b, result, opened = self.run_grab([('taken', '已被预订'), ('success', '成功')])
        self.assertEqual((result['status'], result['room']), ('成功', 'R2'))
        self.assertEqual(b.prepare.call_args.kwargs, {'exclude': ['R1'], 'retry': True})
        self.assertIs(b.submit.call_args_list[0].args[0], opened)
        self.assertIsNone(b.submit.call_args_list[1].args[0])

    def test_unknown_result_does_not_risk_duplicate_booking(self):
        b, result, _ = self.run_grab([('unknown', '待确认')])
        self.assertEqual(result['status'], '待核验')
        self.assertEqual(b.prepare.call_count, 1)

    def test_disabled_fallback_and_test_mode_never_reopen(self):
        b, result, _ = self.run_grab([('taken', '已被预订')], enabled=False)
        self.assertEqual(result['status'], '失败')
        self.assertEqual(b.prepare.call_count, 1)
        b, result, _ = self.run_grab([], test=True)
        self.assertEqual(result['status'], '测试')
        b.submit.assert_not_called()

    def test_no_available_backup_stops_without_another_submit(self):
        b, result, _ = self.run_grab([('taken', '已被预订')], rooms=('R1', None))
        self.assertEqual(result['status'], '满员')
        self.assertEqual(b.submit.call_count, 1)


class StatusWriteTests(unittest.TestCase):
    def test_access_denied_is_retried_and_complete_json_replaces_old_file(self):
        c = HubControl.__new__(HubControl)
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'status.json'
            file.write_text('{"old":true}', encoding='utf-8')
            from msz.hub_control import os
            replace = os.replace
            for code in (errno.EACCES, errno.EPERM):
                with patch('msz.hub_control.os.replace', side_effect=[OSError(code, 'busy'), OSError(code, 'busy'), None]) as rename, patch('msz.hub_control.time.sleep') as sleep:
                    # Final side effect really replaces the file, as on Windows.
                    def attempt(src, dst):
                        if rename.call_count < 3:
                            raise OSError(code, 'busy')
                        return replace(src, dst)
                    rename.side_effect = attempt
                    c.write(file, {'state': 'ready'})
                self.assertEqual(json.loads(file.read_text(encoding='utf-8')), {'state': 'ready'})
                self.assertEqual(sleep.call_count, 2)

    def test_retry_budget_is_bounded_and_other_errors_surface_immediately(self):
        c = HubControl.__new__(HubControl)
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'status.json'
            file.write_text('{"old":true}', encoding='utf-8')
            for code, calls in ((errno.EACCES, 5), (errno.EPERM, 5), (errno.ENOSPC, 1)):
                with patch('msz.hub_control.os.replace', side_effect=OSError(code, 'unavailable')) as rename, patch('msz.hub_control.time.sleep'), self.assertRaises(OSError):
                    c.write(file, {'state': 'ready'})
                self.assertEqual(rename.call_count, calls)
                self.assertEqual(json.loads(file.read_text(encoding='utf-8')), {'old': True})


if __name__ == '__main__':
    unittest.main()

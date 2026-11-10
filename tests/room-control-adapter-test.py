"""Behavioral tests against the signed Python package shipped by Hub."""
import copy
import queue
from datetime import datetime, timedelta
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'core/company-assistant/room-component/msz-code-2.1.2.zip'))
from msz import config as C
from msz.hub_control import HubControl, validate_patch


class AdapterTests(unittest.TestCase):
    def control(self, busy=False):
        w = SimpleNamespace(cfg=copy.deepcopy(C.DEFAULTS), _busy=lambda: busy,
                            btn_login=SimpleNamespace(isEnabled=lambda: True),
                            _load_into_ui=lambda: None, refresh_all=lambda: None)
        c = HubControl.__new__(HubControl)
        c.w, c.work, c.status = w, None, lambda: {'ok': True}
        return c, w

    def test_preserve_engine_fields_and_merge_preferences(self):
        c, w = self.control()
        w.cfg['高级']['无界面'] = True
        w.cfg['高级']['等待倍率'] = 0.35
        with patch('msz.config.save_config') as save:
            c.invoke('configure', {'抢订设置': {'最大重试次数': 6}, '系统': {'守护时阻止睡眠': False}})
        self.assertEqual(w.cfg['抢订设置']['开放时间'], '12:00:00')
        self.assertEqual(w.cfg['抢订设置']['最大重试次数'], 6)
        self.assertEqual(w.cfg['高级']['等待倍率'], 0.35)
        self.assertTrue(w.cfg['高级']['无界面'])
        save.assert_called_once()

    def test_invalid_fields_and_ranges(self):
        for values in [{'高级': {'无界面': False}}, {'系统': {'开机自动启动守护': True}},
                       {'抢订设置': {'最大重试次数': 31}}, {'抢订设置': {'最大重试次数': True}},
                       {'抢订设置': {'开放时间': '24:00:00'}}, {'高级': {'网址': 'file:///a'}},
                       {'会后动作': {'模式': 'unknown'}}, {'会后动作': {'提醒提前分钟': 0}},
                       {'系统': {'守护时阻止睡眠': 1}}, {'高级': []}]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate_patch(values)

    def test_empty_room_plan_can_be_saved_but_cannot_start_once(self):
        c, w = self.control()
        with patch('msz.config.save_config'):
            c.invoke('configure', {'优先会议室': [], '高级': {'浏览器': 'Edge'}})
        self.assertEqual(w.cfg['高级']['浏览器'], 'Edge')
        with self.assertRaisesRegex(ValueError, '优先会议室'):
            c.invoke('once', {})

    def test_busy_configuration_is_unchanged(self):
        c, w = self.control(True)
        before = copy.deepcopy(w.cfg)
        with patch('msz.config.save_config') as save, self.assertRaisesRegex(ValueError, '停止'):
            c.invoke('configure', {'主题': 'new'})
        self.assertEqual(w.cfg, before)
        save.assert_not_called()

    def test_failed_save_does_not_change_live_config(self):
        c, w = self.control()
        before = copy.deepcopy(w.cfg)
        with patch('msz.config.save_config', side_effect=OSError('disk full')), self.assertRaises(OSError):
            c.invoke('configure', {'主题': 'new'})
        self.assertEqual(w.cfg, before)

    def test_cross_day_and_missing_cli_are_not_saved(self):
        for fields in [{'开始时间': '23:30', '时长小时': 1}, {'会后动作': {'模式': '通知模式', '小鲁班ID': 'fixture'}}]:
            c, w = self.control()
            with patch('msz.welink.find_cli', return_value=None), patch('msz.config.save_config') as save, self.assertRaises(ValueError):
                c.invoke('configure', fields)
            save.assert_not_called()

    def test_once_uses_original_once_job_and_reads_do_not_allow_config_race(self):
        c, w = self.control(); w.cfg['优先会议室'] = ['fixture']
        calls = []; w.start_job = calls.append
        c.invoke('once', {})
        self.assertEqual(calls, ['once'])
        c.work = 'read-rooms'
        with self.assertRaises(ValueError):
            c.invoke('configure', {'主题': 'new'})

    def test_post_actions_require_valid_cli_and_receiver(self):
        c, w = self.control()
        with patch('msz.welink.find_cli', return_value='fixture-cli'), patch('msz.config.save_config') as save:
            c.invoke('configure', {'会后动作': {'模式': '通知模式', '小鲁班ID': 'fixture', '提醒提前分钟': 10}})
        self.assertEqual(w.cfg['会后动作']['模式'], '通知模式')
        self.assertEqual(w.cfg['会后动作']['提醒提前分钟'], 10)
        save.assert_called_once()

    def test_once_after_open_uses_today_plus_seven_not_next_open_day(self):
        now = datetime(2026, 11, 2, 15, 0)
        w = SimpleNamespace(cfg=copy.deepcopy(C.DEFAULTS), _busy=lambda: True, job='once',
                            btn_login=SimpleNamespace(isEnabled=lambda: True), login_state=None,
                            login_checked_at=None, phases={}, next_open=None,
                            clock=SimpleNamespace(now=lambda: now), log_view=SimpleNamespace(toPlainText=lambda: ''),
                            _calc_next=lambda: (datetime(2026, 11, 3, 12), datetime(2026, 11, 10).date()))
        c = HubControl.__new__(HubControl)
        c.w, c.work, c.results = w, None, queue.Queue()
        c.read_result, c.test_result = {}, {}
        with patch('msz.config.load_history', return_value=[]), patch('msz.post.pending', return_value=[]), patch('msz.welink.find_cli', return_value=None):
            status = c.status()
        self.assertEqual(status['targetDate'], '2026-11-09')
        self.assertEqual(status['nextOpen'], '2026-11-02T12:00:00')


if __name__ == '__main__':
    unittest.main()

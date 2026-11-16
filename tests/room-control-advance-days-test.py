"""提前天数 adapter：签名 2.1.3 的模块与仓库内可读源码保持一致，
原引擎与界面的 timedelta(weeks=1) 改按「抢订设置.提前天数」取天数，其他 timedelta 用法不变。
本机没有 PyQt5 时用最小替身，只测这层替换，不跑浏览器。"""
import copy
import importlib.util
import sys
import types
import unittest
from datetime import date, timedelta
from pathlib import Path

root = Path(__file__).resolve().parents[1] / 'core/company-assistant/room-component'
if 'PyQt5' not in sys.modules:
    try:
        import PyQt5  # noqa: F401
    except ImportError:
        qt = types.ModuleType('PyQt5'); core = types.ModuleType('PyQt5.QtCore')
        core.QTimer = type('QTimer', (), {'__init__': lambda self, *a, **k: None, 'timeout': types.SimpleNamespace(connect=lambda *a: None), 'start': lambda self, *a: None})
        qt.QtCore = core; sys.modules['PyQt5'] = qt; sys.modules['PyQt5.QtCore'] = core
sys.path.insert(0, str(root / 'msz-code-2.1.3.zip'))
from msz import config as C, jobs  # noqa: E402
spec = importlib.util.spec_from_file_location('msz.hub_control_next', root / 'hub_control.py', submodule_search_locations=None)
adapter = importlib.util.module_from_spec(spec); adapter.__package__ = 'msz'; spec.loader.exec_module(adapter)


class AdvanceDaysTests(unittest.TestCase):
    def setUp(self):
        self.saved = jobs.timedelta
        self.w = types.SimpleNamespace(cfg=copy.deepcopy(C.DEFAULTS))

    def tearDown(self):
        jobs.timedelta = self.saved

    def test_default_keeps_seven_days(self):
        self.assertEqual(adapter.advance_days(self.w.cfg), 7)
        adapter.install_advance_days(self.w)
        self.assertEqual(jobs.timedelta(weeks=1), timedelta(days=7))

    def test_three_days_follow_config_and_other_uses_unchanged(self):
        adapter.install_advance_days(self.w)
        self.w.cfg['抢订设置']['提前天数'] = 3
        self.assertEqual(jobs.timedelta(weeks=1), timedelta(days=3))
        self.assertEqual(jobs.timedelta(days=1), timedelta(days=1))
        self.assertEqual(jobs.timedelta(minutes=2), timedelta(minutes=2))
        self.assertEqual(jobs.timedelta(seconds=60), timedelta(seconds=60))
        # 守护循环里的写法：开放日 + timedelta(weeks=1)
        self.assertEqual(date(2026, 11, 14) + jobs.timedelta(weeks=1), date(2026, 11, 17))

    def test_invalid_values_fall_back_to_seven(self):
        for bad in [0, 15, '3', 3.0, True, None]:
            self.w.cfg['抢订设置']['提前天数'] = bad
            self.assertEqual(adapter.advance_days(self.w.cfg), 7, bad)

    def test_configure_accepts_range(self):
        self.assertEqual(adapter.validate_patch({'抢订设置': {'提前天数': 3, '开放时间': '08:30:00'}})['抢订设置']['提前天数'], 3)
        for bad in [0, 15, True]:
            with self.assertRaises(ValueError):
                adapter.validate_patch({'抢订设置': {'提前天数': bad}})


if __name__ == '__main__':
    unittest.main()

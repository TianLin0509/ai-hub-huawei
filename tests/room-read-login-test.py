"""「从页面读取」停在登录页（2026-11-27 R60）：组件要把登录状态记为失效，Hub 才显示失效横幅并经桌宠提醒。
加载仓库内可读的 hub_control.py / engine.py（签名包从它们构建），其余模块取自签名 2.1.3 基包；不跑浏览器。"""
import copy
import importlib.util
import queue
import sys
import time
import types
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

root = Path(__file__).resolve().parents[1] / 'core/company-assistant/room-component'
if 'PyQt5' not in sys.modules:
    try:
        import PyQt5  # noqa: F401
    except ImportError:
        qt = types.ModuleType('PyQt5'); core = types.ModuleType('PyQt5.QtCore')
        core.QTimer = type('QTimer', (), {'__init__': lambda self, *a, **k: None, 'timeout': types.SimpleNamespace(connect=lambda *a: None), 'start': lambda self, *a: None})
        qt.QtCore = core; sys.modules['PyQt5'] = qt; sys.modules['PyQt5.QtCore'] = core
sys.path.insert(0, str(root / 'msz-code-2.1.3.zip'))
from msz import config as C  # noqa: E402


def load(name, file):
    spec = importlib.util.spec_from_file_location('msz.' + name, root / file)
    mod = importlib.util.module_from_spec(spec); mod.__package__ = 'msz'; spec.loader.exec_module(mod)
    return mod


adapter = load('hub_control_r60', 'hub_control.py')
engine = load('engine_r60', 'engine.py')


class ReadRoomsLoginTests(unittest.TestCase):
    def control(self):
        now = datetime(2026, 11, 27, 9)
        w = SimpleNamespace(cfg=adapter.ensure_area(copy.deepcopy(C.DEFAULTS)), _busy=lambda: False, job=None,
                            btn_login=SimpleNamespace(isEnabled=lambda: True), login_state=None,
                            login_checked_at=None, phases={}, next_open=None,
                            clock=SimpleNamespace(now=lambda: now), log_view=SimpleNamespace(toPlainText=lambda: ''),
                            log=lambda *a: None,
                            _calc_next=lambda: (datetime(2026, 11, 28, 12), datetime(2026, 12, 5).date()))
        c = adapter.HubControl.__new__(adapter.HubControl)
        c.w, c.work, c.results = w, None, queue.Queue()
        c.read_result, c.test_result = {}, {}
        return c, w

    def run_op(self, c, fn):
        c.background('read-rooms', fn)
        for _ in range(100):
            if not c.results.empty():
                break
            time.sleep(0.02)
        with patch('msz.config.load_history', return_value=[]), patch('msz.post.pending', return_value=[]), patch('msz.welink.find_cli', return_value=None):
            return c.status()

    def test_login_page_marks_login_invalid(self):
        c, w = self.control()
        def stuck():
            raise engine.LoginRequired('页面停在了登录页')
        s = self.run_op(c, stuck)
        self.assertEqual(s['roomRead'], {'state': 'error', 'names': [], 'error': '页面停在了登录页'})
        self.assertIs(w.login_state, False)
        self.assertIs(s['loginState'], False)
        self.assertTrue(s['loginNeeded'])
        self.assertIsNotNone(s['loginCheckedAt'])

    def test_other_errors_and_success_leave_login_unknown(self):
        for fn, want in [(lambda: (_ for _ in ()).throw(RuntimeError('登录用的浏览器资料夹正被另一个浏览器窗口占用，请关掉它后重试')), 'error'),
                         (lambda: ['A101'], 'done')]:
            with self.subTest(want=want):
                c, w = self.control()
                s = self.run_op(c, fn)
                self.assertEqual(s['roomRead']['state'], want)
                self.assertIsNone(w.login_state)
                self.assertFalse(s['loginNeeded'])


if __name__ == '__main__':
    unittest.main()

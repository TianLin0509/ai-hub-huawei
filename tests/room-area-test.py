"""会议室所在地域（2026-11-22）：设置校验、默认不切换、按网页写法匹配，以及在本地还原的真实弹窗结构上逐级切换。

浏览器部分用无头 Edge + 本地夹具（tests/fixtures/company-room-area.html，结构取自公司真实页面只读探针）；
浏览器部分约 45 秒，设 ROOM_AREA_BROWSER=1 才跑（npm test 只跑前半）；本机没有 playwright 或 Edge 时同样跳过。
"""
import copy
import importlib.util
import os
import sys
import threading
import types
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
bundle = ROOT / 'core/company-assistant/room-component'
if 'PyQt5' not in sys.modules:
    try:
        import PyQt5  # noqa: F401
    except ImportError:
        qt = types.ModuleType('PyQt5'); core = types.ModuleType('PyQt5.QtCore')
        core.QTimer = type('QTimer', (), {'__init__': lambda self, *a, **k: None, 'timeout': types.SimpleNamespace(connect=lambda *a: None), 'start': lambda self, *a: None})
        qt.QtCore = core; sys.modules['PyQt5'] = qt; sys.modules['PyQt5.QtCore'] = core
os.environ.setdefault('MSZ_HOME', str(ROOT / 'artifacts' / ('room-area-' + str(os.getpid()))))
sys.path.insert(0, str(bundle / 'msz-code-2.1.3.zip'))
from msz import config as C  # noqa: E402


def load(name, file):
    spec = importlib.util.spec_from_file_location('msz.' + name, bundle / file)
    mod = importlib.util.module_from_spec(spec); mod.__package__ = 'msz'
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


engine = load('engine_area', 'engine.py')
adapter = load('hub_control_area', 'hub_control.py')

CITIES = ['不限区域', '上海(Shanghai)', '北京(Beijing)', '南京(Nanjing)', '西安(Xi’an)', '苏州(suzhou)']


class AreaSettingsTests(unittest.TestCase):
    def test_match_follows_page_spelling(self):
        m = engine.match_area
        self.assertEqual(m(CITIES, '北京(Beijing)'), '北京(Beijing)')
        self.assertEqual(m(CITIES, '北京'), '北京(Beijing)')
        self.assertEqual(m(CITIES, 'beijing'), '北京(Beijing)')
        self.assertEqual(m(CITIES, 'Suzhou'), '苏州(suzhou)')
        self.assertEqual(m(['不限国家/地区', 'China Region(研究所)', 'China Region(代表处)'], 'China Region(研究所)'), 'China Region(研究所)')
        # 写得不完整且能对上多个时不猜
        self.assertIsNone(m(['不限国家/地区', 'China Region(研究所)', 'China Region(代表处)'], 'China'))
        self.assertIsNone(m(CITIES, '广州'))
        self.assertIsNone(m(CITIES, ''))
        self.assertEqual(m(['不限楼宇', '练秋湖A1栋', '练秋湖A12栋'], '练秋湖A1栋'), '练秋湖A1栋')

    def test_validate_area_patch(self):
        out = adapter.validate_patch({'地域': {'城市': ' 北京 ', '楼宇': ''}})
        self.assertEqual(out['地域'], {'城市': '北京', '楼宇': ''})
        for bad in [{'地域': {'城市': 3}}, {'地域': {'城市': 'x' * 61}}, {'地域': {'城市': '北\n京'}}, {'地域': {'园区': '北京'}}, {'地域': '北京'}]:
            with self.assertRaises(ValueError, msg=bad):
                adapter.validate_patch(bad)

    def test_old_config_defaults_to_no_switch_and_keeps_legacy_filter(self):
        cfg = copy.deepcopy(C.DEFAULTS)
        cfg['位置筛选'] = {'区域': 'China Region(研究所)', '城市': '上海', '楼栋': '某楼'}
        adapter.ensure_area(cfg)
        self.assertEqual(cfg['地域'], {'国家/地区': '', '城市': '', '楼宇': ''})
        self.assertEqual(cfg['位置筛选']['楼栋'], '某楼')  # 旧版遗留字段不生效、不改动
        cfg['地域'] = {'城市': '北京', '多余': 'x'}
        self.assertEqual(adapter.ensure_area(cfg)['地域'], {'国家/地区': '', '城市': '北京', '楼宇': ''})

    def test_empty_area_never_touches_page(self):
        engine.clear_area_origin()
        b = engine.Booker(adapter.ensure_area(copy.deepcopy(C.DEFAULTS)), lambda *a: None, threading.Event(), None)
        b.page = None  # 一碰页面就会报错
        self.assertFalse(b.apply_area())

    def test_status_reports_area_capability_and_preferences(self):
        src = (bundle / 'hub_control.py').read_text(encoding='utf-8')
        self.assertIn("'area'", src.split('capabilities=')[1][:80])
        self.assertIn('地域', adapter.GROUPS)


class AreaApplyTests(unittest.TestCase):
    """用完整 apply_area/_choose 检查当前值、全部候选及查询行为，不访问预订系统。"""
    def setUp(self):
        self.texts = ['位置', 'China Region(研究所)', '上海(Shanghai)', '练秋湖A12栋']
        self.options = [[], ['不限国家/地区', 'China Region(研究所)', 'China Region(代表处)'],
                        CITIES, ['不限楼宇', '练秋湖A1栋', '练秋湖A12栋']]
        self.opened = None
        self.queries = []
        self.ignore_pick = False
        self.b = engine.Booker(adapter.ensure_area(copy.deepcopy(C.DEFAULTS)), lambda *a: None, threading.Event(), None)
        self.b.sleep = self.b.sleep_real = lambda *a: None
        self.b.page = types.SimpleNamespace(evaluate=self.evaluate,
            mouse=types.SimpleNamespace(click=self.open), keyboard=types.SimpleNamespace(press=self.close))
        for name, value in [('load_area_origin', None), ('save_area_origin', None), ('clear_area_origin', None)]:
            p = patch.object(engine, name, return_value=value); p.start(); self.addCleanup(p.stop)

    def open(self, x, y):
        self.opened = int(x)

    def close(self, key):
        self.opened = None

    def evaluate(self, js, arg=None):
        if js == engine.JS_AREA_SELECTS:
            return {'selects': [{'text': text, 'x': i, 'y': 0, 'w': 0, 'h': 0} for i, text in enumerate(self.texts)]}
        if js == engine.JS_AREA_LEAVES:
            return [] if self.opened is None else [o + engine.SEP + str(i) for i, o in enumerate(self.options[self.opened])]
        if js == engine.JS_AREA_PICK:
            if not self.ignore_pick:
                self.texts[self.opened] = arg[0]
            self.opened = None
            return True
        if js == engine.JS_CLICK_BUTTON:
            self.queries.append(self.texts[1:].copy())
            return True
        raise AssertionError('Unexpected page operation')

    def test_ambiguous_building_must_not_accept_current_a12(self):
        self.b.cfg['地域'] = {'楼宇': '练秋湖A1'}
        with self.assertRaisesRegex(RuntimeError, '练秋湖A1栋.*练秋湖A12栋'):
            self.b.apply_area()
        self.assertEqual(self.texts[3], '练秋湖A12栋')
        self.assertEqual(self.queries, [])

    def test_ambiguous_country_must_not_accept_current_country(self):
        self.b.cfg['地域'] = {'国家/地区': 'China'}
        with self.assertRaisesRegex(RuntimeError, 'China Region.*代表处'):
            self.b.apply_area()
        self.assertEqual(self.queries, [])

    def test_same_city_only_clears_remembered_building(self):
        self.b.cfg['地域'] = {'城市': '上海'}
        self.assertTrue(self.b.apply_area())
        self.assertEqual(self.texts[2:], ['上海(Shanghai)', '不限楼宇'])
        self.assertEqual(self.queries, [self.texts[1:]])

    def test_same_country_only_clears_city_and_building(self):
        self.b.cfg['地域'] = {'国家/地区': self.texts[1]}
        self.assertTrue(self.b.apply_area())
        self.assertEqual(self.texts[2:], ['不限区域', '不限楼宇'])

    def test_unique_alias_preserves_matching_full_selection(self):
        self.b.cfg['地域'] = {'城市': 'shanghai', '楼宇': '练秋湖A12栋'}
        self.assertFalse(self.b.apply_area())
        self.assertEqual(self.queries, [])

    def test_failed_selection_is_not_queried(self):
        self.b.cfg['地域'] = {'楼宇': '练秋湖A1栋'}
        self.ignore_pick = True
        with self.assertRaisesRegex(RuntimeError, '仍显示'):
            self.b.apply_area()
        self.assertEqual(self.queries, [])


def browser():
    if os.environ.get('ROOM_AREA_BROWSER') != '1':
        return None
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        return None
    for p in (r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', r'C:\Program Files\Microsoft\Edge\Application\msedge.exe'):
        if os.path.exists(p):
            return p
    return None


@unittest.skipUnless(browser(), '未设 ROOM_AREA_BROWSER=1，或本机没有 playwright / Edge')
class AreaBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        cls.br = cls.pw.chromium.launch(channel='msedge', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.br.close(); cls.pw.stop()

    def setUp(self):
        os.makedirs(C.app_dir(), exist_ok=True)
        engine.clear_area_origin()

    def run_area(self, area, query=''):
        cfg = adapter.ensure_area(copy.deepcopy(C.DEFAULTS))
        cfg['高级']['等待倍率'] = 0.2
        cfg['地域'].update(area)
        logs = []
        b = engine.Booker(cfg, lambda m, l='info': logs.append(m), threading.Event(), None)
        page = self.br.new_page(viewport={'width': 1400, 'height': 900})
        page.goto((ROOT / 'tests/fixtures/company-room-area.html').as_uri() + query)
        if 'ambiguous=building' in query:
            page.evaluate("() => { TREE[state.region][state.city].push('练秋湖A12栋'); state.building='练秋湖A12栋'; render(); }")
        if 'ambiguous=country' in query:
            page.evaluate("() => { TREE['China Region(代表处)'] = {}; }")
        b.page = page
        try:
            changed = b.apply_area()
            texts = [s['text'] for s in page.evaluate(engine.JS_AREA_SELECTS)['selects']]
            return changed, texts, page.evaluate('window.queried'), logs
        finally:
            page.close()

    def test_switch_city_and_building(self):
        for query in ('', '?inside=1'):
            changed, texts, queried, logs = self.run_area({'城市': '北京', '楼宇': '北研所B座'}, query)
            self.assertTrue(changed, query)
            self.assertEqual(texts, ['位置', 'China Region(研究所)', '北京(Beijing)', '北研所B座'], query)
            self.assertEqual(queried, [['China Region(研究所)', '北京(Beijing)', '北研所B座']], query)
            self.assertTrue(any('已切换会议室地域' in m for m in logs))

    def test_city_only_resets_building_to_unlimited(self):
        changed, texts, queried, _ = self.run_area({'城市': '成都(Chengdu)'})
        self.assertEqual(texts[2:], ['成都(Chengdu)', '不限楼宇'])
        self.assertEqual(len(queried), 1)

    def test_same_city_only_resets_building_to_unlimited(self):
        changed, texts, queried, _ = self.run_area({'城市': '上海'})
        self.assertTrue(changed)
        self.assertEqual(texts[2:], ['上海(Shanghai)', '不限楼宇'])
        self.assertEqual(len(queried), 1)

    def test_current_value_cannot_hide_ambiguous_candidates(self):
        for area, query, candidates in [({'楼宇': '练秋湖A1'}, '?ambiguous=building', '练秋湖A1栋.*练秋湖A12栋'),
                                         ({'国家/地区': 'China'}, '?ambiguous=country', 'China Region.*代表处')]:
            with self.subTest(area=area), self.assertRaisesRegex(RuntimeError, candidates):
                self.run_area(area, query)

    def test_building_option_scrolled_out_of_view(self):
        changed, texts, _, _ = self.run_area({'楼宇': '练秋湖A1栋'})
        self.assertEqual(texts[3], '练秋湖A1栋')

    def test_already_matching_does_nothing(self):
        changed, texts, queried, _ = self.run_area({'城市': '上海', '楼宇': '练秋湖F12栋'})
        self.assertFalse(changed)
        self.assertEqual(queried, [])

    def test_region_change_cascades(self):
        changed, texts, queried, _ = self.run_area({'国家/地区': 'Europe Region', '城市': '慕尼黑', '楼宇': 'MRC-1'})
        self.assertEqual(texts[1:], ['Europe Region', '慕尼黑(Munich)', 'MRC-1'])

    def test_unknown_city_lists_choices(self):
        with self.assertRaises(RuntimeError) as cm:
            self.run_area({'城市': '广州'})
        self.assertIn('没有「广州」', str(cm.exception))
        self.assertIn('北京(Beijing)', str(cm.exception))

    def test_clearing_area_returns_to_page_original(self):
        self.run_area({'城市': '北京', '楼宇': '北研所A座'})
        self.assertEqual(engine.load_area_origin(), ['China Region(研究所)', '上海(Shanghai)', '练秋湖F12栋'])
        # 夹具每次新开页面都回到原楼宇；用 ?start= 模拟网页记住了北京
        changed, texts, queried, logs = self.run_area({}, '?start=bj')
        self.assertTrue(changed)
        self.assertEqual(texts[1:], ['China Region(研究所)', '上海(Shanghai)', '练秋湖F12栋'])
        self.assertTrue(any('已切回原来的会议室地域' in m for m in logs))
        self.assertIsNone(engine.load_area_origin())
        changed, _, queried, _ = self.run_area({}, '?start=bj')
        self.assertFalse(changed)  # 切回一次后不再记着，留空就不动
        self.assertEqual(queried, [])

    def test_slow_building_list_is_waited_for(self):
        changed, texts, _, _ = self.run_area({'城市': '北京', '楼宇': '北研所C座'}, '?delay=1500')
        self.assertEqual(texts[3], '北研所C座')


if __name__ == '__main__':
    unittest.main(verbosity=1)

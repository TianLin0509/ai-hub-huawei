"""会议室抢订提速对照：同一模拟页、真实无头浏览器，旧签名包 2.1.3 与当前源码各跑一遍。

用法（MSZ_SOURCE 指向秘书终结者源码目录，只用其中的模拟页与依赖）：
    python tests/e2e-company-rooms-speed.py <old|new> <normal|steal|slow>
场景：
    normal  首选在开放时刻正常可订（回归：只提交一次、开放后立即点击）
    steal   首选在开放那一刻已被别人订走（对应 11-12、11-16 真机日志）
    slow    弹窗会议室列表 9 秒后才出现（对应 11-19、11-20 高峰识别失败）
结果写 ROOM_SPEED_OUT/<版本>-<场景>.json，并打印一行摘要。
"""
from datetime import datetime, timedelta
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / 'core/company-assistant/room-component'
SOURCE = Path(os.environ['MSZ_SOURCE'])
OUT = Path(os.environ.get('ROOM_SPEED_OUT', ROOT / 'artifacts/room-speed'))
VARIANT, SCENARIO = sys.argv[1], sys.argv[2]
assert VARIANT in ('old', 'new') and SCENARIO in ('normal', 'steal', 'slow')
OUT.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix=f'{VARIANT}-{SCENARIO}-', dir=OUT))
home = work / 'home'
home.mkdir()
os.environ['MSZ_HOME'] = str(home)

if VARIANT == 'old':
    bundle = COMPONENT / 'msz-code-2.1.3.zip'
else:
    spec = importlib.util.spec_from_file_location('build_room_control', ROOT / 'scripts/build-room-control.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    bundle = work / 'msz-code-dev.zip'
    bundle.write_bytes(builder.code_bytes(builder.base_files(COMPONENT / 'msz-code-2.1.3.zip'), COMPONENT, '2.1.99'))
sys.path.insert(0, str(bundle))
from msz import config as C  # noqa: E402
from msz.jobs import Runner  # noqa: E402

ROOMS = ['练秋湖F12-3-13R', '练秋湖F12-3-20R', '练秋湖F12-3-21R']
LEAD = 140  # 两个版本同样的提前量；旧版只备一间，用不满
result = {'variant': VARIANT, 'scenario': SCENARIO, 'bundle': str(bundle), 'localMockOnly': True, 'headless': True}
logs, server = [], None
started = time.monotonic()
try:
    with (work / 'mock.log').open('w', encoding='utf-8') as stderr:
        server = subprocess.Popen([sys.executable, str(ROOT / 'tests/fixtures/company-room-speed-mock.py'), str(home), str(SOURCE)],
                                  stdout=subprocess.DEVNULL, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
        ready = home / 'mock-ready.json'
        deadline = time.monotonic() + 15
        while not ready.exists():
            assert server.poll() is None and time.monotonic() < deadline, 'local mock not ready'
            time.sleep(.1)
        port = json.loads(ready.read_text(encoding='utf-8'))['port']
        open_at = (datetime.now() + timedelta(seconds=LEAD)).replace(microsecond=0)
        params = f'open={open_at:%H:%M:%S}&fullday=1'
        if SCENARIO == 'steal':
            params += f'&steal={ROOMS[0]}&stealdelay=0'
        if SCENARIO == 'slow':
            params += '&dlgslow=9'
        cfg = C.load_config()
        cfg['高级'].update({'网址': f'http://127.0.0.1:{port}/meetingroom/?{params}#/', '无界面': True, '等待倍率': 1.0})
        cfg['优先会议室'] = ROOMS
        cfg['主题'] = '提速对照本地回归'
        cfg['抢订设置'].update({'校准服务器时间': False, '提前填表秒数': LEAD})
        runner = Runner(cfg, lambda text, level='info': logs.append([round(time.monotonic() - started, 2), level, text]),
                        lambda *a: None, threading.Event())
        booked = runner.grab(open_at, datetime.now().date() + timedelta(days=7))

        def get(endpoint):
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/{endpoint}') as response:
                return json.load(response)
        attempts, receipts = get('__attempts'), get('__state')
        open_ms = open_at.timestamp() * 1000
        result.update(booking=booked, attempts=[[a['room'], round(a['at'] - open_ms)] for a in attempts],
                      receipts=[[r['room'], r.get('at')] for r in receipts])
        if receipts:
            # 成功那一下点击相对开放时刻的毫秒数（点击发生在页面里，取模拟页记录的时间）
            win = [a for a in attempts if a['room'] == receipts[-1]['room']]
            result['successClickAfterOpenMs'] = round(win[-1]['at'] - open_ms) if win else None
        result['receiptCount'] = len(receipts)
        result['ok'] = True
except Exception as exc:
    result['ok'] = False
    result['error'] = repr(exc)
finally:
    if server and server.poll() is None:
        server.terminate()
        server.wait(timeout=10)
    result['elapsedSeconds'] = round(time.monotonic() - started, 1)
    result['logs'] = logs
    (OUT / f'{VARIANT}-{SCENARIO}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    b = result.get('booking') or {}
    print(json.dumps({'variant': VARIANT, 'scenario': SCENARIO, 'ok': result['ok'], 'status': b.get('status'),
                      'room': b.get('room'), 'note': b.get('note'), 'successClickAfterOpenMs': result.get('successClickAfterOpenMs'),
                      'receipts': result.get('receiptCount'), 'attempts': result.get('attempts'), 'error': result.get('error')},
                     ensure_ascii=False))

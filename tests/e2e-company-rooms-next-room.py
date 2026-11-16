"""Signed payload -> production Runner -> real headless browser -> local SPA.

MSZ_SOURCE supplies only the existing local mock site and Python dependencies.
ROOM_NEXT_BUNDLE can select the previous signed payload to prove regression.
"""
import copy
from datetime import datetime, timedelta
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
OUT = Path(os.environ.get('ROOM_NEXT_OUT', ROOT / 'artifacts/r22/next-room'))
SOURCE = Path(os.environ['MSZ_SOURCE'])
BUNDLE = Path(os.environ.get('ROOM_NEXT_BUNDLE', ROOT / 'core/company-assistant/room-component/msz-code-2.1.3.zip'))
OUT.mkdir(parents=True, exist_ok=True)
home = Path(tempfile.mkdtemp(prefix='run-', dir=OUT)) / 'home'
home.mkdir()
os.environ['MSZ_HOME'] = str(home)
sys.path.insert(0, str(BUNDLE))
from msz import config as C
from msz.jobs import Runner

result = {'bundle': str(BUNDLE), 'home': str(home), 'headless': True, 'localMockOnly': True, 'checks': []}
logs = []
phases = []
server = None
started = time.monotonic()
try:
    with (OUT / 'mock.log').open('w', encoding='utf-8') as stderr:
        server = subprocess.Popen([sys.executable, str(ROOT / 'tests/fixtures/company-room-mock.py'),
                                   str(home), str(SOURCE), '--conflict'],
                                  stdout=subprocess.DEVNULL, stderr=stderr,
                                  creationflags=subprocess.CREATE_NO_WINDOW)
        ready = home / 'mock-ready.json'
        deadline = time.monotonic() + 15
        while not ready.exists():
            assert server.poll() is None, 'local mock exited'
            assert time.monotonic() < deadline, 'local mock not ready'
            time.sleep(.1)
        port = json.loads(ready.read_text(encoding='utf-8'))['port']
        cfg = C.load_config()
        wording = os.environ.get('ROOM_NEXT_WORDING', 'old')
        normal = os.environ.get('ROOM_NEXT_SCENARIO') == 'normal'
        cfg['高级'].update({'网址': f'http://127.0.0.1:{port}/meetingroom/?open=00:00:00&fullday=1&conflictText={wording}&allowFirst={int(normal)}#/',
                           '无界面': True, '等待倍率': .35})
        # Names come from the existing mock site's room list, not company data.
        cfg['优先会议室'] = ['练秋湖F12-3-13R', '练秋湖F12-3-20R']
        cfg['主题'] = '换下一间本地回归'
        cfg['抢订设置'].update({'最大重试次数': 2, '校准服务器时间': False})
        runner = Runner(cfg, lambda text, level=None: logs.append({'at': time.monotonic() - started, 'text': text}),
                        lambda *args: phases.append(args), threading.Event())
        open_at = datetime.now() + timedelta(seconds=15) if normal else None
        booked = runner.grab(open_at, datetime.now().date() + timedelta(days=7))
        result['booking'] = booked
        def get(endpoint):
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/{endpoint}') as response:
                return json.load(response)
        state = get('__conflict')
        receipts = get('__state')
        result.update(state=state, receipts=receipts, elapsedSeconds=time.monotonic() - started)
        assert booked['status'] == '成功', booked
        if normal:
            assert booked['room'] == cfg['优先会议室'][0], booked
            assert len(receipts) == 1 and len(state['attempts']) == 1, state
            assert state['pageLoads'] == 1, state
            click_delay = state['attempts'][0]['at'] - open_at.timestamp() * 1000
            result['openingClickDelayMs'] = click_delay
            assert 0 <= click_delay < 1500, click_delay
            result['checks'].append('首选正常流程只加载一次、只提交一次，并在开放后1500毫秒内点击，未提前提交')
        else:
            assert booked['room'] == cfg['优先会议室'][1], booked
            assert '首选被抢，换到' in booked['note'], booked
            assert len(receipts) == 1 and receipts[0]['room'] == cfg['优先会议室'][1], receipts
            assert state['pageLoads'] == 2, state
            assert [a['room'] for a in state['attempts']] == [cfg['优先会议室'][0]] * 2 + [cfg['优先会议室'][1]], state
            retry_seconds = (state['attempts'][-1]['at'] - state['attempts'][-2]['at']) / 1000
            result['retrySeconds'] = retry_seconds
            assert retry_seconds < 15, retry_seconds
            result['checks'] += ['首选连续被抢后第二间成功，只有一条成功回执',
                                 '同带 # URL 确实重新请求两次，延迟表单加载后仍能填表',
                                 '换房不再等待固定 8 秒，重选到提交小于 15 秒']
        result['ok'] = True
except Exception as exc:
    result['ok'] = False
    result['error'] = repr(exc)
    raise
finally:
    if server and server.poll() is None:
        server.terminate()
        server.wait(timeout=10)
    result['logs'], result['phases'] = logs, phases
    (OUT / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: result.get(k) for k in ('ok', 'error', 'elapsedSeconds', 'retrySeconds')}, ensure_ascii=False))

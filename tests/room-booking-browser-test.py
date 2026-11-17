"""Real browser + Python read_rooms integration, using only a local fixture.

Usage: python tests/room-booking-browser-test.py --node <node.exe> --browser <msedge.exe>
Profiles/results stay in artifacts/room-booking-browser-* for review.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument('--node', default='node')
parser.add_argument('--browser', required=True)
args = parser.parse_args()
ROOT = Path(__file__).resolve().parents[1]
bundle = ROOT / 'core/company-assistant/room-component'
out = ROOT / 'artifacts' / ('room-booking-browser-' + str(os.getpid()))
out.mkdir(parents=True, exist_ok=False)
sys.path.insert(0, str(bundle / 'msz-code-2.1.3.zip'))
from msz import config as C
spec = importlib.util.spec_from_file_location('msz.engine', bundle / 'engine.py')
engine = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = engine
spec.loader.exec_module(engine)

bridge = subprocess.Popen([args.node, str(ROOT/'tests/helpers/room-browser-bridge.js'), args.browser, str(out/'profile')],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8',
    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)

class Page:
    def expression(self, expression):
        bridge.stdin.write(json.dumps({'expression': expression})+'\n')
        bridge.stdin.flush()
        response = json.loads(bridge.stdout.readline())
        if 'error' in response:
            raise RuntimeError(response['error'])
        return response.get('value')

    def evaluate(self, script, arg=None):
        return self.expression('('+script+')('+json.dumps(arg)+')')

page = Page()
names = [f'测试楼-R{i:02d}' for i in range(23)]
results = []
try:
    assert json.loads(bridge.stdout.readline()) == {'ready': True}
    cases = [('container', 280, 0), ('container', 140, 0),
             ('document', 0, 0), ('fits-document', 0, 0),
             ('ancestor-clipped', 280, 0), ('hidden-owner', 140, 0),
             ('container', 280, 1100)]
    for layout, height, delay in cases:
        rows = ''.join('<section class="row"><span data-name="'+name+'">'+name+'</span>'+('<div class="cell"></div>'*24)+'</section>' for name in names)
        content = '<style>body{margin:0}.row{display:flex;height:28px}.row span{display:block;width:240px;flex:none}.cell{width:30px;height:28px;flex:none;background:#eee}#rooms{margin-top:260px;width:980px;height:'+str(height)+'px;overflow:auto}</style><div id="rooms">'+rows+'</div>'
        if layout == 'document':
            content += '<style>#rooms{height:auto;margin-top:760px;overflow:visible}</style>'
        elif layout == 'fits-document':
            content += '<style>#rooms{height:auto;margin-top:0;overflow:visible}</style>'
        elif layout == 'ancestor-clipped':
            content = '<div style="height:400px;overflow:hidden">'+content+'</div>'
        elif layout == 'hidden-owner':
            content += '<style>#rooms{overflow:hidden}</style>'
        page.expression('document.open();document.write('+json.dumps('<!doctype html>'+content)+');document.close()')
        page.expression('delete window.__mszRoomScroll')
        if delay:
            page.expression('''(() => { const box=document.getElementById('rooms'); let timer;
              box.addEventListener('scroll', () => { clearTimeout(timer); box.setAttribute('aria-busy','true');
                for(const e of box.querySelectorAll('[data-name]')) e.textContent='';
                timer=setTimeout(() => {for(const e of box.querySelectorAll('[data-name]')) e.textContent=e.dataset.name;
                  box.removeAttribute('aria-busy');}, DELAY); }); })()'''.replace('DELAY', str(delay)))
        b = engine.Booker.__new__(engine.Booker)
        b.cfg, b.page, b.stop, b.factor = copy.deepcopy(C.DEFAULTS), page, threading.Event(), 1
        b.log = lambda *a: None
        b.launch = b.close = b.open_page = lambda: None
        b.fill_form = b.open_room_dialog = b.shot = lambda *a: None
        start = time.monotonic()
        expected_error = layout in ('ancestor-clipped', 'hidden-owner')
        try:
            with patch.object(engine, 'Booker', return_value=b):
                found = engine.read_rooms(b.cfg, b.log, b.stop, '2026/11/20')
        except RuntimeError as exc:
            assert expected_error and '读取未完成' in str(exc), str(exc)
            found = None
        else:
            assert not expected_error, 'clipped list must not return partial success'
            assert found == names, {'missing': list(set(names)-set(found)), 'found': found}
        result = {'layout': layout, 'height': height, 'paintDelayMs': delay,
                  'found': len(found) if found is not None else None,
                  'incompleteRejected': found is None, 'seconds': round(time.monotonic()-start, 2)}
        results.append(result)
        print(json.dumps(result), flush=True)
    page.expression('document.body.insertAdjacentHTML("beforeend", '+json.dumps(
        '<input class="ev_datepicker_input" value="2026/11/20"><button aria-selected="true">全部会议室</button>')+')')
    diagnostic = page.evaluate(engine.JS_ROOM_DIAGNOSTICS, names[-1])
    assert diagnostic['formDate'] == '2026/11/20' and diagnostic['activeRoomTab'] == '全部会议室', diagnostic
    assert diagnostic['leafMatches'] == 1 and diagnostic['visibleMatches'] >= 1, diagnostic
    assert page.evaluate(engine.JS_ROOM_DIAGNOSTICS, 'missing-fixture-room')['labelMatches'] == 0
    print('PASS: failure diagnostic fields from real browser DOM', flush=True)
    (out/'result.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    print('PASS: complete lists and explicit clipped-list failures through real read_rooms; '+str(out), flush=True)
finally:
    bridge.stdin.write('{"close":true}\n')
    bridge.stdin.flush()
    bridge.stdin.close()
    bridge.wait(timeout=15)
    if bridge.returncode:
        raise RuntimeError(bridge.stderr.read())

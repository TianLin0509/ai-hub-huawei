"""Actual secretary mock webpage with a receipt endpoint, isolated per E2E run."""
import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer

root, original = map(Path, sys.argv[1:3])
root.mkdir(parents=True, exist_ok=True)
os.environ["MSZ_HOME"] = str(root)
sys.path.insert(0, str(original / "tests"))
sys.path.insert(0, str(original))
import mock_server
from msz import config as C
state = mock_server.MockState()
base = mock_server.make_handler(state)
conflict = "--conflict" in sys.argv
attempts = []
page_loads = 0

# Keep the existing page and booking engine; add the observed failed-booking
# overlay. A same-document hash navigation cannot clear it. Only the first room
# is stolen, so the second room remains genuinely bookable through the page.
CONFLICT_SCRIPT = """<script>
document.getElementById('book').addEventListener('click', e => {
  fetch('/__attempt', {method: 'POST', body: JSON.stringify({room: state.room, at: Date.now()})});
  if (state.room !== ROOMS[0] || Q.get('allowFirst') === '1') return;
  e.stopImmediatePropagation();
  toast(Q.get('conflictText') === 'new' ? '会议室已被预订，请重新选择' : '预定失败：会议室已被预定，请重新选择', false);
  let mask = document.getElementById('conflict-mask');
  if (!mask) {
    mask = document.createElement('div'); mask.id = 'conflict-mask';
    mask.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.1)';
    document.body.appendChild(mask);
  }
}, true);
// Mimic delayed SPA data: a fast retry must wait for the new form to be usable.
document.getElementById('form').style.display = 'none';
setTimeout(() => document.getElementById('form').style.display = '', 1200);
</script>"""


class Handler(base):
    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        global page_loads
        if conflict and self.path.startswith("/meetingroom"):
            page_loads += 1
            body = body.replace("</body>", CONFLICT_SCRIPT + "</body>")
        super()._send(code, body, ctype)

    def do_GET(self):
        if self.path == "/__state":
            self._send(200, json.dumps(state.booked, ensure_ascii=False), "application/json")
        elif self.path == "/__conflict":
            self._send(200, json.dumps({"attempts": attempts, "pageLoads": page_loads}), "application/json")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/__attempt":
            attempts.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self._send(200, "ok", "text/plain")
        else:
            super().do_POST()


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port = server.server_address[1]
opened = (datetime.now() + timedelta(seconds=100)).strftime("%H:%M:%S")
cfg = C.load_config()
cfg["高级"].update({"网址": f"http://127.0.0.1:{port}/meetingroom/?open={opened}&fullday=1#/",
                 "无界面": True, "等待倍率": 0.35})
cfg["抢订设置"].update({"开放时间": opened, "提前填表秒数": 30, "登录预检提前分钟": 1})
cfg["系统"].update({"守护时阻止睡眠": False, "自动检查更新": False})
(root / "config.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
(root / "mock-ready.json").write_text(json.dumps({"port": port, "opened": opened, "pid": os.getpid()}), encoding="utf-8")
server.serve_forever()

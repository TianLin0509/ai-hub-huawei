"""秘书终结者原模拟页 + 两处测试注入：记录每次点「预定」的房间与时刻；dlgslow=秒 让弹窗列表延迟出现。

只在本机隔离运行；不含公司数据。
"""
import json
import os
import sys
from pathlib import Path
from http.server import ThreadingHTTPServer

root, original = map(Path, sys.argv[1:3])
os.environ["MSZ_HOME"] = str(root)
sys.path.insert(0, str(original / "tests"))
import mock_server  # noqa: E402

state = mock_server.MockState()
base = mock_server.make_handler(state)
attempts = []

INJECT = """<script>
document.getElementById('book').addEventListener('click', () => {
  fetch('/__attempt', {method: 'POST', body: JSON.stringify({room: state.room, at: Date.now()})});
}, true);
(() => {
  // 高峰模拟：打开弹窗后 dlgslow 秒内列表区只显示「加载中」，之后才渲染会议室行。
  const slow = parseFloat(Q.get('dlgslow') || '0');
  if (!slow) return;
  const original = renderGrid;
  let until = 0;
  document.getElementById('addRoom').addEventListener('click', () => { until = Date.now() + slow * 1000; }, true);
  renderGrid = function () {
    const left = until - Date.now();
    if (left > 0) {
      document.getElementById('grid').innerHTML = '<div style="padding:20px">加载中…</div>';
      setTimeout(renderGrid, left + 20);
      return;
    }
    return original.apply(this, arguments);
  };
})();
</script>"""


class Handler(base):
    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        if self.path.startswith("/meetingroom"):
            body = body.replace("</body>", INJECT + "</body>")
        super()._send(code, body, ctype)

    def do_GET(self):
        if self.path == "/__state":
            self._send(200, json.dumps(state.booked, ensure_ascii=False), "application/json")
        elif self.path == "/__attempts":
            self._send(200, json.dumps(attempts, ensure_ascii=False), "application/json")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/__attempt":
            attempts.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self._send(200, "ok", "text/plain")
        else:
            super().do_POST()


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
(root / "mock-ready.json").write_text(json.dumps({"port": server.server_address[1], "pid": os.getpid()}), encoding="utf-8")
server.serve_forever()

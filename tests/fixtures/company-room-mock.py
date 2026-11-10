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


class Handler(base):
    def do_GET(self):
        if self.path == "/__state":
            self._send(200, json.dumps(state.booked, ensure_ascii=False), "application/json")
        else:
            super().do_GET()


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

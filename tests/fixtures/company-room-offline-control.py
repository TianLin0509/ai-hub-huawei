"""Run the unchanged signed payload; inject only the browser's offline condition."""
import os
import sys
from pathlib import Path

bundle, marker = sys.argv[1:3]
sys.path.insert(0, bundle)
sys.argv = [sys.argv[0], "--hub-control"]
os.environ.setdefault("MSZ_HUB_TEST_INSTANCE", "room-offline-regression")
from msz.engine import Booker

original_launch = Booker.launch


def launch(self, *args, **kwargs):
    original_launch(self, *args, **kwargs)
    if Path(marker).exists():
        # Playwright itself makes Page.goto fail with net::ERR_INTERNET_DISCONNECTED.
        self.ctx.set_offline(True)


Booker.launch = launch
from msz.entry import main
main()

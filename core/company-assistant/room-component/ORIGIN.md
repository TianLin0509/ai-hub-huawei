# Secretary control component

This is the meeting-room component embedded in the company edition of Hub.
2026-11-16: the current signed control package is **2.1.3**. It reloads the
document after a failed booking before selecting another room, recognizes both
spellings of the booked-room response, retries short Windows status-file locks,
and includes the configurable advance-days adapter. The successful first-choice
path keeps the original 8-second preparation floor and opening-time submission.
The current signed 2.1.3 package was built from the official 2.1.1 base,
retaining its adapter as `hub_control_base.py`. Ordinary Hub builds use the
signed ZIP named in `control.json`; readable sources are not loaded directly.

2026-11-16: `engine.py` and `jobs.py` now contain reviewable fixes for skipped
room-list rows and detection failures incorrectly reported as all rooms taken.
The first-booking "room missing" cause still needs real-page evidence; bounded
diagnostics are emitted only on detection failure. **These source fixes are not
in the existing signed 2.1.3 package.** Source tests do not activate them in Hub.
`scripts/build-room-control.py` pins the SHA-256 of that existing package, retains
all other modules, overlays the three readable sources, and signs a new component
(default 2.1.4) using the existing release key on the authorized signing machine:

```powershell
python tests/room-booking-engine-test.py
python tests/room-component-build-test.py
python scripts/build-room-control.py --key <local-release-key-path> --version 2.1.4
python scripts/build-room-control.py --check
```

Before signing, `--check` exits 2 and names the pending sources. After signing,
it must exit 0 with `ok: true`; it verifies the signature, package size/hash and
source parity. A separate `--out <directory>` can stage both generated files;
check it with `--check --out <directory>`. Keep the 2.1.3 base for reproducibility
and tests. Only the new signed ZIP and `control.json` go through release review;
the private key stays on the signing machine and is never bundled or transferred.
No network publishing is performed, no private key is included, and shell 2.1.0
is unchanged. History, logs, login state, room discovery, once booking and post
actions are supplied by the original Python process. Settings are saved only
on its GUI thread. Empty room plans can be saved; starting requires a room.

The standalone updater, autorun and share packaging remain managed by Hub.
On explicit reconnect, an idle older Hub-managed helper can be replaced after
checking its PID and exact verified executable path. Active jobs and standalone
secretary processes are never terminated by this upgrade path.

Original 2.1.1 provenance follows:
It reuses the v2.1.0 shell and the existing booking engine. The v2.1.1 code
package adds a local GUI-thread control adapter and preserves the browser
profile, original settings and post-booking behavior.

- `baseline.json`: original signed v2.1.0 release manifest, including the shell asset.
- `control.json`: current signed v2.1.3 code manifest.
- `msz-code-2.1.3.zip`: original Python modules plus the three readable overlays
  and the retained `hub_control_base.py`. Inspectable with any ZIP reader.
- `msz-code-2.1.2.zip`: retained previous signed payload for upgrade/regression
  fixtures; the current manifest selects only 2.1.3.
- No private signing key is included.
- `runtime/MishuTerminator-2.1.0.exe` is a build artifact, excluded from Git.
  It is the original signed release asset: 80,568,759 bytes (76.84 MiB).
  **Since v3.1.3 (2026-10-22) the installer no longer carries it.** The app
  downloads it on first use of 「抢会议室」 from the official public release
  (`room-runtime-download.js`), verifies size and SHA-256 against this signed
  `baseline.json`, and caches it under `<Hub data>/company-assistant/room-runtime/<sha256>/`.
  An existing installation that still has the bundled copy reuses it, so users
  upgrading from 3.1.2 do not download it again. `build-runtime.js` is now only
  for e2e and offline staging; it is no longer a packaging hook.
- Both manifests are verified using the secretary's existing Ed25519 public key.
- The code package was built with the secretary's existing `tools/release.py`
  in an isolated source copy, without publishing.

Compatibility: shell 1; the GUI continues to own configuration and the
single-instance lock. A running old secretary must be exited normally before
the new control adapter can load. Hub does not terminate it.

Company source export remains usable for development without the large runtime.
To exercise the real exe locally (e2e), stage it from the official release:

```powershell
$env:AI_HUB_ROOM_RUNTIME_SOURCE = '<official release directory>\MishuTerminator-2.1.0.exe'
node core/company-assistant/room-component/build-runtime.js
```

Packaging deliberately does not stage it, and `target.json` excludes
`room-component/runtime/**` from the installer, so a locally staged copy never
ships by accident. A runtime change requires a new signed baseline under the
release policy; the downloader reads size and hash from that manifest, so the
download URL alone cannot change what gets installed.

At first use, Hub copies the verified exe to
`<Hub data>/company-assistant/room-runtime/<sha256>/` so running Windows handles
do not lock the installation during an update. The source copy is taken from the
installer tree (including `app.asar.unpacked` on installs from before v3.1.3);
when the machine has no copy at all, the user downloads it from the setting page
and the size and hash come from the signed `baseline.json`, not from the URL. New user state lives in
`<Hub data>/company-assistant/meeting-room/`; previously connected users keep
their data home, rules and browser profile. Hub sets `MSZ_HOME` and `MSZ_NO_TRAY=1`,
disables the component's own updater/autorun, and defaults booking to stopped.
Only a requested `start` command enables the existing weekly booking loop.

The original Qt window object still owns worker threads, configuration and
post-booking actions, but is hidden. No separate app installation or exe picker
is required. Normal booking uses existing Edge/Chrome in headless mode; explicit
login opens its browser and retains the profile. This browser login is separate
from the WeLink CLI login. Rewriting the engine in JavaScript is a different
project; this integration does not claim that migration or a real-company
booking acceptance test.

Advance days default to seven for existing settings and support 1–14 days when
Hub supplies a site-specific rule. The adapter applies this to scheduling,
immediate booking and room discovery without changing the standalone helper.

Regression entry points: `tests/room-next-room-test.py` (also in `npm test`),
`tests/e2e-company-rooms-next-room.py` (real headless browser and local SPA), and
`tests/e2e-company-rooms-upgrade.js` (signed 2.1.2 -> 2.1.3, verified managed exe).
The headless E2E accepts `MSZ_SOURCE` for the existing mock site/dependencies;
`ROOM_NEXT_BUNDLE` can select 2.1.2 to reproduce the 15-second blocked click.

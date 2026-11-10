"""Reproducibly sign the local Hub control bundle; no network or publication."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
bundle = root / 'core/company-assistant/room-component'
parser = argparse.ArgumentParser()
parser.add_argument('--key', required=True, help='Path to the release signing key; never included in the repository')
parser.add_argument('--base', required=True, help='Path to the official 2.1.1 code package used as the reproducible base')
args = parser.parse_args()
with zipfile.ZipFile(args.base) as z:
    files = {name: z.read(name) for name in z.namelist()}
files['msz/hub_control_base.py'] = files['msz/hub_control.py']
files['msz/hub_control.py'] = (bundle / 'hub_control.py').read_text(encoding='utf-8').encode('utf-8')
files['msz/version.py'] = b'VERSION = "2.1.2"\nSHELL = 1\n'
dest = bundle / 'msz-code-2.1.2.zip'
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in sorted(files):
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, files[name])
# The original package's pure-Python Ed25519 implementation; key never logged.
namespace = {}
exec(compile(files['msz/ed25519.py'], 'ed25519.py', 'exec'), namespace)
key = bytes.fromhex(Path(args.key).read_text().strip())
assert namespace['public_key'](key).hex() == '484b4c7e2085c284d6a569b95c8defd152dec09a2f3015a9be18c5df8ec2bed4'
manifest = {'app': 'mishu-terminator', 'version': '2.1.2', 'shell': 1, 'date': '2026-11-02',
            'notes': ['Hub 独立会议室：完整计划、会后动作、历史日志与设置；复用原抢订引擎'],
            'code': {'file': dest.name, 'size': dest.stat().st_size, 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()}}
payload = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
manifest['signature'] = namespace['sign'](key, payload).hex()
(bundle / 'control.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Signed local room control 2.1.2; verify with room-component.manifest before use.')

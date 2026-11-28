"""Build reviewable booking sources with the existing component signing key.

--check is read-only: it fails when the signed runtime does not contain the
current sources. Source tests alone do not mean the fix is installed.
"""
import argparse
from datetime import date
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / 'core/company-assistant/room-component'
BASE_SHA256 = '80e93dbc11543ba1d6d502dac2e7037f6463e25bdd280997be61711cb203f6de'
PUBLIC_KEY = '484b4c7e2085c284d6a569b95c8defd152dec09a2f3015a9be18c5df8ec2bed4'
SOURCES = ('hub_control.py', 'engine.py', 'jobs.py')


def base_files(base):
    data = Path(base).read_bytes()
    if hashlib.sha256(data).hexdigest() != BASE_SHA256:
        raise ValueError('Expected the verified official 2.1.3 base package')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {name: z.read(name) for name in z.namelist()}


def signing_api(files):
    namespace = {}
    exec(compile(files['msz/ed25519.py'], 'ed25519.py', 'exec'), namespace)
    return namespace


def code_bytes(files, source_dir, version):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or tuple(map(int, version.split('.'))) <= (2, 1, 3):
        raise ValueError('A new component version greater than 2.1.3 is required')
    files = dict(files)
    for name in SOURCES:
        files['msz/' + name] = (Path(source_dir) / name).read_text(encoding='utf-8').encode('utf-8')
    files['msz/version.py'] = f'VERSION = "{version}"\nSHELL = 1\n'.encode('ascii')
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[name])
    return out.getvalue()


def payload(manifest):
    return json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def check_bundle(bundle, api, source_dir=None):
    source_dir = Path(source_dir) if source_dir is not None else bundle
    manifest = json.loads((bundle / 'control.json').read_text(encoding='utf-8'))
    signature = manifest.pop('signature')
    if not api['verify'](bytes.fromhex(PUBLIC_KEY), payload(manifest), bytes.fromhex(signature)):
        raise ValueError('Component manifest signature is invalid')
    asset = manifest['code']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', asset['file']):
        raise ValueError('Invalid package filename')
    data = (bundle / asset['file']).read_bytes()
    if len(data) != asset['size'] or hashlib.sha256(data).hexdigest() != asset['sha256']:
        raise ValueError('Component package hash/size is invalid')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        pending = [name for name in SOURCES if z.read('msz/' + name).decode('utf-8').replace('\r\n', '\n')
                   != (source_dir / name).read_text(encoding='utf-8')]
    return {'ok': not pending, 'version': manifest['version'], 'pendingSources': pending}


def build(base, source_dir, out, version, key_path, release_date, note=None):
    files = base_files(base)
    api = signing_api(files)
    key = bytes.fromhex(Path(key_path).read_text(encoding='utf-8').strip())
    if len(key) != 32 or api['public_key'](key).hex() != PUBLIC_KEY:
        raise ValueError('The existing room-component release key is required')
    code = code_bytes(files, source_dir, version)
    name = f'msz-code-{version}.zip'
    manifest = {'app': 'mishu-terminator', 'version': version, 'shell': 1, 'date': release_date,
                'notes': [note or '修复会议室列表漏读及识别失败误报满员，增加查找失败诊断'],
                'code': {'file': name, 'size': len(code), 'sha256': hashlib.sha256(code).hexdigest()}}
    manifest['signature'] = api['sign'](key, payload(manifest)).hex()
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / name).write_bytes(code)
    (out / 'control.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'ok': True, 'version': version, 'file': name, 'bytes': len(code)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=BUNDLE / 'msz-code-2.1.3.zip')
    parser.add_argument('--key', type=Path, help='Local path on the authorized signing machine; never copy the key')
    parser.add_argument('--version', default='2.1.7')
    parser.add_argument('--date', default=date.today().isoformat())
    parser.add_argument('--out', type=Path, default=BUNDLE)
    parser.add_argument('--note', help='One-line release note stored in the signed manifest')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.check:
        result = check_bundle(args.out, signing_api(base_files(args.base)), BUNDLE)
    else:
        if not args.key:
            parser.error('--key is required to sign; use --check for a read-only check')
        date.fromisoformat(args.date)
        result = build(args.base, BUNDLE, args.out, args.version, args.key, args.date, args.note)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 2


if __name__ == '__main__':
    raise SystemExit(main())

"""Offline component packaging checks. Test keys are never production keys."""
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('room_build', ROOT / 'scripts/build-room-control.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
BASE = build.BUNDLE / 'msz-code-2.1.3.zip'


class ComponentBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = build.base_files(BASE)
        cls.api = build.signing_api(cls.files)

    def test_source_zip_is_deterministic_and_preserves_other_modules(self):
        first = build.code_bytes(self.files, build.BUNDLE, '2.1.4')
        self.assertEqual(first, build.code_bytes(self.files, build.BUNDLE, '2.1.4'))
        with zipfile.ZipFile(io.BytesIO(first)) as z:
            self.assertEqual(set(z.namelist()), set(self.files))
            for name in build.SOURCES:
                self.assertEqual(z.read('msz/' + name).decode(), (build.BUNDLE / name).read_text(encoding='utf-8'))
            changed = {'msz/' + name for name in build.SOURCES} | {'msz/version.py'}
            for name in self.files.keys() - changed:
                self.assertEqual(z.read(name), self.files[name], name)

    def test_rejects_old_or_invalid_version(self):
        for version in ('2.1.3', '1.9.9', '../2.1.4', '2.1.4/bad'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                build.code_bytes(self.files, build.BUNDLE, version)

    def test_rejects_modified_base_before_loading_code(self):
        with tempfile.TemporaryDirectory(prefix='room-build-') as tmp:
            base = Path(tmp) / 'base.zip'
            base.write_bytes(BASE.read_bytes() + b'tampered')
            with self.assertRaisesRegex(ValueError, 'verified official'):
                build.base_files(base)

    def test_rejects_wrong_release_key_without_writing_output(self):
        with tempfile.TemporaryDirectory(prefix='room-build-') as tmp:
            key, out = Path(tmp) / 'test-key', Path(tmp) / 'out'
            key.write_text('00' * 32, encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'release key'):
                build.build(BASE, build.BUNDLE, out, '2.1.4', key, '2026-11-16')
            self.assertFalse(out.exists())

    def test_stale_signed_bundle_is_reported_as_pending(self):
        key_bytes = bytes(range(32))
        with tempfile.TemporaryDirectory(prefix='room-build-') as tmp, patch.object(build, 'PUBLIC_KEY', self.api['public_key'](key_bytes).hex()):
            out = Path(tmp)
            data = BASE.read_bytes()
            (out / BASE.name).write_bytes(data)
            manifest = {'version': '2.1.3', 'code': {'file': BASE.name, 'size': len(data),
                        'sha256': hashlib.sha256(data).hexdigest()}}
            manifest['signature'] = self.api['sign'](key_bytes, build.payload(manifest)).hex()
            (out / 'control.json').write_text(json.dumps(manifest), encoding='utf-8')
            result = build.check_bundle(out, self.api, build.BUNDLE)
            self.assertEqual(result, {'ok': False, 'version': '2.1.3', 'pendingSources': ['engine.py', 'jobs.py']})

    def test_signed_roundtrip_and_tamper_detection_with_test_key(self):
        # Trust override exists only in this process and temporary test directory.
        key_bytes = bytes(range(32))
        with tempfile.TemporaryDirectory(prefix='room-build-') as tmp, patch.object(build, 'PUBLIC_KEY', self.api['public_key'](key_bytes).hex()):
            key, out = Path(tmp) / 'test-key', Path(tmp) / 'out'
            key.write_text(key_bytes.hex(), encoding='utf-8')
            built = build.build(BASE, build.BUNDLE, out, '2.1.4', key, '2026-11-16')
            self.assertTrue(built['ok'])
            self.assertEqual(build.check_bundle(out, self.api, build.BUNDLE),
                             {'ok': True, 'version': '2.1.4', 'pendingSources': []})
            manifest_file = out / 'control.json'
            original_manifest = manifest_file.read_bytes()
            manifest = json.loads(original_manifest)
            manifest['notes'] = ['tampered']
            manifest_file.write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'signature'):
                build.check_bundle(out, self.api, build.BUNDLE)
            manifest_file.write_bytes(original_manifest)
            package = out / built['file']
            package.write_bytes(package.read_bytes() + b'tampered')
            with self.assertRaisesRegex(ValueError, 'hash/size'):
                build.check_bundle(out, self.api, build.BUNDLE)


if __name__ == '__main__':
    unittest.main()

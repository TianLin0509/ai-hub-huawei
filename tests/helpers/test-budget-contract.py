"""Low-load real Windows Job contracts; no Hub, accounts or test suite launched."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import importlib.util


HERE = Path(__file__).resolve()
WATCHDOG = HERE.with_name('test-budget.py')


def fixture(mode):
    print('fixture-entered', flush=True)
    if mode == 'success':
        print('fixture-stdout', flush=True)
        print('fixture-stderr', file=sys.stderr, flush=True)
        return 0
    if mode == 'failure':
        return 7
    if mode == 'sync-loop':
        while True:
            pass
    if mode in ('hang-tree', 'residual-tree'):
        child = subprocess.Popen([sys.executable, '-I', '-S', str(HERE), '--fixture', 'sleep'],
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        print('fixture-descendant=' + str(child.pid), flush=True)
        if mode == 'residual-tree':
            return 0
    while True:
        time.sleep(.1)


@unittest.skipUnless(os.name == 'nt', 'Windows Job contract')
class BudgetContract(unittest.TestCase):
    def invoke(self, command, timeout=15):
        started = time.monotonic()
        result = subprocess.run([sys.executable, '-I', '-S', str(WATCHDOG),
                                 '--timeout-seconds', str(timeout), '--label', 'contract', '--', *command],
                                capture_output=True, text=True, timeout=35,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        events = [json.loads(line.removeprefix('[test-budget] '))
                  for line in result.stdout.splitlines() if line.startswith('[test-budget] ')]
        print(json.dumps({'case': self.id().split('.')[-1], 'exitCode': result.returncode,
                          'elapsedMs': round((time.monotonic() - started) * 1000),
                          'stdout': result.stdout, 'stderr': result.stderr}), flush=True)
        return result, events

    def run_fixture(self, mode, timeout=15):
        return self.invoke([sys.executable, '-I', '-S', str(HERE), '--fixture', mode], timeout)

    def assert_clean(self, events):
        self.assertEqual([e['activeProcesses'] for e in events if e['event'] == 'cleanup-confirmed'], [0])
        self.assertFalse(any(e['event'] == 'cleanup-unconfirmed' for e in events))

    def test_success_streams(self):
        result, events = self.run_fixture('success')
        self.assertEqual(result.returncode, 0)
        self.assertIn('fixture-stdout', result.stdout)
        self.assertIn('fixture-stderr', result.stderr)
        self.assertEqual(events[-1]['commandExitCode'], 0)
        self.assert_clean(events)

    def test_nonzero_preserved(self):
        result, events = self.run_fixture('failure')
        self.assertEqual(result.returncode, 7)
        self.assertEqual(events[-1]['commandExitCode'], 7)
        self.assert_clean(events)

    def test_top_level_sync_timeout(self):
        result, events = self.run_fixture('sync-loop', 8)
        self.assertIn('fixture-entered', result.stdout)
        self.assertEqual(result.returncode, 124)
        self.assertTrue(any(e['event'] == 'test-timeout' for e in events))
        self.assert_clean(events)

    def test_timeout_cleans_descendants(self):
        result, events = self.run_fixture('hang-tree', 8)
        self.assertIn('fixture-descendant=', result.stdout)
        self.assertEqual(result.returncode, 124)
        self.assert_clean(events)

    def test_success_preserved_after_descendant_cleanup(self):
        result, events = self.run_fixture('residual-tree')
        self.assertIn('fixture-descendant=', result.stdout)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(events[-1]['commandExitCode'], 0)
        self.assertTrue(any(e['event'] == 'cleanup-start' and e['force'] for e in events))
        self.assert_clean(events)

    def test_start_failure_is_not_success(self):
        with tempfile.TemporaryDirectory(prefix='test-budget-missing-') as directory:
            result, events = self.invoke([str(Path(directory) / 'missing.exe')])
        self.assertEqual(result.returncode, 125)
        self.assertTrue(any(e['event'] == 'command-start-error' for e in events))
        self.assert_clean(events)

    def test_cmd_exit_and_path_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix='test budget cmd ') as directory:
            command = Path(directory) / 'fake npm.cmd'
            command.write_text('@echo off\r\necho cmd-output\r\nexit /b 7\r\n', encoding='ascii')
            result, events = self.invoke([str(command), 'test'])
        self.assertEqual(result.returncode, 7)
        self.assertIn('cmd-output', result.stdout)
        self.assert_clean(events)

    def test_invalid_timeout_does_not_launch(self):
        for timeout in ('0', '-1', 'nan', 'inf'):
            result, events = self.run_fixture('success', timeout)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(events, [])
            self.assertNotIn('fixture-entered', result.stdout)

    def test_cleanup_failure_cannot_pass(self):
        spec = importlib.util.spec_from_file_location('test_budget', WATCHDOG)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        job = mock.Mock()
        job.active.return_value = 0
        job.stop.side_effect = OSError('injected cleanup error')
        child = mock.Mock()
        child.wait.return_value = 0
        recorded = []
        with mock.patch.object(module, 'OwnedJob', return_value=job), \
                mock.patch.object(module.subprocess, 'Popen', return_value=child), \
                mock.patch.object(module, 'event', side_effect=lambda kind, **kw: recorded.append(kind)):
            self.assertEqual(module.main(['--', 'unused']), 125)
        self.assertIn('cleanup-unconfirmed', recorded)
        job.close.assert_called_once()

    def test_failed_assignment_never_releases_gate(self):
        spec = importlib.util.spec_from_file_location('test_budget', WATCHDOG)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        job = mock.Mock()
        job.attach.side_effect = OSError('injected Job assignment error')
        child = mock.Mock()
        child.poll.return_value = None
        with mock.patch.object(module, 'OwnedJob', return_value=job), \
                mock.patch.object(module.subprocess, 'Popen', return_value=child), \
                mock.patch.object(module, 'event'):
            self.assertEqual(module.main(['--', 'unused']), 125)
        child.stdin.write.assert_not_called()
        child.kill.assert_called_once()
        child.wait.assert_called_once()
        job.close.assert_called_once()


if __name__ == '__main__':
    if sys.argv[1:2] == ['--fixture']:
        sys.exit(fixture(sys.argv[2]))
    unittest.main(testRunner=unittest.TextTestRunner(stream=sys.stdout, verbosity=2))

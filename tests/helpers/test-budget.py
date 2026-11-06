"""Windows CI wall-clock budget for one complete test command.

The native Node runner still owns file selection, concurrency and file timeouts.
Start this helper AFTER acquiring the machine ledger lease. A gated Python child
is assigned to an owned Job before it can launch npm, Node or their descendants.
Only that Job is terminated; no PID/name search or retry is performed.
"""
import argparse
import ctypes
from ctypes import wintypes
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time


def event(kind, **fields):
    print('[test-budget] ' + json.dumps({'event': kind, **fields}), flush=True)


class BasicLimits(ctypes.Structure):
    _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                ('flags', wintypes.DWORD), ('min_ws', ctypes.c_size_t), ('max_ws', ctypes.c_size_t),
                ('active_limit', wintypes.DWORD), ('affinity', ctypes.c_size_t),
                ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]


class IOCounts(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ['read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes']]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [('basic', BasicLimits), ('io', IOCounts), ('process_memory', ctypes.c_size_t),
                ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]


class BasicAccounting(ctypes.Structure):
    _fields_ = [(name, ctypes.c_longlong) for name in ['user', 'kernel', 'period_user', 'period_kernel']] + [
        ('faults', wintypes.DWORD), ('total_processes', wintypes.DWORD),
        ('active_processes', wintypes.DWORD), ('terminated_processes', wintypes.DWORD)]


class OwnedJob:
    def __init__(self):
        self.api = ctypes.WinDLL('kernel32', use_last_error=True)
        for name, args in {
            'CreateJobObjectW': [ctypes.c_void_p, wintypes.LPCWSTR],
            'SetInformationJobObject': [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD],
            'AssignProcessToJobObject': [wintypes.HANDLE, wintypes.HANDLE],
            'TerminateJobObject': [wintypes.HANDLE, wintypes.UINT],
            'QueryInformationJobObject': [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p],
            'CloseHandle': [wintypes.HANDLE],
        }.items():
            getattr(self.api, name).argtypes = args
        self.api.CreateJobObjectW.restype = wintypes.HANDLE
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def attach(self, child):
        if not self.api.AssignProcessToJobObject(self.handle, wintypes.HANDLE(child._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def active(self):
        state = BasicAccounting()
        if not self.api.QueryInformationJobObject(self.handle, 1, ctypes.byref(state), ctypes.sizeof(state), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return state.active_processes

    def stop(self):
        if not self.api.TerminateJobObject(self.handle, 124):
            raise ctypes.WinError(ctypes.get_last_error())
        deadline = time.monotonic() + 20
        while self.active():
            if time.monotonic() >= deadline:
                raise TimeoutError('owned Job cleanup not confirmed within 20 seconds')
            time.sleep(.05)

    def close(self):
        if self.handle:
            if not self.api.CloseHandle(self.handle):
                raise ctypes.WinError(ctypes.get_last_error())
            self.handle = None


def gate():
    # No target, preload or descendant can run before the parent's Job assignment.
    command = json.loads(sys.stdin.readline())
    try:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
    except OSError as error:
        event('command-start-error', errorType=type(error).__name__, errorCode=error.errno)
        return 125
    event('command-start', pid=child.pid)
    return child.wait()


def positive_seconds(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError('timeout must be finite and positive')
    return number


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout-seconds', type=positive_seconds, default=900)
    parser.add_argument('--label', default='tests')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a test command is required after --')
    if os.name != 'nt':
        parser.error('this helper requires Windows Job Objects')
    job, child, attached = None, None, False
    result, child_exit, started = 125, None, None
    try:
        job = OwnedJob()
        child = subprocess.Popen([sys.executable, '-I', '-S', str(Path(__file__).resolve()), '--gate'],
                                 stdin=subprocess.PIPE, text=True,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        job.attach(child)
        attached = True
        started = time.monotonic()
        event('test-start', label=args.label, timeoutSeconds=args.timeout_seconds, gatePid=child.pid)
        child.stdin.write(json.dumps(command) + '\n')
        child.stdin.close()
        try:
            child_exit = child.wait(timeout=max(.001, args.timeout_seconds - (time.monotonic() - started)))
            result = child_exit
        except subprocess.TimeoutExpired:
            result = 124
            event('test-timeout', label=args.label, timeoutSeconds=args.timeout_seconds)
    except Exception as error:
        if result == 0:
            result = 125
        event('watchdog-error', errorType=type(error).__name__, message=str(error))
    finally:
        try:
            if job is not None and attached:
                # A console host may outlive a successful command. Preserve its
                # exit status, but always clear and confirm the complete owned Job.
                before = job.active()
                event('cleanup-start', activeProcesses=before, force=before > 0)
                job.stop()
                child.wait(timeout=5)
                event('cleanup-confirmed', activeProcesses=job.active(), before=before, force=before > 0)
            elif child is not None:
                # Still gated, so it cannot have descendants. Popen retains its handle.
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
        except Exception as error:
            event('cleanup-unconfirmed', errorType=type(error).__name__, message=str(error))
            if result == 0:
                result = 125
        finally:
            if job is not None:
                try:
                    job.close()  # Kill-on-close also protects supervisor termination.
                except Exception as error:
                    event('cleanup-unconfirmed', errorType=type(error).__name__, message=str(error))
                    if result == 0:
                        result = 125
        event('test-end', label=args.label, exitCode=result, commandExitCode=child_exit,
              elapsedMs=round((time.monotonic() - started) * 1000) if started is not None else None)
    return result


if __name__ == '__main__':
    sys.exit(gate() if sys.argv[1:] == ['--gate'] else main())

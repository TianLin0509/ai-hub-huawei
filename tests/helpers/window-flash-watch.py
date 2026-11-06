"""Watches one process tree for visible windows (home-only test helper, Windows).

    python window-flash-watch.py --out result.json [--grace-ms 1500] -- <command> [args...]

The command is started with CREATE_NO_WINDOW, the way Hub starts the company proxy, on a private desktop created
for this run (every process in the tree inherits it). Nothing ever appears on the user's screen, while visibility is
measured the same way: a window shown there is a window that would have been shown. Two detectors run until the
command has exited and the grace time is over:
  * a WinEvent hook on EVENT_OBJECT_SHOW (fires for every window that is shown, however briefly), and
  * a 20 ms poll of EnumDesktopWindows + IsWindowVisible.
A window counts when its owning process is in the tree: the command itself or any process whose parent chain
reaches it (processes are tracked with a 20 ms Toolhelp snapshot, so short-lived ones are remembered).
The result lists only process names and window classes, never titles or command lines.
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import subprocess
import sys
import threading
import time

user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

TH32CS_SNAPPROCESS = 0x2
EVENT_OBJECT_SHOW = 0x8002
WINEVENT_OUTOFCONTEXT = 0x0
WINEVENT_SKIPOWNPROCESS = 0x2
WM_QUIT = 0x12
GA_ROOT = 2
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
DESKTOP_ALL = 0x01FF
GENERIC_ALL = 0x10000000


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [('dwSize', wt.DWORD), ('cntUsage', wt.DWORD), ('th32ProcessID', wt.DWORD),
                ('th32DefaultHeapID', ctypes.c_void_p), ('th32ModuleID', wt.DWORD), ('cntThreads', wt.DWORD),
                ('th32ParentProcessID', wt.DWORD), ('pcPriClassBase', ctypes.c_long), ('dwFlags', wt.DWORD),
                ('szExeFile', ctypes.c_wchar * 260)]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [('cb', wt.DWORD), ('lpReserved', wt.LPWSTR), ('lpDesktop', wt.LPWSTR), ('lpTitle', wt.LPWSTR),
                ('dwX', wt.DWORD), ('dwY', wt.DWORD), ('dwXSize', wt.DWORD), ('dwYSize', wt.DWORD),
                ('dwXCountChars', wt.DWORD), ('dwYCountChars', wt.DWORD), ('dwFillAttribute', wt.DWORD),
                ('dwFlags', wt.DWORD), ('wShowWindow', wt.WORD), ('cbReserved2', wt.WORD),
                ('lpReserved2', ctypes.c_void_p), ('hStdInput', wt.HANDLE), ('hStdOutput', wt.HANDLE),
                ('hStdError', wt.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [('hProcess', wt.HANDLE), ('hThread', wt.HANDLE), ('dwProcessId', wt.DWORD), ('dwThreadId', wt.DWORD)]


WinEventProc = ctypes.WINFUNCTYPE(None, wt.HANDLE, wt.DWORD, wt.HWND, wt.LONG, wt.LONG, wt.DWORD, wt.DWORD)
EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

kernel32.CreateToolhelp32Snapshot.restype = wt.HANDLE
kernel32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wt.BOOL, wt.DWORD,
                                    ctypes.c_void_p, wt.LPCWSTR, ctypes.POINTER(STARTUPINFOW),
                                    ctypes.POINTER(PROCESS_INFORMATION)]
kernel32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
kernel32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
kernel32.CloseHandle.argtypes = [wt.HANDLE]
user32.CreateDesktopW.restype = wt.HANDLE
user32.CreateDesktopW.argtypes = [wt.LPCWSTR, wt.LPCWSTR, ctypes.c_void_p, wt.DWORD, wt.DWORD, ctypes.c_void_p]
user32.SetThreadDesktop.argtypes = [wt.HANDLE]
user32.CloseDesktop.argtypes = [wt.HANDLE]
user32.PostThreadMessageW.argtypes = [wt.DWORD, wt.UINT, wt.WPARAM, wt.LPARAM]
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.GetAncestor.restype = wt.HWND
user32.GetAncestor.argtypes = [wt.HWND, wt.UINT]
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.GetClassNameW.argtypes = [wt.HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.EnumDesktopWindows.argtypes = [wt.HANDLE, EnumProc, wt.LPARAM]
user32.SetWinEventHook.restype = wt.HANDLE
user32.SetWinEventHook.argtypes = [wt.DWORD, wt.DWORD, wt.HMODULE, WinEventProc, wt.DWORD, wt.DWORD, wt.DWORD]


def snapshot():
    out = {}
    h = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not h or h == ctypes.c_void_p(-1).value:
        return out
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(e)
        ok = kernel32.Process32FirstW(h, ctypes.byref(e))
        while ok:
            out[e.th32ProcessID] = (e.th32ParentProcessID, e.szExeFile)
            ok = kernel32.Process32NextW(h, ctypes.byref(e))
    finally:
        kernel32.CloseHandle(h)
    return out


TERMINAL_HOSTS = ('windowsterminal.exe', 'openconsole.exe')


class Tree:
    # On Windows 11 a console that is to be shown may be handed to Windows Terminal (default terminal setting):
    # the window then belongs to a terminal process outside the tree, on the user's desktop. Any terminal host
    # process that appears during the run is reported as a handoff (counted like a visible window).
    def __init__(self, root):
        self.members = {root: 'root'}
        self.lock = threading.Lock()
        self.terminals_before = {pid for pid, (_, name) in snapshot().items() if name.lower() in TERMINAL_HOSTS}
        self.handoffs = {}

    def refresh(self):
        procs = snapshot()
        for pid, (_, name) in procs.items():
            if name.lower() in TERMINAL_HOSTS and pid not in self.terminals_before and pid not in self.handoffs:
                self.handoffs[pid] = name
        with self.lock:
            changed = True
            while changed:
                changed = False
                for pid, (ppid, name) in procs.items():
                    if pid not in self.members and ppid in self.members and pid != ppid:
                        self.members[pid] = name
                        changed = True
            for pid in list(self.members):
                if pid in procs:
                    self.members[pid] = procs[pid][1]

    def name_of(self, pid):
        with self.lock:
            return self.members.get(pid)


def window_info(hwnd):
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    buf = ctypes.create_unicode_buffer(128)
    user32.GetClassNameW(hwnd, buf, 128)
    return pid.value, buf.value


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--grace-ms', type=int, default=1500)
    ap.add_argument('--no-console', action='store_true', help='start the command without any console (DETACHED_PROCESS), like a GUI parent')
    ap.add_argument('--same-desktop', action='store_true', help='debug only: watch the user desktop')
    ap.add_argument('command', nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.command[1:] if a.command and a.command[0] == '--' else a.command
    hits, seen = [], set()
    started = time.time()
    desk_name = 'flashwatch-%d-%d' % (kernel32.GetCurrentProcessId(), int(started * 1000) % 100000000)
    hdesk = None
    if not a.same_desktop:
        hdesk = user32.CreateDesktopW(desk_name, None, None, 0, DESKTOP_ALL | GENERIC_ALL, None)
        if not hdesk:
            raise OSError('CreateDesktop failed: %d' % ctypes.get_last_error())
    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(si)
    si.lpDesktop = desk_name if hdesk else None
    pi = PROCESS_INFORMATION()
    line = ctypes.create_unicode_buffer(subprocess.list2cmdline(cmd))
    if not kernel32.CreateProcessW(None, line, None, None, False, DETACHED_PROCESS if a.no_console else CREATE_NO_WINDOW, None, None,
                                   ctypes.byref(si), ctypes.byref(pi)):
        raise OSError('CreateProcess failed: %d' % ctypes.get_last_error())
    kernel32.CloseHandle(pi.hThread)
    tree = Tree(pi.dwProcessId)

    def record(source, hwnd):
        pid, cls = window_info(hwnd)
        name = tree.name_of(pid)
        if name is None:
            tree.refresh()
            name = tree.name_of(pid)
        if name is None:
            return
        key = (source, int(hwnd or 0))
        if key in seen:
            return
        seen.add(key)
        hits.append({'source': source, 'process': name, 'class': cls, 'ms': int((time.time() - started) * 1000)})

    @WinEventProc
    def on_show(hook, event, hwnd, id_object, id_child, thread, ms):
        if id_object != 0 or not hwnd or user32.GetAncestor(hwnd, GA_ROOT) != hwnd:
            return
        record('show-event', hwnd)

    @EnumProc
    def on_enum(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            record('poll', hwnd)
        return True

    state = {'polls': 0, 'hook': False, 'hookThread': 0}
    hook_ready = threading.Event()

    def hooker():
        if hdesk:
            user32.SetThreadDesktop(hdesk)
        state['hookThread'] = kernel32.GetCurrentThreadId()
        hook = user32.SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, None, on_show, 0, 0,
                                      WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)
        state['hook'] = bool(hook)
        hook_ready.set()
        msg = wt.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        if hook:
            user32.UnhookWinEvent(hook)

    def poller():
        if hdesk:
            user32.SetThreadDesktop(hdesk)
        finished_at = None
        while True:
            tree.refresh()
            if hdesk:
                user32.EnumDesktopWindows(hdesk, on_enum, 0)
            else:
                user32.EnumWindows(on_enum, 0)
            state['polls'] += 1
            if finished_at is None and kernel32.WaitForSingleObject(pi.hProcess, 0) == 0:
                finished_at = time.time()
            if finished_at is not None and (time.time() - finished_at) * 1000 >= a.grace_ms:
                break
            time.sleep(0.02)

    h = threading.Thread(target=hooker, daemon=True)
    h.start()
    hook_ready.wait(5)
    p = threading.Thread(target=poller)
    p.start()
    p.join()
    user32.PostThreadMessageW(state['hookThread'], WM_QUIT, 0, 0)
    h.join(3)
    code = wt.DWORD()
    kernel32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
    kernel32.CloseHandle(pi.hProcess)
    if hdesk:
        user32.CloseDesktop(hdesk)
    names = {}
    for name in tree.members.values():
        names[name] = names.get(name, 0) + 1
    result = {'exitCode': code.value, 'privateDesktop': bool(hdesk), 'hookInstalled': state['hook'],
              'polls': state['polls'], 'elapsedMs': int((time.time() - started) * 1000),
              'treeProcesses': names,
              'visible': hits + [{'source': 'terminal-handoff', 'process': n, 'class': '', 'ms': -1} for n in tree.handoffs.values()]}
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())

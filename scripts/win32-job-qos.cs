// Win32 Job Object + EcoQoS broker for the Hub main process.
// Written in C# 5.0 (Windows PowerShell 5.1 Add-Type): no string interpolation, no null-conditional operator, no expression-bodied members, no name-of operator.
// Protocol: one flat JSON object per stdin line, one flat JSON object per stdout line. EOF on stdin ends the loop.
// Job handles are duplicated into the owner process (the Hub) and the broker closes its own copy, so the broker can exit
// at any time without affecting a job; when the owner dies the kernel closes its handles and KILL_ON_JOB_CLOSE fires.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class HubWin32JobQos {
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_DUP_HANDLE = 0x0040;
    const uint PROCESS_SET_QUOTA = 0x0100;
    const uint PROCESS_SET_INFORMATION = 0x0200;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint DUPLICATE_CLOSE_SOURCE = 0x1;
    const uint DUPLICATE_SAME_ACCESS = 0x2;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectBasicProcessIdList = 3;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int ProcessPowerThrottling = 4;
    const uint PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
    const uint NORMAL_PRIORITY_CLASS = 0x20;
    const uint BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
    const uint TH32CS_SNAPPROCESS = 0x2;
    const int ERROR_MORE_DATA = 234;
    const long EPOCH_FILETIME = 116444736000000000L;
    // Clock granularity slack for the lower observation bound. The upper bound is strict: a process cannot be born after the
    // moment its pid was observed, so any later birth means the pid was recycled.
    const long BIRTH_SLACK_MS = 500;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_POWER_THROTTLING_STATE { public uint Version; public uint ControlMask; public uint StateMask; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W {
        public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessInformation(IntPtr process, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetPriorityClass(IntPtr process, uint priorityClass);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetPriorityClass(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    class Failure : Exception {
        public string Code; public int Win32;
        public Failure(string code, int win32) : base(code) { Code = code; Win32 = win32; }
    }

    // ---- tiny flat JSON ----------------------------------------------------------------
    static readonly Regex Field = new Regex("\"([A-Za-z0-9_]+)\"\\s*:\\s*(\"((?:[^\"\\\\]|\\\\.)*)\"|-?[0-9]+(?:\\.[0-9]+)?|true|false|null)");
    static Dictionary<string, string> Parse(string line) {
        Dictionary<string, string> map = new Dictionary<string, string>();
        foreach (Match m in Field.Matches(line)) map[m.Groups[1].Value] = m.Groups[3].Success ? m.Groups[3].Value : m.Groups[2].Value;
        return map;
    }
    static long Num(Dictionary<string, string> map, string key, long fallback) {
        string raw; long value;
        if (map.TryGetValue(key, out raw) && long.TryParse(raw.Split('.')[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return value;
        return fallback;
    }
    static bool Flag(Dictionary<string, string> map, string key) { string raw; return map.TryGetValue(key, out raw) && raw == "true"; }
    static string Str(Dictionary<string, string> map, string key) { string raw; return map.TryGetValue(key, out raw) ? raw : ""; }
    static string Quote(string value) {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in value ?? "") {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20 || c > 0x7e) sb.Append(string.Format(CultureInfo.InvariantCulture, "\\u{0:x4}", (int)c));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // ---- helpers -----------------------------------------------------------------------
    static long StartMs(IntPtr process) {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return 0;
        return (creation - EPOCH_FILETIME) / 10000;
    }
    // Identity check on the handle we will actually use. expectedStartMs ± toleranceMs is an estimate; minStartMs / maxStartMs are
    // observation bounds (the process cannot be born after the moment its pid was observed), checked with only clock slack.
    static bool BirthOk(long actual, Dictionary<string, string> map) {
        long expected = Num(map, "expectedStartMs", 0), tolerance = Num(map, "toleranceMs", 5000);
        long min = Num(map, "minStartMs", 0), max = Num(map, "maxStartMs", 0);
        bool any = expected > 0 || min > 0 || max > 0;
        if (!any) return true;
        if (actual <= 0) return false;
        if (expected > 0 && Math.Abs(actual - expected) > tolerance) return false;
        if (min > 0 && actual < min - BIRTH_SLACK_MS) return false;
        if (max > 0 && actual > max) return false;
        return true;
    }
    static IntPtr OpenChecked(uint pid, uint access, Dictionary<string, string> map) {
        if (pid == 0) throw new Failure("bad-pid", 0);
        IntPtr process = OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) throw new Failure("open-process", Marshal.GetLastWin32Error());
        if (!BirthOk(StartMs(process), map)) { CloseHandle(process); throw new Failure("start-mismatch", 0); }
        return process;
    }
    static IntPtr OpenOwner(long ownerPid) {
        IntPtr owner = OpenProcess(PROCESS_DUP_HANDLE, false, (uint)ownerPid);
        if (owner == IntPtr.Zero) throw new Failure("open-owner", Marshal.GetLastWin32Error());
        return owner;
    }
    // Copies the owner's job handle into this process. close=true also removes it from the owner (DUPLICATE_CLOSE_SOURCE).
    static IntPtr Borrow(long ownerPid, long jobHandle, bool close) {
        if (jobHandle <= 0) throw new Failure("bad-handle", 0);
        IntPtr owner = OpenOwner(ownerPid);
        try {
            IntPtr local;
            uint options = DUPLICATE_SAME_ACCESS | (close ? DUPLICATE_CLOSE_SOURCE : 0);
            if (!DuplicateHandle(owner, new IntPtr(jobHandle), GetCurrentProcess(), out local, 0, false, options) || local == IntPtr.Zero)
                throw new Failure("duplicate-handle", Marshal.GetLastWin32Error());
            return local;
        } finally { CloseHandle(owner); }
    }
    static List<uint> JobPids(IntPtr job) {
        uint capacity = 64;
        for (int attempt = 0; attempt < 8; attempt++) {
            int bytes = 8 + IntPtr.Size * (int)capacity;
            IntPtr buffer = Marshal.AllocHGlobal(bytes);
            try {
                uint returned;
                bool ok = QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)bytes, out returned);
                int error = ok ? 0 : Marshal.GetLastWin32Error();
                uint assigned = (uint)Marshal.ReadInt32(buffer, 0);
                uint listed = (uint)Marshal.ReadInt32(buffer, 4);
                if (!ok && error != ERROR_MORE_DATA) throw new Failure("query-job", error);
                if (ok && listed >= assigned) {
                    List<uint> pids = new List<uint>();
                    for (int i = 0; i < listed; i++) pids.Add((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                    return pids;
                }
                capacity = Math.Max(capacity * 2, assigned + 16);
            } finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new Failure("query-job", ERROR_MORE_DATA);
    }
    // Descendants of root that already exist (spawned before the root joined the job). A child must be born after its parent,
    // so a stale parent id left behind by a recycled PID is not followed. Returns pid + birth time; the caller re-checks both on the
    // handle it assigns, so a pid recycled between the snapshot and the assignment is not adopted.
    static List<KeyValuePair<uint, long>> Descendants(uint root, long rootStartMs, long ownerPid) {
        List<KeyValuePair<uint, long>> result = new List<KeyValuePair<uint, long>>();
        if (rootStartMs <= 0) return result;
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return result;
        Dictionary<uint, List<uint>> children = new Dictionary<uint, List<uint>>();
        try {
            PROCESSENTRY32W entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            bool more = Process32FirstW(snap, ref entry);
            while (more) {
                List<uint> list;
                if (!children.TryGetValue(entry.th32ParentProcessID, out list)) { list = new List<uint>(); children[entry.th32ParentProcessID] = list; }
                if (entry.th32ProcessID != entry.th32ParentProcessID) list.Add(entry.th32ProcessID);
                more = Process32NextW(snap, ref entry);
            }
        } finally { CloseHandle(snap); }
        Queue<KeyValuePair<uint, long>> queue = new Queue<KeyValuePair<uint, long>>();
        queue.Enqueue(new KeyValuePair<uint, long>(root, rootStartMs));
        HashSet<uint> seen = new HashSet<uint>();
        seen.Add(root);
        while (queue.Count > 0 && result.Count < 4096) {
            KeyValuePair<uint, long> parent = queue.Dequeue();
            List<uint> kids;
            if (!children.TryGetValue(parent.Key, out kids)) continue;
            foreach (uint kid in kids) {
                if (seen.Contains(kid) || kid == (uint)ownerPid) continue;
                IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, kid);
                if (h == IntPtr.Zero) continue;
                long born = StartMs(h);
                CloseHandle(h);
                if (born <= 0 || born + 1 < parent.Value || born + 1 < rootStartMs) continue;
                seen.Add(kid);
                result.Add(new KeyValuePair<uint, long>(kid, born));
                queue.Enqueue(new KeyValuePair<uint, long>(kid, born));
            }
        }
        return result;
    }
    static void Throttle(IntPtr process, bool enabled, ref bool ok) {
        PROCESS_POWER_THROTTLING_STATE state = new PROCESS_POWER_THROTTLING_STATE();
        state.Version = 1;
        // Off hands throttling back to the system default (ControlMask=0) instead of forcing high QoS.
        state.ControlMask = enabled ? PROCESS_POWER_THROTTLING_EXECUTION_SPEED : 0;
        state.StateMask = enabled ? PROCESS_POWER_THROTTLING_EXECUTION_SPEED : 0;
        if (!SetProcessInformation(process, ProcessPowerThrottling, ref state, (uint)Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)))) ok = false;
    }
    // Lowered list wire format: "pid:startMs,pid:startMs".
    static HashSet<string> ParseLowered(string raw) {
        HashSet<string> set = new HashSet<string>();
        foreach (string part in (raw ?? "").Split(',')) { string t = part.Trim(); if (t.Length > 0) set.Add(t); }
        return set;
    }
    static string Tag(uint pid, long startMs) { return string.Format(CultureInfo.InvariantCulture, "{0}:{1}", pid, startMs); }
    static long CpuMs(IntPtr job) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        uint returned;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), out returned)) return -1;
        return (info.TotalUserTime + info.TotalKernelTime) / 10000;
    }
    static string Describe(uint pid) {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return string.Format(CultureInfo.InvariantCulture, "{{\"pid\":{0},\"open\":false}}", pid);
        try {
            PROCESS_POWER_THROTTLING_STATE state = new PROCESS_POWER_THROTTLING_STATE();
            state.Version = 1;
            bool read = GetProcessInformation(process, ProcessPowerThrottling, ref state, (uint)Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)));
            return string.Format(CultureInfo.InvariantCulture, "{{\"pid\":{0},\"open\":true,\"startMs\":{1},\"priorityClass\":{2},\"throttleRead\":{3},\"controlMask\":{4},\"stateMask\":{5}}}",
                pid, StartMs(process), GetPriorityClass(process), read ? "true" : "false", state.ControlMask, state.StateMask);
        } finally { CloseHandle(process); }
    }

    // ---- commands ----------------------------------------------------------------------
    static string Assign(Dictionary<string, string> map) {
        long ownerPid = Num(map, "ownerPid", 0);
        uint pid = (uint)Num(map, "pid", 0);
        IntPtr target = OpenChecked(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, map);
        IntPtr job = IntPtr.Zero, owner = IntPtr.Zero;
        try {
            long rootStart = StartMs(target);
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Failure("create-job", Marshal.GetLastWin32Error());
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            // No BREAKAWAY_OK by default: CREATE_BREAKAWAY_FROM_JOB cannot be used to escape. "breakaway":true is an emergency switch.
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | (Flag(map, "breakaway") ? JOB_OBJECT_LIMIT_BREAKAWAY_OK : 0);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new Failure("set-job-limit", Marshal.GetLastWin32Error());
            // Hand the handle to the owner before anything joins the job: if the hand-over failed after assignment, closing our
            // only handle would fire KILL_ON_JOB_CLOSE on the very process we were asked to protect.
            owner = OpenOwner(ownerPid);
            IntPtr inOwner;
            if (!DuplicateHandle(GetCurrentProcess(), job, owner, out inOwner, 0, false, DUPLICATE_SAME_ACCESS) || inOwner == IntPtr.Zero)
                throw new Failure("duplicate-handle", Marshal.GetLastWin32Error());
            if (!AssignProcessToJobObject(job, target)) {
                int error = Marshal.GetLastWin32Error();
                IntPtr back;
                if (DuplicateHandle(owner, inOwner, GetCurrentProcess(), out back, 0, false, DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS)) CloseHandle(back);
                throw new Failure("assign", error);
            }
            int adopted = 0;
            if (Flag(map, "descendants")) {
                foreach (KeyValuePair<uint, long> kid in Descendants(pid, rootStart, ownerPid)) {
                    IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, kid.Key);
                    if (h == IntPtr.Zero) continue;
                    long born = StartMs(h);
                    if (born == kid.Value && born + 1 >= rootStart && AssignProcessToJobObject(job, h)) adopted++;
                    CloseHandle(h);
                }
            }
            return string.Format(CultureInfo.InvariantCulture, "\"jobHandle\":{0},\"startMs\":{1},\"adopted\":{2}", inOwner.ToInt64(), rootStart, adopted);
        } finally {
            if (owner != IntPtr.Zero) CloseHandle(owner);
            if (job != IntPtr.Zero) CloseHandle(job);
            CloseHandle(target);
        }
    }
    static string Terminate(Dictionary<string, string> map) {
        IntPtr local = Borrow(Num(map, "ownerPid", 0), Num(map, "jobHandle", 0), true);
        try {
            int count = 0;
            try { count = JobPids(local).Count; } catch (Failure) { count = -1; }
            bool done = TerminateJobObject(local, (uint)Num(map, "exitCode", 1));
            int error = done ? 0 : Marshal.GetLastWin32Error();
            return string.Format(CultureInfo.InvariantCulture, "\"terminated\":{0},\"processes\":{1},\"terminateError\":{2}", done ? "true" : "false", count, error);
        } finally { CloseHandle(local); }
    }
    // On: optional CPU guard first (a job that used more than maxCpuPercent of one core over sampleMs is busy; nothing is changed),
    // then EcoQoS for every member and BELOW_NORMAL only for members still at NORMAL; those are reported back as "lowered".
    // Off: clear EcoQoS on every member; NORMAL is restored only for members in the caller's "lowered" list (pid + birth time).
    // Every member is re-checked with IsProcessInJob on the handle that is changed, so a recycled pid outside the job is never touched.
    static string SetJobEco(Dictionary<string, string> map) {
        long ownerPid = Num(map, "ownerPid", 0);
        bool enabled = Flag(map, "enabled");
        IntPtr local = Borrow(ownerPid, Num(map, "jobHandle", 0), false);
        try {
            long maxCpu = Num(map, "maxCpuPercent", 0), sampleMs = Num(map, "sampleMs", 0);
            if (enabled && maxCpu > 0 && sampleMs > 0) {
                long before = CpuMs(local);
                System.Threading.Thread.Sleep((int)Math.Min(sampleMs, 5000));
                long after = CpuMs(local);
                if (before >= 0 && after >= 0) {
                    long percent = (after - before) * 100 / Math.Max(1, sampleMs);
                    if (percent > maxCpu) return string.Format(CultureInfo.InvariantCulture, "\"skipped\":\"cpu-busy\",\"cpuPercent\":{0},\"processes\":0,\"applied\":0,\"failed\":0,\"lowered\":\"\"", percent);
                }
            }
            HashSet<string> restore = ParseLowered(Str(map, "lowered"));
            List<string> lowered = new List<string>();
            int applied = 0, total = 0, failed = 0;
            foreach (uint pid in JobPids(local)) {
                if (pid == ownerPid) continue;
                IntPtr process = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (process == IntPtr.Zero) continue; // exited (or never ours to change)
                try {
                    bool inside;
                    if (!IsProcessInJob(process, local, out inside) || !inside) continue;
                    total++;
                    long born = StartMs(process);
                    bool ok = true;
                    Throttle(process, enabled, ref ok);
                    uint current = GetPriorityClass(process);
                    if (enabled && current == NORMAL_PRIORITY_CLASS) {
                        if (SetPriorityClass(process, BELOW_NORMAL_PRIORITY_CLASS)) lowered.Add(Tag(pid, born)); else ok = false;
                    } else if (!enabled && current == BELOW_NORMAL_PRIORITY_CLASS && restore.Contains(Tag(pid, born))) {
                        if (!SetPriorityClass(process, NORMAL_PRIORITY_CLASS)) ok = false;
                    }
                    if (ok) applied++; else failed++;
                } finally { CloseHandle(process); }
            }
            return string.Format(CultureInfo.InvariantCulture, "\"processes\":{0},\"applied\":{1},\"failed\":{2},\"lowered\":{3},\"cpuMs\":{4}",
                total, applied, failed, Quote(string.Join(",", lowered.ToArray())), CpuMs(local));
        } finally { CloseHandle(local); }
    }
    // Stand-alone process (search child). priority=false leaves its priority class alone; restorePriority=true lifts it back to NORMAL
    // only when this side lowered it (reported as "lowered":true when enabling).
    static string SetPidEco(Dictionary<string, string> map) {
        IntPtr process = OpenChecked((uint)Num(map, "pid", 0), PROCESS_SET_INFORMATION, map);
        try {
            bool enabled = Flag(map, "enabled"), ok = true, lowered = false;
            Throttle(process, enabled, ref ok);
            if (Str(map, "priority") != "false") {
                uint current = GetPriorityClass(process);
                if (enabled && current == NORMAL_PRIORITY_CLASS) { if (SetPriorityClass(process, BELOW_NORMAL_PRIORITY_CLASS)) lowered = true; else ok = false; }
                else if (!enabled && current == BELOW_NORMAL_PRIORITY_CLASS && Flag(map, "restorePriority")) { if (!SetPriorityClass(process, NORMAL_PRIORITY_CLASS)) ok = false; }
            }
            return string.Format(CultureInfo.InvariantCulture, "\"applied\":{0},\"lowered\":{1}", ok ? "true" : "false", lowered ? "true" : "false");
        } finally { CloseHandle(process); }
    }
    static string Cpu(Dictionary<string, string> map) {
        IntPtr local = Borrow(Num(map, "ownerPid", 0), Num(map, "jobHandle", 0), false);
        try { return string.Format(CultureInfo.InvariantCulture, "\"cpuMs\":{0}", CpuMs(local)); } finally { CloseHandle(local); }
    }
    static string Inspect(Dictionary<string, string> map) {
        IntPtr local = Borrow(Num(map, "ownerPid", 0), Num(map, "jobHandle", 0), false);
        try {
            List<string> rows = new List<string>();
            foreach (uint pid in JobPids(local)) rows.Add(Describe(pid));
            return string.Format(CultureInfo.InvariantCulture, "\"processes\":[{0}]", string.Join(",", rows.ToArray()));
        } finally { CloseHandle(local); }
    }
    static string InJob(Dictionary<string, string> map) {
        IntPtr local = Borrow(Num(map, "ownerPid", 0), Num(map, "jobHandle", 0), false);
        IntPtr process = IntPtr.Zero;
        try {
            process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)Num(map, "pid", 0));
            if (process == IntPtr.Zero) throw new Failure("open-process", Marshal.GetLastWin32Error());
            bool inside;
            if (!IsProcessInJob(process, local, out inside)) throw new Failure("is-in-job", Marshal.GetLastWin32Error());
            return string.Format(CultureInfo.InvariantCulture, "\"inJob\":{0}", inside ? "true" : "false");
        } finally { if (process != IntPtr.Zero) CloseHandle(process); CloseHandle(local); }
    }

    static string Handle(string line) {
        Dictionary<string, string> map = Parse(line);
        string id = Str(map, "id");
        string cmd = Str(map, "cmd");
        string head = string.Format(CultureInfo.InvariantCulture, "{{\"id\":{0},\"cmd\":{1}", Quote(id), Quote(cmd));
        try {
            string body;
            if (cmd == "ping") body = string.Format(CultureInfo.InvariantCulture, "\"pid\":{0}", System.Diagnostics.Process.GetCurrentProcess().Id);
            else if (cmd == "assign") body = Assign(map);
            else if (cmd == "terminate") body = Terminate(map);
            else if (cmd == "setJobEco") body = SetJobEco(map);
            else if (cmd == "setPidEco") body = SetPidEco(map);
            else if (cmd == "inspect") body = Inspect(map);
            else if (cmd == "inJob") body = InJob(map);
            else if (cmd == "cpu") body = Cpu(map);
            else if (cmd == "describe") body = string.Format(CultureInfo.InvariantCulture, "\"process\":{0}", Describe((uint)Num(map, "pid", 0)));
            else throw new Failure("unknown-command", 0);
            return head + ",\"ok\":true," + body + "}";
        } catch (Failure failure) {
            return head + string.Format(CultureInfo.InvariantCulture, ",\"ok\":false,\"code\":{0},\"win32Error\":{1}}}", Quote(failure.Code), failure.Win32);
        } catch (Exception error) {
            return head + string.Format(CultureInfo.InvariantCulture, ",\"ok\":false,\"code\":\"exception\",\"message\":{0}}}", Quote(error.Message));
        }
    }

    public static void RunLoop() {
        TextReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        TextWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.WriteLine("{\"ready\":true,\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + "}");
        output.Flush();
        string line;
        while ((line = input.ReadLine()) != null) {
            if (line.Trim().Length == 0) continue;
            output.WriteLine(Handle(line));
            output.Flush();
        }
    }
}

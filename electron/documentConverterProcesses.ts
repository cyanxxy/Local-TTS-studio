import { execFile } from "node:child_process";

/**
 * LiteParse converts Office and OpenDocument files to PDF with LibreOffice
 * (`soffice --headless --convert-to pdf`), and gives every conversion its own
 * throwaway profile, `-env:UserInstallation=file:///…/liteparse-lo-profile-XXXXXX`.
 * That argument is what tells its converter processes apart from everything
 * else this process has started.
 */
export const LITEPARSE_CONVERTER_MARKER = "liteparse-lo-profile-";

const PROFILE_TOKEN = /liteparse-lo-profile-[^\s"'/\\]+/g;
/** Upper bound on one process listing; the quit cap on Windows leaves room for it. */
export const CONVERTER_LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

/** Parses `pid ppid command…` lines, the shape both listings below print. */
export function parseProcessList(output: string): ProcessEntry[] {
  const processes: ProcessEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return processes;
}

/** Every process on the machine with its parent and full command line. */
export function listProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcessEntry[]> {
  const [file, args] = platform === "win32"
    ? ["powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }",
      ]]
    // `-ww`: never cut the command line, which is where the marker sits.
    : ["ps", ["-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "args="]];
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: CONVERTER_LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseProcessList(stdout));
      },
    );
  });
}

/**
 * The LiteParse converter processes `rootPid` started, directly or through a
 * launcher (`soffice` → `oosplash` → `soffice.bin` on Linux, `soffice.exe` →
 * `soffice.bin` on Windows). A process that lost its launcher and was
 * reparented still counts when it shares a matched conversion's profile.
 * Another app's LiteParse conversion uses a profile of its own and is left alone.
 */
export function findLiteParseConverters(processes: readonly ProcessEntry[], rootPid: number): number[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of processes) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  const found = new Set<number>();
  const profiles = new Set<string>();
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid]);
  for (let entry = queue.shift(); entry; entry = queue.shift()) {
    if (seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    if (entry.command.includes(LITEPARSE_CONVERTER_MARKER)) {
      found.add(entry.pid);
      for (const profile of entry.command.match(PROFILE_TOKEN) ?? []) profiles.add(profile);
    }
    queue.push(...(children.get(entry.pid) ?? []));
  }
  for (const entry of processes) {
    if (entry.pid === rootPid || found.has(entry.pid)) continue;
    if ([...profiles].some((profile) => entry.command.includes(profile))) found.add(entry.pid);
  }
  return [...found];
}

export interface StopConvertersOptions {
  rootPid?: number;
  list?: () => Promise<ProcessEntry[]>;
  kill?: (pid: number) => void;
}

/**
 * Kills the converter processes a parse left behind. The parse runs in a worker
 * thread, so LibreOffice is a child of this process, not of the thread:
 * terminating the worker leaves it converting (or hung) for as long as it
 * likes, and it outlives the app. Resolves with the pids it signalled.
 */
export async function stopLiteParseConverters({
  rootPid = process.pid,
  list = listProcesses,
  kill = (pid) => process.kill(pid, "SIGKILL"),
}: StopConvertersOptions = {}): Promise<number[]> {
  const pids = findLiteParseConverters(await list(), rootPid);
  for (const pid of pids) {
    try {
      kill(pid);
    } catch {
      // Already gone between the listing and the kill.
    }
  }
  return pids;
}

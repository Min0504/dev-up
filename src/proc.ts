import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./ui.js";

/** POSIX single-quote shell escaping. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a shell command, capture output. Never throws on non-zero exit. */
export function run(
  cmd: string,
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: opts?.cwd,
      env: opts?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    let timer: NodeJS.Timeout | undefined;
    if (opts?.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(124);
      }, opts.timeoutMs);
    }
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      finish(127);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

/** Run argv directly (no shell), capture output. */
export function runArgv(
  argv: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const [bin, ...args] = argv;
    if (!bin) {
      resolve({ code: 127, stdout: "", stderr: "empty argv" });
      return;
    }
    const child = spawn(bin, args, { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number): void => {
      if (!done) {
        done = true;
        resolve({ code, stdout, stderr });
      }
    };
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    let timer: NodeJS.Timeout | undefined;
    if (opts?.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(124);
      }, opts.timeoutMs);
    }
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      finish(127);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

const binCache = new Map<string, boolean>();

export function commandExists(name: string): boolean {
  const cached = binCache.get(name);
  if (cached !== undefined) return cached;
  const r = spawnSync("/bin/sh", ["-c", `command -v ${shQuote(name)}`], { stdio: "ignore" });
  const ok = r.status === 0;
  binCache.set(name, ok);
  return ok;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Process start time string from ps; stable identity marker against PID reuse. */
export function getLstart(pid: number): string | null {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const s = (r.stdout ?? "").trim();
  return s.length > 0 ? s : null;
}

export function getPgid(pid: number): number | null {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const n = Number.parseInt((r.stdout ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** True if pid is alive AND (when we recorded lstart) it is still the same process. */
export function pidMatches(pid: number | undefined, lstart: string | undefined): boolean {
  if (!pid || !isAlive(pid)) return false;
  if (!lstart) return true;
  const cur = getLstart(pid);
  return cur === null ? true : cur === lstart;
}

export interface SpawnedInfo {
  pid: number;
  pgid: number;
  lstart: string | null;
}

/** Spawn a long-running command detached in its own process group; stdout/stderr appended to logFile. */
export function spawnBackground(
  cmd: string,
  opts: { cwd: string; env: Record<string, string>; logFile: string },
): SpawnedInfo {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  fs.appendFileSync(
    opts.logFile,
    `\n===== devup: start "${cmd}" at ${new Date().toISOString()} =====\n`,
  );
  const fd = fs.openSync(opts.logFile, "a");
  try {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", () => {
      /* surfaces via health/status checks */
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`failed to spawn: ${cmd}`);
    const pid = child.pid;
    return { pid, pgid: pid, lstart: getLstart(pid) };
  } finally {
    fs.closeSync(fd);
  }
}

export type TerminateResult = "terminated" | "killed" | "not-running" | "not-ours";

function killGroupOrPid(pid: number, pgid: number | undefined, signal: NodeJS.Signals): void {
  if (pgid) {
    try {
      process.kill(-pgid, signal);
      return;
    } catch {
      /* fall back to single pid */
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Safely terminate a tracked process (group). Refuses to signal a PID whose
 * start time no longer matches what we recorded (PID was reused by another process).
 */
export async function terminate(opts: {
  pid: number;
  pgid?: number;
  lstart?: string;
  graceSec?: number;
}): Promise<TerminateResult> {
  const { pid, pgid, lstart } = opts;
  const graceMs = Math.max(1, opts.graceSec ?? 10) * 1000;
  if (!isAlive(pid)) return "not-running";
  if (lstart) {
    const cur = getLstart(pid);
    if (cur !== null && cur !== lstart) {
      log.debug(`pid ${pid} lstart mismatch (recorded "${lstart}", now "${cur}") — refusing to kill`);
      return "not-ours";
    }
  }
  killGroupOrPid(pid, pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return "terminated";
    await sleep(150);
  }
  killGroupOrPid(pid, pgid, "SIGKILL");
  await sleep(200);
  return isAlive(pid) ? "terminated" : "killed";
}

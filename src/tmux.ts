import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { commandExists, runArgv, shQuote } from "./proc.js";
import { log } from "./ui.js";

export function tmuxAvailable(): boolean {
  return commandExists("tmux");
}

/** Extra args for every tmux call; DEVUP_TMUX_SOCKET isolates tests from the user's tmux server. */
function baseArgs(): string[] {
  const sock = process.env.DEVUP_TMUX_SOCKET;
  return sock ? ["-L", sock] : [];
}

async function tmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runArgv(["tmux", ...baseArgs(), ...args], { timeoutMs: 10_000 });
}

export async function sessionExists(name: string): Promise<boolean> {
  const r = await tmux(["has-session", "-t", `=${name}`]);
  return r.code === 0;
}

/** Create the session (detached) with an initial shell window if missing. Returns true if newly created. */
export async function ensureSession(name: string, cwd: string, shellWindow: boolean): Promise<boolean> {
  if (await sessionExists(name)) return false;
  const winName = shellWindow ? "shell" : "main";
  const r = await tmux(["new-session", "-d", "-s", name, "-c", cwd, "-n", winName]);
  if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim()}`);
  return true;
}

export interface TmuxWindow {
  id: string;
  name: string;
  panePid: number;
}

export async function listWindows(session: string): Promise<TmuxWindow[]> {
  const r = await tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_id}\t#{window_name}\t#{pane_pid}"]);
  if (r.code !== 0) return [];
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", name = "", pidStr = "0"] = line.split("\t");
      return { id, name, panePid: Number.parseInt(pidStr, 10) || 0 };
    });
}

export interface ServiceWindow {
  windowId: string;
  paneId: string;
  panePid: number;
}

/**
 * Run a service inside a new tmux window. Output is duplicated to `logFile`
 * via tee so devlogs works identically for tmux and background services.
 */
export async function newServiceWindow(opts: {
  session: string;
  windowName: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  logFile: string;
}): Promise<ServiceWindow> {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  fs.appendFileSync(
    opts.logFile,
    `\n===== devup: start "${opts.command}" (tmux) at ${new Date().toISOString()} =====\n`,
  );
  // Only pass project/service-level env explicitly; the tmux server supplies the rest.
  const envPairs = Object.entries(opts.env)
    .map(([k, v]) => `${k}=${shQuote(v)}`)
    .join(" ");
  const envPrefix = envPairs ? `env ${envPairs} ` : "";
  const inner = `${envPrefix}/bin/sh -c ${shQuote(opts.command)} 2>&1 | tee -a ${shQuote(opts.logFile)}`;
  const r = await tmux([
    "new-window",
    "-d",
    "-t",
    `=${opts.session}:`,
    "-n",
    opts.windowName,
    "-c",
    opts.cwd,
    "-P",
    "-F",
    "#{window_id}\t#{pane_id}\t#{pane_pid}",
    inner,
  ]);
  if (r.code !== 0) throw new Error(`tmux new-window failed: ${r.stderr.trim()}`);
  const [windowId = "", paneId = "", pidStr = "0"] = r.stdout.trim().split("\t");
  return { windowId, paneId, panePid: Number.parseInt(pidStr, 10) || 0 };
}

export async function killWindow(windowId: string): Promise<void> {
  await tmux(["kill-window", "-t", windowId]);
}

export async function windowExistsById(session: string, windowId: string): Promise<boolean> {
  const wins = await listWindows(session);
  return wins.some((w) => w.id === windowId);
}

/** Recreate the aggregated logs window tailing the given files. */
export async function ensureLogsWindow(session: string, logFiles: string[], cwd: string): Promise<void> {
  if (logFiles.length === 0) return;
  const wins = await listWindows(session);
  const existing = wins.find((w) => w.name === "logs");
  if (existing) await killWindow(existing.id);
  const cmd = `tail -n 40 -F ${logFiles.map(shQuote).join(" ")}`;
  const r = await tmux(["new-window", "-d", "-t", `=${session}:`, "-n", "logs", "-c", cwd, cmd]);
  if (r.code !== 0) log.debug(`tmux logs window failed: ${r.stderr.trim()}`);
}

export async function killSession(name: string): Promise<void> {
  await tmux(["kill-session", "-t", `=${name}`]);
}

/** Attach (or switch when already inside tmux). Blocks until the user detaches. */
export function attachSession(name: string): void {
  const args = [...baseArgs()];
  if (process.env.TMUX) {
    spawnSync("tmux", [...args, "switch-client", "-t", `=${name}`], { stdio: "inherit" });
  } else {
    spawnSync("tmux", [...args, "attach-session", "-t", `=${name}`], { stdio: "inherit" });
  }
}

export function attachHint(session: string): string {
  return process.env.TMUX ? `tmux switch-client -t ${session}` : `tmux attach -t ${session}`;
}

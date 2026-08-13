import * as path from "node:path";
import type { Service } from "./config.js";
import { runArgv } from "./proc.js";

let daemonCache: boolean | null = null;

export async function daemonUp(force = false): Promise<boolean> {
  if (!force && daemonCache !== null) return daemonCache;
  const r = await runArgv(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 5000 });
  daemonCache = r.code === 0 && r.stdout.trim().length > 0;
  return daemonCache;
}

export function dockerStartHint(): string {
  return `Docker daemon is not running. Start it with: open -a Docker  (Docker Desktop)`;
}

/** Directory in which compose commands run, and the -f args if an explicit file was set. */
export function composeContext(svc: Service): { cwd: string; fileArgs: string[] } {
  if (svc.composeFile) {
    return { cwd: path.dirname(svc.composeFile), fileArgs: ["-f", svc.composeFile] };
  }
  return { cwd: svc.cwd, fileArgs: [] };
}

async function compose(svc: Service, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const { cwd, fileArgs } = composeContext(svc);
  return runArgv(["docker", "compose", ...fileArgs, ...args], { cwd, timeoutMs });
}

export async function composeUp(svc: Service): Promise<void> {
  const name = svc.composeService;
  if (!name) throw new Error(`service ${svc.name}: no compose_service defined`);
  const r = await compose(svc, ["up", "-d", name]);
  if (r.code !== 0) {
    throw new Error(`docker compose up -d ${name} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
}

export async function composeStop(svc: Service): Promise<void> {
  const name = svc.composeService;
  if (!name) return;
  const r = await compose(svc, ["stop", name], 60_000);
  if (r.code !== 0) {
    throw new Error(`docker compose stop ${name} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
}

export async function composeRestart(svc: Service): Promise<void> {
  const name = svc.composeService;
  if (!name) return;
  const r = await compose(svc, ["restart", name], 120_000);
  if (r.code !== 0) {
    throw new Error(`docker compose restart ${name} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
}

export interface ContainerInfo {
  name: string;
  state: string; // running | exited | created | paused | restarting | dead
  health?: string; // healthy | unhealthy | starting
  exitCode?: number;
  publishedPorts: number[];
}

/** Inspect the compose service's container. Returns null when no container exists. */
export async function composePs(svc: Service): Promise<ContainerInfo | null> {
  const name = svc.composeService;
  if (!name) return null;
  const r = await compose(svc, ["ps", "--all", "--format", "json", name], 15_000);
  if (r.code !== 0) return null;
  const text = r.stdout.trim();
  if (!text) return null;

  let rows: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // NDJSON (one JSON object per line) — the current compose v2 format
    rows = text
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null);
  }
  const row = rows[0] as
    | {
        Name?: string;
        State?: string;
        Health?: string;
        ExitCode?: number;
        Publishers?: { PublishedPort?: number }[] | null;
      }
    | undefined;
  if (!row) return null;
  const ports = (row.Publishers ?? [])
    .map((p) => p.PublishedPort ?? 0)
    .filter((p) => p > 0);
  return {
    name: row.Name ?? name,
    state: (row.State ?? "unknown").toLowerCase(),
    health: row.Health ? row.Health.toLowerCase() : undefined,
    exitCode: row.ExitCode,
    publishedPorts: [...new Set(ports)],
  };
}

/** Run a command inside the compose service container (used by health probes). */
export async function composeExec(svc: Service, cmd: string, timeoutMs = 8000): Promise<{ code: number; stdout: string }> {
  const name = svc.composeService;
  if (!name) return { code: 1, stdout: "" };
  const { cwd, fileArgs } = composeContext(svc);
  const r = await runArgv(["docker", "compose", ...fileArgs, "exec", "-T", name, "/bin/sh", "-c", cmd], {
    cwd,
    timeoutMs,
  });
  return { code: r.code, stdout: r.stdout };
}

/** argv for `docker compose logs`, spawned with stdio inherit by the logs command. */
export function composeLogsArgv(svc: Service, opts: { follow: boolean; lines: number }): { argv: string[]; cwd: string } {
  const { cwd, fileArgs } = composeContext(svc);
  const argv = ["docker", "compose", ...fileArgs, "logs", "--tail", String(opts.lines)];
  if (opts.follow) argv.push("-f");
  if (svc.composeService) argv.push(svc.composeService);
  return { argv, cwd };
}

export function resetDaemonCache(): void {
  daemonCache = null;
}

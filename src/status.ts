import type { Project, Service, ServiceType } from "./config.js";
import { loadProjectFromFile, listRegisteredProjects, ConfigError } from "./config.js";
import { composePs, daemonUp } from "./docker.js";
import { probe } from "./health.js";
import { pidMatches, runArgv } from "./proc.js";
import type { ProjectState, ServiceState } from "./state.js";
import { listStateNames, loadState } from "./state.js";
import { listWindows, sessionExists, tmuxAvailable, attachHint } from "./tmux.js";
import { c, fmtDuration, log, shortenHome, sym, table } from "./ui.js";

export type LiveStatus = "healthy" | "running" | "starting" | "unhealthy" | "stopped" | "failed";

export interface ServiceLive {
  name: string;
  type: ServiceType;
  status: LiveStatus;
  detail: string;
  pid?: number;
  ports: number[];
  uptimeMs?: number;
}

export interface GitInfo {
  branch: string;
  dirty: boolean;
}

export interface ProjectLive {
  name: string;
  root: string;
  configPath: string;
  git?: GitInfo;
  tmuxSession?: string;
  tmuxWindows?: string[];
  services: ServiceLive[];
}

function portsOf(svc: Service, extra: number[] = []): number[] {
  const ports = new Set<number>(extra);
  const hc = svc.healthcheck;
  if (hc?.port) ports.add(hc.port);
  if (hc?.url) {
    try {
      const u = new URL(hc.url);
      if (u.port) ports.add(Number(u.port));
    } catch {
      /* ignore bad url */
    }
  }
  const envPort = svc.env.PORT;
  if (envPort && /^\d+$/.test(envPort)) ports.add(Number(envPort));
  return [...ports].sort((a, b) => a - b);
}

function uptimeOf(st: ServiceState | undefined): number | undefined {
  if (!st?.startedAt) return undefined;
  const t = Date.parse(st.startedAt);
  return Number.isFinite(t) ? Date.now() - t : undefined;
}

/** Compute the live status of one service by inspecting real processes/containers. */
export async function serviceLive(
  svc: Service,
  st: ServiceState | undefined,
  project: Project,
  opts: { probeHealth: boolean },
): Promise<ServiceLive> {
  const base: ServiceLive = {
    name: svc.name,
    type: svc.type,
    status: "stopped",
    detail: "",
    ports: portsOf(svc),
  };

  if (svc.type === "script") {
    if (st?.lastRunAt) {
      if (st.lastExitCode === 0) {
        base.detail = `last run ok (${st.lastRunAt.slice(0, 19).replace("T", " ")})`;
      } else if (st.lastExitCode !== undefined) {
        base.status = "failed";
        base.detail = `last run exit ${st.lastExitCode}`;
      }
    } else {
      base.detail = "not run yet";
    }
    return base;
  }

  if (svc.type === "docker") {
    if (!(await daemonUp())) {
      base.detail = "docker daemon not running";
      return base;
    }
    const info = await composePs(svc);
    if (!info) {
      base.detail = "no container";
      return base;
    }
    base.ports = portsOf(svc, info.publishedPorts);
    base.uptimeMs = uptimeOf(st);
    if (info.state === "running") {
      const ownProbe = svc.healthcheck && svc.healthcheck.type !== "docker";
      if (ownProbe && opts.probeHealth) {
        // A user-defined probe is more current than docker's periodic health status.
        const ok = await probe(svc, project);
        base.status = ok ? "healthy" : "unhealthy";
        if (!ok) base.detail = "health probe failing";
      } else if (info.health === "unhealthy") {
        base.status = "unhealthy";
        base.detail = "container unhealthy";
      } else if (info.health === "starting") {
        base.status = "starting";
        base.detail = "container health: starting";
      } else if (info.health === "healthy") {
        base.status = "healthy";
      } else {
        base.status = "running";
      }
      base.detail ||= info.name;
    } else if (info.state === "exited") {
      if ((info.exitCode ?? 0) !== 0) {
        base.status = "failed";
        base.detail = `container exited (${info.exitCode})`;
      } else {
        base.detail = "container stopped";
      }
    } else {
      base.status = "starting";
      base.detail = `container ${info.state}`;
    }
    return base;
  }

  // command
  if (!st || st.pid === undefined) {
    base.detail = "";
    return base;
  }
  base.pid = st.pid;
  const alive = pidMatches(st.pid, st.lstart);
  if (!alive) {
    base.status = "failed";
    base.detail = "process exited unexpectedly (see devlogs)";
    base.pid = undefined;
    return base;
  }
  base.uptimeMs = uptimeOf(st);
  if (svc.healthcheck && opts.probeHealth) {
    const ok = await probe(svc, project);
    base.status = ok ? "healthy" : "unhealthy";
    if (!ok) base.detail = "process alive but health probe failing";
  } else {
    base.status = "running";
  }
  if (!base.detail) base.detail = st.runMode === "tmux" ? "tmux" : "";
  return base;
}

async function gitInfo(root: string): Promise<GitInfo | undefined> {
  const branch = await runArgv(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 3000 });
  if (branch.code !== 0) return undefined;
  const status = await runArgv(["git", "-C", root, "status", "--porcelain"], { timeoutMs: 5000 });
  return { branch: branch.stdout.trim(), dirty: status.code === 0 && status.stdout.trim().length > 0 };
}

export async function gatherProject(project: Project, opts: { probeHealth: boolean }): Promise<ProjectLive> {
  const st = loadState(project.name);
  const [git, services] = await Promise.all([
    gitInfo(project.root),
    Promise.all(project.services.map((s) => serviceLive(s, st?.services[s.name], project, opts))),
  ]);
  const out: ProjectLive = {
    name: project.name,
    root: project.root,
    configPath: project.configPath,
    services,
  };
  if (git) out.git = git;
  if (tmuxAvailable() && (await sessionExists(project.tmux.session))) {
    out.tmuxSession = project.tmux.session;
    out.tmuxWindows = (await listWindows(project.tmux.session)).map((w) => w.name);
  }
  return out;
}

export function statusDot(s: LiveStatus): string {
  switch (s) {
    case "healthy":
      return sym.dotOn();
    case "running":
      return sym.dotOn();
    case "starting":
      return sym.dotHalf();
    case "unhealthy":
      return sym.dotErr();
    case "failed":
      return sym.dotErr();
    case "stopped":
      return sym.dotOff();
  }
}

export function statusText(s: LiveStatus): string {
  switch (s) {
    case "healthy":
      return c.green("healthy");
    case "running":
      return c.green("running");
    case "starting":
      return c.yellow("starting");
    case "unhealthy":
      return c.red("unhealthy");
    case "failed":
      return c.red("failed");
    case "stopped":
      return c.gray("stopped");
  }
}

export function renderProjectLive(live: ProjectLive): string {
  const lines: string[] = [];
  const gitPart = live.git
    ? `  ${c.magenta(live.git.branch)}${live.git.dirty ? c.yellow(" *") : ""}`
    : "";
  lines.push(`${c.bold(live.name)}  ${c.dim(shortenHome(live.root))}${gitPart}`);
  lines.push("");
  const rows = live.services.map((s) => [
    `${statusDot(s.status)} ${s.name}`,
    c.dim(s.type),
    s.ports.length > 0 ? s.ports.map((p) => `:${p}`).join(" ") : "",
    statusText(s.status),
    s.uptimeMs !== undefined ? c.dim(`up ${fmtDuration(s.uptimeMs)}`) : "",
    s.pid !== undefined ? c.dim(`pid ${s.pid}`) : "",
    s.detail ? c.dim(s.detail) : "",
  ]);
  lines.push(table(rows, { indent: "  " }));
  lines.push("");
  if (live.tmuxSession) {
    lines.push(
      `  tmux: ${c.cyan(live.tmuxSession)} (${(live.tmuxWindows ?? []).join(", ")})  ${c.dim(attachHint(live.tmuxSession))}`,
    );
  }
  return lines.join("\n");
}

export function toJson(live: ProjectLive): string {
  return JSON.stringify(
    {
      project: live.name,
      root: live.root,
      config: live.configPath,
      git: live.git ?? null,
      tmux: live.tmuxSession ? { session: live.tmuxSession, windows: live.tmuxWindows ?? [] } : null,
      services: live.services.map((s) => ({
        name: s.name,
        type: s.type,
        status: s.status,
        detail: s.detail || null,
        pid: s.pid ?? null,
        ports: s.ports,
        uptimeSec: s.uptimeMs !== undefined ? Math.floor(s.uptimeMs / 1000) : null,
      })),
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

/** `devstatus` with no project: one-line summary per known project. */
export async function overview(json: boolean): Promise<void> {
  const names = new Map<string, string>(); // name -> configPath
  for (const p of listRegisteredProjects()) names.set(p.name, p.configPath);
  for (const n of listStateNames()) {
    if (!names.has(n)) {
      const st = loadState(n);
      if (st) names.set(n, st.configPath);
    }
  }
  if (names.size === 0) {
    log.info(`no projects registered. Create one: ${c.cyan("dev init <name>")}`);
    return;
  }
  const rows: string[][] = [];
  const jsonOut: unknown[] = [];
  for (const [name, configPath] of names) {
    let project: Project;
    try {
      project = loadProjectFromFile(configPath);
    } catch (e) {
      const msg = e instanceof ConfigError ? e.problems[0] ?? "config error" : String(e);
      rows.push([`${sym.fail()} ${name}`, "", c.red(`config error: ${msg}`)]);
      continue;
    }
    const live = await gatherProject(project, { probeHealth: false });
    const up = live.services.filter((s) => s.status === "running" || s.status === "healthy").length;
    const total = live.services.filter((s) => s.type !== "script").length;
    const failed = live.services.filter((s) => s.status === "failed" || s.status === "unhealthy").length;
    const dot = failed > 0 ? sym.dotErr() : up === 0 ? sym.dotOff() : up >= total ? sym.dotOn() : sym.dotHalf();
    rows.push([
      `${dot} ${name}`,
      `${up}/${total} running${failed > 0 ? c.red(` ${failed} failed`) : ""}`,
      live.tmuxSession ? c.cyan(`tmux:${live.tmuxSession}`) : "",
      c.dim(shortenHome(project.root)),
    ]);
    jsonOut.push({
      project: name,
      running: up,
      total,
      failed,
      tmux: live.tmuxSession ?? null,
      root: project.root,
    });
  }
  if (json) log.info(JSON.stringify(jsonOut, null, 2));
  else log.info(table(rows));
}

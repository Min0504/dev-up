import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Project, Service } from "./config.js";
import {
  dependencyClosure,
  dependentClosure,
  serviceEnv,
  topoLevels,
} from "./config.js";
import {
  composePs,
  composeRestart,
  composeStop,
  composeUp,
  daemonUp,
  dockerStartHint,
} from "./docker.js";
import { healthLabel, waitHealthy } from "./health.js";
import { logsDir, ensureDir } from "./paths.js";
import { commandExists, getLstart, pidMatches, run, spawnBackground, terminate } from "./proc.js";
import type { ProjectState, ServiceState } from "./state.js";
import { deleteState, loadState, newState, saveState } from "./state.js";
import {
  attachSession,
  attachHint,
  ensureLogsWindow,
  ensureSession,
  killSession,
  killWindow,
  newServiceWindow,
  sessionExists,
  tmuxAvailable,
} from "./tmux.js";
import { c, fmtDuration, log, sym } from "./ui.js";
import { gatherProject, renderProjectLive } from "./status.js";

export interface UpOptions {
  only?: string[];
  noDeps?: boolean;
  noTmux?: boolean;
  attach?: boolean;
  forceRestart?: boolean;
}

export interface DownOptions {
  only?: string[];
  keepTmux?: boolean;
}

function svcLogFile(project: Project, svc: Service): string {
  return path.join(logsDir(project.name), `${svc.name}.log`);
}

function logTail(file: string, lines = 15): string[] {
  try {
    const text = fs.readFileSync(file, "utf8");
    const all = text.split("\n");
    while (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all.slice(-lines);
  } catch {
    return [];
  }
}

function printFailureContext(project: Project, svc: Service): void {
  const file = svcLogFile(project, svc);
  const tail = logTail(file);
  if (tail.length === 0) return;
  log.info(c.dim(`  ── last log lines (${svc.name}) ──`));
  for (const line of tail) log.info(c.dim(`  │ ${line}`));
  log.info(c.dim(`  └─ full log: devlogs ${project.name} ${svc.name}`));
}

/** Resolve which services an up/down operation applies to. */
function selectServices(
  project: Project,
  only: string[] | undefined,
  mode: "up" | "down",
  noDeps: boolean,
): Service[] {
  const byName = new Map(project.services.map((s) => [s.name, s]));
  if (only && only.length > 0) {
    for (const n of only) {
      if (!byName.has(n)) {
        throw new Error(`unknown service "${n}" (services: ${project.services.map((s) => s.name).join(", ")})`);
      }
    }
    const names = noDeps
      ? new Set(only)
      : mode === "up"
        ? dependencyClosure(project.services, only)
        : dependentClosure(project.services, only);
    return project.services.filter((s) => names.has(s.name));
  }
  return mode === "up" ? project.services.filter((s) => s.autoStart) : [...project.services];
}

async function preflight(project: Project, selected: Service[]): Promise<void> {
  if (!fs.existsSync(project.root)) {
    throw new Error(
      `project root does not exist: ${project.root}\n` +
        `  Fix the "root" path in ${project.configPath} (clone the repo first on a new machine).`,
    );
  }
  for (const svc of selected) {
    if (!fs.existsSync(svc.cwd)) {
      throw new Error(`services.${svc.name}: cwd does not exist: ${svc.cwd}`);
    }
  }
  const needsDocker = selected.some((s) => s.type === "docker");
  const checks = [...project.checks];
  for (const check of checks) {
    if (check === "docker" || check === "docker-daemon") continue; // handled below
    if (!commandExists(check)) {
      throw new Error(`required tool "${check}" not found in PATH (declared in checks:)`);
    }
  }
  if (needsDocker || checks.includes("docker") || checks.includes("docker-daemon")) {
    if (!commandExists("docker")) throw new Error(`docker CLI not found in PATH`);
    if (!(await daemonUp(true))) throw new Error(dockerStartHint());
  }
}

interface StartOutcome {
  ok: boolean;
  skipped?: boolean;
}

async function runScript(project: Project, svc: Service, state: ProjectState): Promise<StartOutcome> {
  log.step(svc.name, `running script: ${c.dim(svc.command ?? "")}`);
  const started = Date.now();
  const code = await new Promise<number>((resolve) => {
    const child = spawn("/bin/sh", ["-c", svc.command ?? "true"], {
      cwd: svc.cwd,
      env: serviceEnv(project, svc),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const emit = (d: Buffer): void => {
      for (const line of d.toString().split("\n")) {
        if (line.trim() !== "") log.info(c.dim(`  │ ${line}`));
      }
    };
    child.stdout.on("data", emit);
    child.stderr.on("data", emit);
    child.on("error", () => resolve(127));
    child.on("close", (codeArg) => resolve(codeArg ?? 1));
  });
  state.services[svc.name] = {
    name: svc.name,
    type: svc.type,
    runMode: "script",
    lastExitCode: code,
    lastRunAt: new Date().toISOString(),
  };
  saveState(state);
  if (code === 0) {
    log.step(svc.name, `${sym.ok()} script done ${c.dim(`(${fmtDuration(Date.now() - started)})`)}`);
    return { ok: true };
  }
  log.step(svc.name, `${sym.fail()} script failed with exit code ${code}`);
  return { ok: false };
}

async function startDocker(project: Project, svc: Service, state: ProjectState): Promise<StartOutcome> {
  const existing = await composePs(svc);
  const alreadyRunning = existing?.state === "running";
  if (alreadyRunning) {
    log.step(svc.name, `already running ${c.dim(`(${existing.name})`)}`);
  } else {
    const label = svc.command ?? `docker compose up -d ${svc.composeService}`;
    log.step(svc.name, `starting ${c.dim(`(${label})`)}`);
    try {
      if (svc.command) {
        const r = await run(svc.command, { cwd: svc.cwd, env: serviceEnv(project, svc), timeoutMs: 180_000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } else {
        await composeUp(svc);
      }
    } catch (e) {
      log.step(svc.name, `${sym.fail()} failed to start: ${(e as Error).message}`);
      return { ok: false };
    }
  }
  state.services[svc.name] = {
    name: svc.name,
    type: svc.type,
    runMode: "docker",
    composeService: svc.composeService,
    composeFile: svc.composeFile,
    composeDir: svc.cwd,
    startedAt: alreadyRunning ? state.services[svc.name]?.startedAt ?? new Date().toISOString() : new Date().toISOString(),
  };
  saveState(state);

  if (svc.healthcheck) {
    const res = await waitHealthy(svc, project);
    if (!res.ok) {
      log.step(svc.name, `${sym.fail()} not healthy after ${fmtDuration(res.elapsedMs)} (${healthLabel(svc.healthcheck)})`);
      log.info(c.dim(`  └─ inspect: devlogs ${project.name} ${svc.name}`));
      return { ok: false };
    }
    log.step(svc.name, `${sym.ok()} healthy ${c.dim(`(${healthLabel(svc.healthcheck)}, ${fmtDuration(res.elapsedMs)})`)}`);
  } else if (!alreadyRunning) {
    log.step(svc.name, `${sym.ok()} started`);
  }
  return { ok: true };
}

async function startCommand(
  project: Project,
  svc: Service,
  state: ProjectState,
  wantTmux: boolean,
  forceRestart: boolean,
): Promise<StartOutcome> {
  const prev = state.services[svc.name];
  if (prev?.pid !== undefined && pidMatches(prev.pid, prev.lstart)) {
    if (!forceRestart) {
      log.step(svc.name, `already running ${c.dim(`(pid ${prev.pid})`)}`);
      return { ok: true };
    }
    await stopCommand(project, svc, state, prev);
  }

  const logFile = svcLogFile(project, svc);
  const env = serviceEnv(project, svc);
  const useTmux = svc.tmux && wantTmux;
  const entry: ServiceState = {
    name: svc.name,
    type: svc.type,
    runMode: useTmux ? "tmux" : "background",
    logFile,
    startedAt: new Date().toISOString(),
  };

  try {
    if (useTmux) {
      await ensureSession(project.tmux.session, project.root, project.tmux.shellWindow);
      const win = await newServiceWindow({
        session: project.tmux.session,
        windowName: svc.name,
        command: svc.command ?? "true",
        cwd: svc.cwd,
        env: { ...project.env, ...svc.env },
        logFile,
      });
      entry.tmuxWindowId = win.windowId;
      entry.tmuxPaneId = win.paneId;
      entry.pid = win.panePid;
      entry.pgid = win.panePid;
      entry.lstart = getLstart(win.panePid) ?? undefined;
      log.step(svc.name, `started in tmux window ${c.cyan(svc.name)} ${c.dim(`(pid ${win.panePid})`)}`);
    } else {
      const info = spawnBackground(svc.command ?? "true", { cwd: svc.cwd, env, logFile });
      entry.pid = info.pid;
      entry.pgid = info.pgid;
      entry.lstart = info.lstart ?? undefined;
      log.step(svc.name, `started ${c.dim(`(pid ${info.pid}, log: ${path.basename(logFile)})`)}`);
    }
  } catch (e) {
    log.step(svc.name, `${sym.fail()} failed to spawn: ${(e as Error).message}`);
    return { ok: false };
  }
  state.services[svc.name] = entry;
  saveState(state);

  const alive = (): boolean => pidMatches(entry.pid, entry.lstart);

  // Even without a healthcheck, catch commands that die instantly (typo, missing dep).
  await new Promise((r) => setTimeout(r, 500));
  if (!alive()) {
    log.step(svc.name, `${sym.fail()} process exited immediately`);
    printFailureContext(project, svc);
    return { ok: false };
  }

  if (svc.healthcheck) {
    log.step(svc.name, `waiting for health ${c.dim(`(${healthLabel(svc.healthcheck)}, timeout ${svc.healthcheck.timeoutSec}s)`)}`);
    const res = await waitHealthy(svc, project, alive);
    if (!res.ok) {
      const reason = alive() ? `not healthy after ${fmtDuration(res.elapsedMs)}` : "process died while waiting for health";
      log.step(svc.name, `${sym.fail()} ${reason}`);
      printFailureContext(project, svc);
      return { ok: false };
    }
    log.step(svc.name, `${sym.ok()} healthy ${c.dim(`(${healthLabel(svc.healthcheck)}, ${fmtDuration(res.elapsedMs)})`)}`);
  }
  return { ok: true };
}

async function stopCommand(
  project: Project,
  svc: Service,
  state: ProjectState,
  entry: ServiceState,
): Promise<void> {
  if (entry.pid === undefined) {
    delete state.services[svc.name];
    saveState(state);
    return;
  }
  if (svc.stop) {
    log.step(svc.name, `running stop command: ${c.dim(svc.stop)}`);
    await run(svc.stop, { cwd: svc.cwd, env: serviceEnv(project, svc), timeoutMs: svc.stopGraceSec * 1000 });
  }
  const result = await terminate({
    pid: entry.pid,
    pgid: entry.pgid,
    lstart: entry.lstart,
    graceSec: svc.stopGraceSec,
  });
  switch (result) {
    case "terminated":
      log.step(svc.name, `stopped ${c.dim(`(pid ${entry.pid})`)}`);
      break;
    case "killed":
      log.step(svc.name, `stopped ${c.yellow("(forced SIGKILL after grace period)")}`);
      break;
    case "not-running":
      log.step(svc.name, c.dim("was not running"));
      break;
    case "not-ours":
      log.step(
        svc.name,
        `${sym.warn()} pid ${entry.pid} now belongs to a different process — left untouched (stale state cleared)`,
      );
      break;
  }
  if (entry.tmuxWindowId && tmuxAvailable() && (await sessionExists(project.tmux.session))) {
    await killWindow(entry.tmuxWindowId);
  }
  delete state.services[svc.name];
  saveState(state);
}

async function stopDocker(project: Project, svc: Service, state: ProjectState): Promise<boolean> {
  if (!(await daemonUp())) {
    log.step(svc.name, `${sym.warn()} docker daemon not running — skipping container stop`);
    delete state.services[svc.name];
    saveState(state);
    return true;
  }
  try {
    if (svc.stop) {
      const r = await run(svc.stop, { cwd: svc.cwd, env: serviceEnv(project, svc), timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    } else {
      await composeStop(svc);
    }
    log.step(svc.name, "stopped");
    delete state.services[svc.name];
    saveState(state);
    return true;
  } catch (e) {
    log.step(svc.name, `${sym.fail()} stop failed: ${(e as Error).message}`);
    return false;
  }
}

/** Bring a project up. Returns a process exit code. */
export async function up(project: Project, opts: UpOptions): Promise<number> {
  const selected = selectServices(project, opts.only, "up", opts.noDeps ?? false);
  if (selected.length === 0) {
    log.warn("nothing to start (all services have auto_start: false?)");
    return 0;
  }
  await preflight(project, selected);

  const wantTmux = project.tmux.enabled && !opts.noTmux && tmuxAvailable();
  if (project.tmux.enabled && !tmuxAvailable() && !opts.noTmux) {
    log.warn("tmux not installed — services will run as background processes (brew install tmux)");
  }

  const state = loadState(project.name) ?? newState(project.name, project.configPath);
  state.configPath = project.configPath;
  if (wantTmux) state.tmuxSession = project.tmux.session;

  const onInterrupt = (): void => {
    saveState(state);
    log.info("");
    log.warn(`interrupted — partial state saved. Clean up with: devdown ${project.name}`);
    process.exit(130);
  };
  process.on("SIGINT", onInterrupt);

  log.info(`${c.bold(`devup ${project.name}`)} ${c.dim(`(${selected.length} services)`)}`);
  const levels = topoLevels(selected);
  const failed = new Set<string>();

  for (const level of levels) {
    const results = await Promise.all(
      level.map(async (svc): Promise<[string, StartOutcome]> => {
        const badDep = svc.dependsOn.find((d) => failed.has(d));
        if (badDep) {
          log.step(svc.name, `${sym.warn()} skipped (dependency "${badDep}" failed)`);
          return [svc.name, { ok: false, skipped: true }];
        }
        const missingDeps = svc.dependsOn.filter((d) => !selected.some((s) => s.name === d));
        if (missingDeps.length > 0) {
          log.debug(`${svc.name}: deps not in selection (assumed already running): ${missingDeps.join(", ")}`);
        }
        try {
          switch (svc.type) {
            case "script":
              return [svc.name, await runScript(project, svc, state)];
            case "docker":
              return [svc.name, await startDocker(project, svc, state)];
            case "command":
              return [svc.name, await startCommand(project, svc, state, wantTmux, opts.forceRestart ?? false)];
          }
        } catch (e) {
          log.step(svc.name, `${sym.fail()} ${(e as Error).message}`);
          return [svc.name, { ok: false }];
        }
      }),
    );
    for (const [name, outcome] of results) {
      if (!outcome.ok) failed.add(name);
    }
  }

  if (wantTmux) {
    await ensureSession(project.tmux.session, project.root, project.tmux.shellWindow);
    if (project.tmux.logsWindow) {
      const bgLogs = Object.values(state.services)
        .filter((s) => s.runMode === "background" && s.logFile && fs.existsSync(s.logFile))
        .map((s) => s.logFile as string);
      await ensureLogsWindow(project.tmux.session, bgLogs, project.root);
    }
  }
  saveState(state);
  process.removeListener("SIGINT", onInterrupt);

  log.info("");
  const live = await gatherProject(project, { probeHealth: true });
  log.info(renderProjectLive(live));

  if (failed.size > 0) {
    log.info("");
    log.error(`${failed.size} service(s) failed: ${[...failed].join(", ")}`);
    return 1;
  }
  if (wantTmux && (opts.attach || project.tmux.attach)) {
    attachSession(project.tmux.session);
  } else if (wantTmux) {
    log.info("");
    log.info(c.dim(`attach: ${attachHint(project.tmux.session)}`));
  }
  return 0;
}

/** Bring a project down. Returns a process exit code. */
export async function down(project: Project, opts: DownOptions): Promise<number> {
  const selected = selectServices(project, opts.only, "down", false);
  const fullDown = selected.length === project.services.length;
  const state = loadState(project.name) ?? newState(project.name, project.configPath);

  log.info(`${c.bold(`devdown ${project.name}`)} ${c.dim(`(${selected.length} services)`)}`);
  const levels = topoLevels(selected).reverse();
  let hadError = false;

  for (const level of levels) {
    await Promise.all(
      level.map(async (svc) => {
        const entry = state.services[svc.name];
        try {
          switch (svc.type) {
            case "command": {
              if (!entry) {
                log.step(svc.name, c.dim("not tracked (nothing to stop)"));
                return;
              }
              await stopCommand(project, svc, state, entry);
              return;
            }
            case "docker": {
              const ok = await stopDocker(project, svc, state);
              if (!ok) hadError = true;
              return;
            }
            case "script": {
              if (svc.stop) {
                log.step(svc.name, `running stop script: ${c.dim(svc.stop)}`);
                const r = await run(svc.stop, { cwd: svc.cwd, env: serviceEnv(project, svc), timeoutMs: 60_000 });
                if (r.code !== 0) {
                  log.step(svc.name, `${sym.warn()} stop script exited ${r.code}`);
                }
              }
              delete state.services[svc.name];
              saveState(state);
              return;
            }
          }
        } catch (e) {
          hadError = true;
          log.step(svc.name, `${sym.fail()} ${(e as Error).message}`);
        }
      }),
    );
  }

  if (fullDown) {
    // Orphans: services renamed/removed from config but still tracked in state.
    const known = new Set(project.services.map((s) => s.name));
    for (const [name, entry] of Object.entries(state.services)) {
      if (known.has(name)) continue;
      if (entry.pid !== undefined) {
        const result = await terminate({ pid: entry.pid, pgid: entry.pgid, lstart: entry.lstart, graceSec: 10 });
        log.step(name, `orphaned service from previous config: ${result}`);
      }
      delete state.services[name];
    }

    const session = state.tmuxSession ?? project.tmux.session;
    if (!opts.keepTmux && tmuxAvailable() && (await sessionExists(session))) {
      await killSession(session);
      log.info(`${c.cyan("[tmux]")} killed session ${session}`);
    }
    deleteState(project.name);
  } else {
    saveState(state);
  }

  log.info(hadError ? `${sym.warn()} done with errors` : `${sym.ok()} done`);
  return hadError ? 1 : 0;
}

/** Restart the whole project (or one service). */
export async function restart(project: Project, service?: string, opts?: { noTmux?: boolean }): Promise<number> {
  if (service) {
    const svc = project.services.find((s) => s.name === service);
    if (!svc) throw new Error(`unknown service "${service}"`);
    if (svc.type === "docker" && !svc.restart) {
      log.step(svc.name, "restarting container");
      await composeRestart(svc);
      const state = loadState(project.name) ?? newState(project.name, project.configPath);
      state.services[svc.name] = {
        ...(state.services[svc.name] ?? { name: svc.name, type: svc.type, runMode: "docker" }),
        startedAt: new Date().toISOString(),
      };
      saveState(state);
      log.step(svc.name, `${sym.ok()} restarted`);
      return 0;
    }
    if (svc.restart) {
      log.step(svc.name, `running restart command: ${c.dim(svc.restart)}`);
      const r = await run(svc.restart, { cwd: svc.cwd, env: serviceEnv(project, svc), timeoutMs: 180_000 });
      if (r.code !== 0) {
        log.error((r.stderr || r.stdout).trim());
        return 1;
      }
      return 0;
    }
    const codeDown = await down(project, { only: [service], keepTmux: true });
    const codeUp = await up(project, { only: [service], noDeps: true });
    return codeDown === 0 && codeUp === 0 ? 0 : 1;
  }
  const codeDown = await down(project, { keepTmux: true });
  if (codeDown !== 0) log.warn("some services failed to stop cleanly; continuing with up");
  return up(project, {});
}

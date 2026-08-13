import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Project, Service } from "./config.js";
import { composeLogsArgv, daemonUp } from "./docker.js";
import { logsDir } from "./paths.js";
import { commandExists } from "./proc.js";
import { c, log, sym } from "./ui.js";

export interface LogsOptions {
  service?: string;
  follow: boolean;
  lines: number;
  clear: boolean;
}

function fileFor(project: Project, svc: Service): string {
  return path.join(logsDir(project.name), `${svc.name}.log`);
}

/** Let the user pick a service with fzf (returns undefined = all). */
async function pickService(project: Project, candidates: Service[]): Promise<string | undefined | null> {
  const lines = ["all", ...candidates.map((s) => `${s.name}\t${s.type}`)];
  return new Promise((resolve) => {
    const fzf = spawn(
      "fzf",
      ["--height=40%", "--reverse", "--prompt", `logs ${project.name} > `, "--with-nth=1", "--delimiter=\t"],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let out = "";
    fzf.stdout.on("data", (d: Buffer) => (out += d.toString()));
    fzf.on("error", () => resolve(undefined));
    fzf.on("close", (code) => {
      if (code !== 0) {
        resolve(null); // cancelled
        return;
      }
      const sel = out.trim().split("\t")[0];
      resolve(sel === "all" || sel === "" ? undefined : sel);
    });
    fzf.stdin.write(lines.join("\n"));
    fzf.stdin.end();
  });
}

function spawnInherit(argv: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const [bin, ...args] = argv;
    if (!bin) {
      resolve(1);
      return;
    }
    const child = spawn(bin, args, { cwd, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export async function logsCommand(project: Project, opts: LogsOptions): Promise<number> {
  const loggable = project.services.filter((s) => s.type !== "script" || fs.existsSync(fileFor(project, s)));
  if (loggable.length === 0) {
    log.warn("no services with logs");
    return 0;
  }

  let target = opts.service;
  if (target && !project.services.some((s) => s.name === target)) {
    log.error(`unknown service "${target}" (services: ${project.services.map((s) => s.name).join(", ")})`);
    return 2;
  }
  if (!target && !opts.clear && process.stdout.isTTY && commandExists("fzf") && loggable.length > 1) {
    const picked = await pickService(project, loggable);
    if (picked === null) return 130; // user cancelled
    target = picked;
  }
  const selected = target ? loggable.filter((s) => s.name === target) : loggable;

  if (opts.clear) {
    for (const svc of selected) {
      const f = fileFor(project, svc);
      if (fs.existsSync(f)) {
        fs.truncateSync(f, 0);
        log.step(svc.name, "log cleared");
      }
      if (svc.type === "docker") {
        log.step(svc.name, c.dim("docker container logs can't be truncated (recreate the container to reset)"));
      }
    }
    return 0;
  }

  const fileTargets = selected.filter((s) => s.type !== "docker").map((s) => fileFor(project, s));
  const existingFiles = fileTargets.filter((f) => fs.existsSync(f));
  const dockerTargets = selected.filter((s) => s.type === "docker");

  const jobs: Promise<number>[] = [];
  if (existingFiles.length > 0) {
    const args = ["-n", String(opts.lines)];
    if (opts.follow) args.push("-F");
    jobs.push(spawnInherit(["tail", ...args, ...existingFiles]));
  } else if (fileTargets.length > 0 && dockerTargets.length === 0) {
    log.warn(`no log files yet (has "devup ${project.name}" been run?)`);
    return 1;
  }

  if (dockerTargets.length > 0) {
    if (await daemonUp()) {
      // group docker services by compose context so each file gets one `compose logs` call
      const groups = new Map<string, Service[]>();
      for (const svc of dockerTargets) {
        const key = svc.composeFile ?? svc.cwd;
        groups.set(key, [...(groups.get(key) ?? []), svc]);
      }
      for (const svcs of groups.values()) {
        const first = svcs[0];
        if (!first) continue;
        const { argv, cwd } = composeLogsArgv(first, { follow: opts.follow, lines: opts.lines });
        // append additional compose service names in the same context
        for (const other of svcs.slice(1)) {
          if (other.composeService) argv.push(other.composeService);
        }
        jobs.push(spawnInherit(argv, cwd));
      }
    } else {
      log.warn(`${sym.warn()} docker daemon not running — skipping container logs`);
    }
  }

  if (jobs.length === 0) return 1;
  const codes = await Promise.all(jobs);
  return codes.every((code) => code === 0 || code === 130) ? 0 : 1;
}

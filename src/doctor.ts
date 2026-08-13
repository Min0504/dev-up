import * as fs from "node:fs";
import { listRegisteredProjects, loadProjectFromFile, ConfigError } from "./config.js";
import { daemonUp } from "./docker.js";
import { devupHome, ensureDir, projectsDir, stateDir } from "./paths.js";
import { commandExists, runArgv } from "./proc.js";
import { c, log, shortenHome, sym } from "./ui.js";

type Level = "ok" | "warn" | "fail";

interface Check {
  level: Level;
  label: string;
  detail?: string;
  fix?: string;
}

function mark(level: Level): string {
  return level === "ok" ? sym.ok() : level === "warn" ? sym.warn() : sym.fail();
}

export async function doctorCommand(): Promise<number> {
  const checks: Check[] = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 18
      ? { level: "ok", label: "Node.js", detail: `v${process.versions.node}` }
      : { level: "fail", label: "Node.js", detail: `v${process.versions.node}`, fix: "devup needs Node >= 18" },
  );

  checks.push(
    commandExists("git")
      ? { level: "ok", label: "Git" }
      : { level: "fail", label: "Git", fix: "xcode-select --install  (or brew install git)" },
  );

  if (commandExists("tmux")) {
    const v = await runArgv(["tmux", "-V"], { timeoutMs: 3000 });
    checks.push({ level: "ok", label: "tmux", detail: v.stdout.trim() });
  } else {
    checks.push({ level: "warn", label: "tmux", detail: "not installed (sessions disabled)", fix: "brew install tmux" });
  }

  if (commandExists("docker")) {
    if (await daemonUp(true)) {
      const compose = await runArgv(["docker", "compose", "version", "--short"], { timeoutMs: 5000 });
      checks.push({ level: "ok", label: "Docker daemon" });
      checks.push(
        compose.code === 0
          ? { level: "ok", label: "Docker Compose", detail: `v${compose.stdout.trim()}` }
          : { level: "warn", label: "Docker Compose", detail: "v2 plugin not found", fix: "update Docker Desktop" },
      );
    } else {
      checks.push({
        level: "warn",
        label: "Docker daemon",
        detail: "not running (docker services won't start)",
        fix: "open -a Docker",
      });
    }
  } else {
    checks.push({
      level: "warn",
      label: "Docker",
      detail: "CLI not found (docker services unavailable)",
      fix: "install Docker Desktop or OrbStack",
    });
  }

  checks.push(
    commandExists("fzf")
      ? { level: "ok", label: "fzf", detail: "interactive log picker enabled" }
      : { level: "warn", label: "fzf", detail: "not installed (devlogs picker disabled)", fix: "brew install fzf" },
  );

  try {
    ensureDir(projectsDir());
    ensureDir(stateDir());
    checks.push({ level: "ok", label: "DevUp home", detail: shortenHome(devupHome()) });
  } catch (e) {
    checks.push({ level: "fail", label: "DevUp home", detail: String(e), fix: `check permissions on ${devupHome()}` });
  }

  checks.push(
    commandExists("devup")
      ? { level: "ok", label: "CLI on PATH", detail: "devup / devdown / devstatus / devlogs" }
      : { level: "warn", label: "CLI on PATH", detail: "devup not found", fix: "run: npm link  (inside dev-up/)" },
  );

  const projects = listRegisteredProjects();
  if (projects.length === 0) {
    checks.push({ level: "warn", label: "Projects", detail: "none registered", fix: "dev init <name>" });
  } else {
    for (const p of projects) {
      try {
        const project = loadProjectFromFile(p.configPath);
        if (!fs.existsSync(project.root)) {
          checks.push({
            level: "warn",
            label: `Project ${p.name}`,
            detail: `root missing: ${shortenHome(project.root)}`,
            fix: "clone the repo or fix root: in the config",
          });
        } else {
          checks.push({ level: "ok", label: `Project ${p.name}`, detail: `${project.services.length} services` });
        }
      } catch (e) {
        const msg = e instanceof ConfigError ? e.problems[0] ?? "invalid" : String(e);
        checks.push({ level: "fail", label: `Project ${p.name}`, detail: msg, fix: `edit ${shortenHome(p.configPath)}` });
      }
    }
  }

  for (const check of checks) {
    const detail = check.detail ? `  ${c.dim(check.detail)}` : "";
    log.info(`${mark(check.level)} ${check.label}${detail}`);
    if (check.fix && check.level !== "ok") log.info(`   ${c.dim(`→ ${check.fix}`)}`);
  }
  const fails = checks.filter((chk) => chk.level === "fail").length;
  const warns = checks.filter((chk) => chk.level === "warn").length;
  log.info("");
  log.info(fails > 0 ? c.red(`${fails} problem(s) found`) : warns > 0 ? c.yellow(`ok with ${warns} warning(s)`) : c.green("all good"));
  return fails > 0 ? 1 : 0;
}

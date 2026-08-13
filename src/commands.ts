import * as fs from "node:fs";
import * as path from "node:path";
import { listRegisteredProjects, loadProjectFromFile, ConfigError } from "./config.js";
import { ensureDir, projectsDir } from "./paths.js";
import { loadState } from "./state.js";
import { c, log, shortenHome, sym, table } from "./ui.js";

const TEMPLATE = (name: string, root: string): string => `# devup project: ${name}
# Reference: https://github.com/ (local tool) — see dev-up/README.md for the full schema.
name: ${name}
root: ${root}

# Environment for every service (service env overrides these).
# env:
#   NODE_ENV: development
# env_file: .env.development        # relative to root

services:
  postgres:
    type: docker
    compose_service: postgres       # service name inside docker-compose.yml
    # compose_file: backend/docker-compose.yml   # if not at the service cwd
    healthcheck: postgres           # shorthand: postgres | redis | tcp:5432 | http://... | docker

  backend:
    type: command
    cwd: backend                    # relative to root
    command: pnpm dev
    depends_on: [postgres]
    healthcheck:
      type: http
      url: http://localhost:3000/health
      timeout: 90                   # seconds to wait until healthy

  frontend:
    type: command
    command: npx expo start
    tmux: true                      # run inside its own tmux window (interactive)
    depends_on: [backend]
    healthcheck: tcp:8081

  # migrate:
  #   type: script                  # runs to completion on every devup
  #   cwd: backend
  #   command: pnpm prisma migrate dev
  #   depends_on: [postgres]

tmux:
  enabled: true                     # create a tmux session "${name}" with shell + logs windows
  # attach: false                   # attach automatically after devup
`;

export function listCommand(): number {
  const projects = listRegisteredProjects();
  if (projects.length === 0) {
    log.info(`no projects registered.`);
    log.info(c.dim(`  dev init <name>        create a config in ~/.devup/projects/`));
    log.info(c.dim(`  dev register <file>    link a repo-local devup.yaml`));
    return 0;
  }
  const rows: string[][] = [];
  for (const p of projects) {
    let rootCol = "";
    let svcCol = "";
    let stateCol = "";
    try {
      const project = loadProjectFromFile(p.configPath);
      const rootOk = fs.existsSync(project.root);
      rootCol = rootOk ? c.dim(shortenHome(project.root)) : c.red(`${shortenHome(project.root)} (missing)`);
      svcCol = c.dim(`${project.services.length} services`);
      const st = loadState(p.name);
      const tracked = st ? Object.values(st.services).filter((s) => s.pid !== undefined || s.runMode === "docker").length : 0;
      stateCol = tracked > 0 ? c.green(`${tracked} tracked`) : "";
    } catch {
      rootCol = c.red("invalid config");
    }
    const linked = fs.lstatSync(p.configPath).isSymbolicLink() ? c.dim(" ↩") : "";
    rows.push([c.bold(p.name) + linked, svcCol, stateCol, rootCol]);
  }
  log.info(table(rows));
  return 0;
}

export function initCommand(name: string | undefined, local: boolean): number {
  const projName = name ?? path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const root = local ? "." : shortenHome(process.cwd());
  const target = local ? path.resolve("devup.yaml") : path.join(projectsDir(), `${projName}.yaml`);
  if (fs.existsSync(target)) {
    log.error(`already exists: ${shortenHome(target)}`);
    return 1;
  }
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, TEMPLATE(projName, root));
  log.info(`${sym.ok()} created ${c.bold(shortenHome(target))}`);
  log.info("");
  log.info(`next steps:`);
  log.info(c.dim(`  1. edit the config:   \${EDITOR:-cursor} ${shortenHome(target)}`));
  if (local) log.info(c.dim(`  2. register it:       dev register ${shortenHome(target)}`));
  log.info(c.dim(`  ${local ? "3" : "2"}. bring it up:       devup ${projName}`));
  return 0;
}

export function registerCommand(file: string, force: boolean): number {
  const abs = path.resolve(file);
  let project;
  try {
    project = loadProjectFromFile(abs);
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(`config is invalid, not registering:`);
      for (const p of e.problems) log.error(`  ${p}`);
      return 2;
    }
    throw e;
  }
  ensureDir(projectsDir());
  const link = path.join(projectsDir(), `${project.name}.yaml`);
  if (fs.existsSync(link)) {
    if (!force) {
      log.error(`project "${project.name}" already registered (${shortenHome(link)}). Use --force to replace.`);
      return 1;
    }
    fs.unlinkSync(link);
  }
  fs.symlinkSync(abs, link);
  log.info(`${sym.ok()} registered ${c.bold(project.name)} → ${shortenHome(abs)}`);
  log.info(c.dim(`  devup ${project.name}`));
  return 0;
}

export function unregisterCommand(name: string, force: boolean): number {
  for (const ext of [".yaml", ".yml"]) {
    const p = path.join(projectsDir(), name + ext);
    if (!fs.existsSync(p)) continue;
    const isLink = fs.lstatSync(p).isSymbolicLink();
    if (!isLink && !force) {
      log.error(`${shortenHome(p)} is a real file (not a symlink). Deleting it loses the config — use --force if you mean it.`);
      return 1;
    }
    fs.unlinkSync(p);
    log.info(`${sym.ok()} unregistered ${name}${isLink ? "" : " (file deleted)"}`);
    return 0;
  }
  log.error(`project "${name}" is not registered`);
  return 1;
}

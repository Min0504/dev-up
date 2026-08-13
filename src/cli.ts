import { Command } from "commander";
import { ConfigError, findConfigPath, loadProject, loadProjectFromFile, type Project } from "./config.js";
import { down, restart, up } from "./orchestrator.js";
import { gatherProject, overview, renderProjectLive, toJson } from "./status.js";
import { logsCommand } from "./logs.js";
import { doctorCommand } from "./doctor.js";
import { initCommand, listCommand, registerCommand, unregisterCommand } from "./commands.js";
import { completionScript } from "./completion.js";
import { c, isVerbose, log, setVerbose } from "./ui.js";

const VERSION = "0.1.1";

function csv(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadProjectVerbose(ref?: string): Project {
  const project = loadProject(ref);
  for (const w of project.warnings) log.info(c.dim(`⚠ config: ${w}`));
  return project;
}

async function guard(fn: () => Promise<number> | number): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const p of e.problems) log.error(p);
      process.exitCode = 2;
    } else {
      const err = e as Error;
      log.error(err.message || String(e));
      if (isVerbose() && err.stack) process.stderr.write(`${err.stack}\n`);
      process.exitCode = 1;
    }
  }
}

interface CommonOpts {
  verbose?: boolean;
}

function applyCommon(opts: CommonOpts): void {
  if (opts.verbose) setVerbose(true);
}

function buildProgram(): Command {
  const program = new Command("dev")
    .description("Personal dev environment orchestrator (devup / devdown / devstatus / devlogs)")
    .version(VERSION)
    .configureHelp({ sortSubcommands: false });

  program
    .command("up [project]")
    .description("start the project's dev environment (config: ~/.devup/projects/<p>.yaml or ./devup.yaml)")
    .option("--only <services>", "start only these services (comma-separated), plus their dependencies", csv)
    .option("--no-deps", "with --only: do not start dependencies")
    .option("--no-tmux", "skip tmux session/window handling")
    .option("-a, --attach", "attach to the tmux session when done")
    .option("--force", "restart services that are already running")
    .option("-v, --verbose", "verbose output")
    .action((project: string | undefined, opts: Record<string, unknown> & CommonOpts) =>
      guard(async () => {
        applyCommon(opts);
        return up(loadProjectVerbose(project), {
          only: opts.only as string[] | undefined,
          noDeps: opts.deps === false,
          noTmux: opts.tmux === false,
          attach: opts.attach === true,
          forceRestart: opts.force === true,
        });
      }),
    );

  program
    .command("down [project]")
    .description("stop everything devup started for the project (and only that)")
    .option("--only <services>", "stop only these services (comma-separated), plus their dependents", csv)
    .option("--keep-tmux", "leave the tmux session alive")
    .option("-v, --verbose", "verbose output")
    .action((project: string | undefined, opts: Record<string, unknown> & CommonOpts) =>
      guard(async () => {
        applyCommon(opts);
        return down(loadProjectVerbose(project), {
          only: opts.only as string[] | undefined,
          keepTmux: opts.keepTmux === true,
        });
      }),
    );

  program
    .command("restart [project] [service]")
    .description("restart the whole project, or a single service")
    .option("-v, --verbose", "verbose output")
    .action((project: string | undefined, service: string | undefined, opts: CommonOpts) =>
      guard(async () => {
        applyCommon(opts);
        return restart(loadProjectVerbose(project), service);
      }),
    );

  program
    .command("status [project]")
    .description("live status of one project (or a summary of all projects)")
    .option("--json", "machine-readable output")
    .option("-v, --verbose", "verbose output")
    .action((project: string | undefined, opts: Record<string, unknown> & CommonOpts) =>
      guard(async () => {
        applyCommon(opts);
        const json = opts.json === true;
        if (!project) {
          try {
            findConfigPath(undefined);
          } catch {
            await overview(json);
            return 0;
          }
        }
        const proj = loadProjectVerbose(project);
        const live = await gatherProject(proj, { probeHealth: true });
        log.info(json ? toJson(live) : renderProjectLive(live));
        const bad = live.services.some((s) => s.status === "failed" || s.status === "unhealthy");
        return bad ? 1 : 0;
      }),
    );

  program
    .command("logs [project] [service]")
    .description("show service logs (interactive picker with fzf when no service given)")
    .option("-f, --follow", "follow log output")
    .option("-n, --lines <n>", "number of lines to show", "100")
    .option("--clear", "truncate log files")
    .option("-v, --verbose", "verbose output")
    .action((project: string | undefined, service: string | undefined, opts: Record<string, unknown> & CommonOpts) =>
      guard(async () => {
        applyCommon(opts);
        return logsCommand(loadProjectVerbose(project), {
          service,
          follow: opts.follow === true,
          lines: Number.parseInt(String(opts.lines ?? "100"), 10) || 100,
          clear: opts.clear === true,
        });
      }),
    );

  program
    .command("list")
    .description("list registered projects")
    .action(() => guard(() => listCommand()));

  program
    .command("doctor")
    .description("check the environment and all registered project configs")
    .action(() => guard(() => doctorCommand()));

  program
    .command("init [name]")
    .description("create a new project config (in ~/.devup/projects/, or ./devup.yaml with --local)")
    .option("--local", "write ./devup.yaml in the current directory (keep config in the repo)")
    .action((name: string | undefined, opts: Record<string, unknown>) =>
      guard(() => initCommand(name, opts.local === true)),
    );

  program
    .command("register <file>")
    .description("register a repo-local devup.yaml (symlinked into ~/.devup/projects/)")
    .option("--force", "replace an existing registration")
    .action((file: string, opts: Record<string, unknown>) => guard(() => registerCommand(file, opts.force === true)));

  program
    .command("unregister <name>")
    .description("remove a project registration")
    .option("--force", "also delete when it is a real file, not a symlink")
    .action((name: string, opts: Record<string, unknown>) => guard(() => unregisterCommand(name, opts.force === true)));

  program
    .command("validate [project]")
    .description("parse and validate a project config without starting anything")
    .action((project: string | undefined) =>
      guard(() => {
        const proj = project?.includes("/") ? loadProjectFromFile(project) : loadProjectVerbose(project);
        log.info(`${c.bold(proj.name)}: config OK (${proj.services.length} services)`);
        return 0;
      }),
    );

  program
    .command("completion [shell]")
    .description("print shell completion script (zsh | bash)")
    .action((shell: string | undefined) =>
      guard(() => {
        const script = completionScript(shell ?? "zsh");
        if (!script) {
          log.error(`unsupported shell "${shell}" (zsh | bash)`);
          return 2;
        }
        process.stdout.write(script);
        return 0;
      }),
    );

  return program;
}

const ALIAS_MAP: Record<string, string> = {
  devup: "up",
  devdown: "down",
  devrestart: "restart",
  devstatus: "status",
  devlogs: "logs",
};

/** CLI entry point; `invokedAs` is the binary name (dev, devup, devdown, ...). */
export function run(invokedAs: string): void {
  const userArgs = process.argv.slice(2);
  const alias = ALIAS_MAP[invokedAs];
  const args = alias ? [alias, ...userArgs] : userArgs;
  const program = buildProgram();
  if (alias) program.name(invokedAs);
  void program.parseAsync(args, { from: "user" }).catch((e: unknown) => {
    log.error(String(e));
    process.exitCode = 1;
  });
}

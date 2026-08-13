import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** DevUp home directory (config + state + logs). Override with $DEVUP_HOME. */
export function devupHome(): string {
  return process.env.DEVUP_HOME || path.join(os.homedir(), ".devup");
}

export function projectsDir(): string {
  return path.join(devupHome(), "projects");
}

export function stateDir(): string {
  return path.join(devupHome(), "state");
}

export function logsDir(project: string): string {
  return path.join(devupHome(), "logs", project);
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Expand ~, then resolve relative paths against `base`. */
export function resolveFrom(base: string, p: string): string {
  const expanded = expandTilde(p);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

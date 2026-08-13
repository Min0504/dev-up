import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { expandTilde, projectsDir, resolveFrom } from "./paths.js";

export type ServiceType = "docker" | "command" | "script";
export type HealthType = "tcp" | "http" | "postgres" | "redis" | "docker" | "command";

export interface Healthcheck {
  type: HealthType;
  host: string;
  port?: number;
  url?: string;
  command?: string;
  expectStatus?: number;
  /** Total seconds to wait for the service to become healthy on startup. */
  timeoutSec: number;
  /** Seconds between probes. */
  intervalSec: number;
}

export interface Service {
  name: string;
  type: ServiceType;
  command?: string;
  stop?: string;
  restart?: string;
  /** Absolute working directory. */
  cwd: string;
  env: Record<string, string>;
  composeService?: string;
  /** Absolute path to a compose file, if explicitly set. */
  composeFile?: string;
  dependsOn: string[];
  healthcheck?: Healthcheck;
  autoStart: boolean;
  /** Run inside a tmux window instead of a detached background process. */
  tmux: boolean;
  stopGraceSec: number;
}

export interface TmuxConfig {
  enabled: boolean;
  session: string;
  attach: boolean;
  shellWindow: boolean;
  logsWindow: boolean;
}

export interface Project {
  name: string;
  root: string;
  env: Record<string, string>;
  envFile?: string;
  services: Service[];
  tmux: TmuxConfig;
  checks: string[];
  configPath: string;
  warnings: string[];
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DEFAULT_PORTS: Partial<Record<HealthType, number>> = { postgres: 5432, redis: 6379 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringMap(v: unknown, where: string, errors: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (v === undefined || v === null) return out;
  if (!isRecord(v)) {
    errors.push(`${where}: must be a mapping of KEY: value`);
    return out;
  }
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === undefined) continue;
    if (typeof val === "object") {
      errors.push(`${where}.${k}: value must be a scalar`);
      continue;
    }
    out[k] = String(val);
  }
  return out;
}

function asStringArray(v: unknown, where: string, errors: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  errors.push(`${where}: must be a string or list of strings`);
  return [];
}

/** Parse healthcheck value; supports shorthand strings like "tcp:5432", "http://...", "postgres", "redis:6380", "docker". */
function parseHealthcheck(
  raw: unknown,
  svcName: string,
  svcType: ServiceType,
  errors: string[],
  warnings: string[],
): Healthcheck | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  const where = `services.${svcName}.healthcheck`;

  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.startsWith("http://") || s.startsWith("https://")) obj = { type: "http", url: s };
    else {
      const m = /^(tcp|postgres|redis|docker|command)(?::(\d+))?$/.exec(s);
      if (!m) {
        errors.push(`${where}: unrecognized shorthand "${s}" (use tcp:PORT, http URL, postgres, redis, docker)`);
        return undefined;
      }
      obj = { type: m[1] };
      if (m[2]) obj.port = Number(m[2]);
    }
  } else if (isRecord(raw)) {
    obj = raw;
  } else {
    errors.push(`${where}: must be a mapping or shorthand string`);
    return undefined;
  }

  const type = obj.type as HealthType | undefined;
  const validTypes: HealthType[] = ["tcp", "http", "postgres", "redis", "docker", "command"];
  if (!type || !validTypes.includes(type)) {
    errors.push(`${where}.type: must be one of ${validTypes.join(", ")}`);
    return undefined;
  }

  const hc: Healthcheck = {
    type,
    host: typeof obj.host === "string" ? obj.host : "127.0.0.1",
    timeoutSec: typeof obj.timeout === "number" ? obj.timeout : 60,
    intervalSec: typeof obj.interval === "number" ? obj.interval : 1,
  };
  if (obj.port !== undefined) {
    const p = Number(obj.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(`${where}.port: invalid port ${String(obj.port)}`);
    else hc.port = p;
  }
  if (typeof obj.url === "string") hc.url = obj.url;
  if (typeof obj.command === "string") hc.command = obj.command;
  if (obj.expect_status !== undefined) hc.expectStatus = Number(obj.expect_status);

  if ((type === "tcp" || type === "postgres" || type === "redis") && hc.port === undefined) {
    const def = DEFAULT_PORTS[type];
    if (def) hc.port = def;
    else errors.push(`${where}: "port" is required for type ${type}`);
  }
  if (type === "http" && !hc.url) errors.push(`${where}: "url" is required for type http`);
  if (type === "command" && !hc.command) errors.push(`${where}: "command" is required for type command`);
  if (type === "docker" && svcType !== "docker")
    errors.push(`${where}: type "docker" is only valid for docker services`);
  if (type !== "docker" && svcType === "script")
    warnings.push(`${where}: healthchecks on script services are ignored`);
  return hc;
}

const KNOWN_PROJECT_KEYS = new Set(["name", "root", "env", "env_file", "services", "tmux", "checks"]);
const KNOWN_SERVICE_KEYS = new Set([
  "type",
  "command",
  "stop",
  "restart",
  "cwd",
  "env",
  "compose_service",
  "compose_file",
  "depends_on",
  "healthcheck",
  "auto_start",
  "tmux",
  "stop_grace",
]);
const KNOWN_TMUX_KEYS = new Set(["enabled", "session", "attach", "shell_window", "logs_window"]);

/** Parse + validate a project config file. Throws ConfigError with all problems found. */
export function loadProjectFromFile(configPath: string): Project {
  const abs = path.resolve(configPath);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    throw new ConfigError([`cannot read config file: ${abs}`]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    if (e instanceof YAMLParseError) {
      const pos = e.linePos?.[0];
      const loc = pos ? ` (line ${pos.line}, col ${pos.col})` : "";
      throw new ConfigError([`YAML syntax error in ${abs}${loc}: ${e.message.split("\n")[0]}`]);
    }
    throw new ConfigError([`failed to parse ${abs}: ${String(e)}`]);
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) throw new ConfigError([`${abs}: config must be a YAML mapping`]);

  for (const k of Object.keys(raw)) {
    if (!KNOWN_PROJECT_KEYS.has(k)) warnings.push(`unknown top-level key "${k}" (ignored)`);
  }

  const name = typeof raw.name === "string" ? raw.name : "";
  if (!name) errors.push(`"name" is required`);
  else if (!NAME_RE.test(name)) errors.push(`"name" must match ${NAME_RE} (got "${name}")`);

  const configDir = path.dirname(abs);
  let root = "";
  if (typeof raw.root !== "string" || raw.root.trim() === "") {
    errors.push(`"root" is required (project root directory)`);
  } else {
    root = resolveFrom(configDir, raw.root);
  }

  const env = asStringMap(raw.env, "env", errors);
  const envFile = typeof raw.env_file === "string" ? raw.env_file : undefined;
  const checks = asStringArray(raw.checks, "checks", errors);

  // --- services ---
  const services: Service[] = [];
  if (!isRecord(raw.services) || Object.keys(raw.services).length === 0) {
    errors.push(`"services" must be a non-empty mapping`);
  } else {
    for (const [svcName, rawSvcU] of Object.entries(raw.services)) {
      const where = `services.${svcName}`;
      if (!NAME_RE.test(svcName)) {
        errors.push(`${where}: service name must match ${NAME_RE}`);
        continue;
      }
      if (!isRecord(rawSvcU)) {
        errors.push(`${where}: must be a mapping`);
        continue;
      }
      const rawSvc = rawSvcU;
      for (const k of Object.keys(rawSvc)) {
        if (!KNOWN_SERVICE_KEYS.has(k)) warnings.push(`${where}: unknown key "${k}" (ignored)`);
      }
      const type = rawSvc.type as ServiceType | undefined;
      if (type !== "docker" && type !== "command" && type !== "script") {
        errors.push(`${where}.type: must be docker | command | script`);
        continue;
      }
      const command = typeof rawSvc.command === "string" ? rawSvc.command : undefined;
      const composeService = typeof rawSvc.compose_service === "string" ? rawSvc.compose_service : undefined;
      if (type === "docker" && !composeService && !command)
        errors.push(`${where}: docker service needs "compose_service" (or a custom "command")`);
      if ((type === "command" || type === "script") && !command)
        errors.push(`${where}: "command" is required for type ${type}`);

      const cwdRaw = typeof rawSvc.cwd === "string" ? rawSvc.cwd : ".";
      const svc: Service = {
        name: svcName,
        type,
        command,
        stop: typeof rawSvc.stop === "string" ? rawSvc.stop : undefined,
        restart: typeof rawSvc.restart === "string" ? rawSvc.restart : undefined,
        cwd: root ? resolveFrom(root, cwdRaw) : cwdRaw,
        env: asStringMap(rawSvc.env, `${where}.env`, errors),
        composeService,
        composeFile:
          typeof rawSvc.compose_file === "string" && root
            ? resolveFrom(root, rawSvc.compose_file)
            : undefined,
        dependsOn: asStringArray(rawSvc.depends_on, `${where}.depends_on`, errors),
        healthcheck: parseHealthcheck(rawSvc.healthcheck, svcName, type, errors, warnings),
        autoStart: rawSvc.auto_start !== false,
        tmux: rawSvc.tmux === true,
        stopGraceSec: typeof rawSvc.stop_grace === "number" ? rawSvc.stop_grace : 10,
      };
      if (svc.tmux && type !== "command") {
        warnings.push(`${where}: "tmux: true" only applies to command services (ignored)`);
        svc.tmux = false;
      }
      services.push(svc);
    }
  }

  // dependency references
  const names = new Set(services.map((s) => s.name));
  for (const s of services) {
    for (const d of s.dependsOn) {
      if (!names.has(d)) errors.push(`services.${s.name}.depends_on: unknown service "${d}"`);
      if (d === s.name) errors.push(`services.${s.name}.depends_on: cannot depend on itself`);
    }
  }

  // --- tmux ---
  const rawTmux = isRecord(raw.tmux) ? raw.tmux : {};
  if (isRecord(raw.tmux)) {
    for (const k of Object.keys(rawTmux)) {
      if (!KNOWN_TMUX_KEYS.has(k)) warnings.push(`tmux: unknown key "${k}" (ignored)`);
    }
  }
  const tmux: TmuxConfig = {
    enabled: rawTmux.enabled !== false,
    session: typeof rawTmux.session === "string" ? rawTmux.session : name || "devup",
    attach: rawTmux.attach === true,
    shellWindow: rawTmux.shell_window !== false,
    logsWindow: rawTmux.logs_window !== false,
  };

  if (errors.length > 0) throw new ConfigError(errors.map((e) => `${path.basename(abs)}: ${e}`));

  const project: Project = { name, root, env, envFile, services, tmux, checks, configPath: abs, warnings };
  // cycle check (throws ConfigError)
  topoLevels(project.services);
  return project;
}

export interface RegisteredProject {
  name: string;
  configPath: string;
}

export function listRegisteredProjects(): RegisteredProject[] {
  const dir = projectsDir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => ({ name: f.replace(/\.(yaml|yml)$/, ""), configPath: path.join(dir, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a project reference: explicit yaml path, registered name, or (if omitted) devup.yaml found upward from cwd. */
export function findConfigPath(ref?: string): string {
  if (ref) {
    const looksLikePath = ref.includes("/") || ref.endsWith(".yaml") || ref.endsWith(".yml");
    if (looksLikePath) {
      const p = path.resolve(expandTilde(ref));
      if (fs.existsSync(p)) return p;
      throw new ConfigError([`config file not found: ${p}`]);
    }
    for (const ext of [".yaml", ".yml"]) {
      const p = path.join(projectsDir(), ref + ext);
      if (fs.existsSync(p)) return p;
    }
    const known = listRegisteredProjects();
    const hint =
      known.length > 0
        ? `Known projects: ${known.map((k) => k.name).join(", ")}`
        : `No projects registered yet. Create one with: dev init ${ref}`;
    throw new ConfigError([`unknown project "${ref}". ${hint}`]);
  }

  // walk up from cwd
  let dir = process.cwd();
  for (;;) {
    for (const f of ["devup.yaml", ".devup.yaml", "devup.yml", ".devup.yml"]) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) return p;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError([
    `no project specified and no devup.yaml found in ${process.cwd()} or its parents.`,
    `Usage: devup <project>   (see "dev list")`,
  ]);
}

export function loadProject(ref?: string): Project {
  return loadProjectFromFile(findConfigPath(ref));
}

/** Kahn topological sort into parallel levels. Throws ConfigError on cycles. */
export function topoLevels(services: Service[]): Service[][] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of services) {
    indeg.set(s.name, 0);
    dependents.set(s.name, []);
  }
  for (const s of services) {
    for (const d of s.dependsOn) {
      if (!byName.has(d)) continue; // filtered subset: treat missing dep as satisfied
      indeg.set(s.name, (indeg.get(s.name) ?? 0) + 1);
      dependents.get(d)?.push(s.name);
    }
  }
  const levels: Service[][] = [];
  let frontier = services.filter((s) => (indeg.get(s.name) ?? 0) === 0).map((s) => s.name);
  const seen = new Set<string>();
  while (frontier.length > 0) {
    levels.push(frontier.map((n) => byName.get(n)!));
    const next: string[] = [];
    for (const n of frontier) {
      seen.add(n);
      for (const dep of dependents.get(n) ?? []) {
        const v = (indeg.get(dep) ?? 0) - 1;
        indeg.set(dep, v);
        if (v === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  if (seen.size !== services.length) {
    const cyclic = services.filter((s) => !seen.has(s.name)).map((s) => s.name);
    throw new ConfigError([`dependency cycle involving: ${cyclic.join(" → ")}`]);
  }
  return levels;
}

/** Names of `selected` plus all their transitive dependencies. */
export function dependencyClosure(services: Service[], selected: string[]): Set<string> {
  const byName = new Map(services.map((s) => [s.name, s]));
  const out = new Set<string>();
  const visit = (n: string): void => {
    if (out.has(n)) return;
    const s = byName.get(n);
    if (!s) return;
    out.add(n);
    s.dependsOn.forEach(visit);
  };
  selected.forEach(visit);
  return out;
}

/** Names of `selected` plus all services that (transitively) depend on them. */
export function dependentClosure(services: Service[], selected: string[]): Set<string> {
  const out = new Set<string>(selected.filter((n) => services.some((s) => s.name === n)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of services) {
      if (out.has(s.name)) continue;
      if (s.dependsOn.some((d) => out.has(d))) {
        out.add(s.name);
        changed = true;
      }
    }
  }
  return out;
}

/** Minimal .env file parser (KEY=VALUE, # comments, optional quotes, `export` prefix). */
export function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  for (const lineRaw of text.split("\n")) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] === undefined) continue;
    let val = m[2] ?? "";
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(" #");
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[m[1]] = val;
  }
  return out;
}

/** Effective environment for a service process. */
export function serviceEnv(project: Project, svc: Service): Record<string, string> {
  const fromFile = project.envFile ? parseEnvFile(resolveFrom(project.root, project.envFile)) : {};
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  return { ...base, ...project.env, ...fromFile, ...svc.env };
}

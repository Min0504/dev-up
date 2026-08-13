import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, stateDir } from "./paths.js";
import type { ServiceType } from "./config.js";

export type RunMode = "background" | "tmux" | "docker" | "script";

export interface ServiceState {
  name: string;
  type: ServiceType;
  runMode: RunMode;
  pid?: number;
  pgid?: number;
  /** `ps -o lstart` of the tracked pid, used to detect PID reuse. */
  lstart?: string;
  startedAt?: string;
  logFile?: string;
  tmuxWindowId?: string;
  tmuxPaneId?: string;
  composeService?: string;
  composeFile?: string;
  composeDir?: string;
  lastExitCode?: number;
  lastRunAt?: string;
}

export interface ProjectState {
  name: string;
  configPath: string;
  tmuxSession?: string;
  updatedAt: string;
  services: Record<string, ServiceState>;
}

function stateFile(name: string): string {
  return path.join(stateDir(), `${name}.json`);
}

export function loadState(name: string): ProjectState | null {
  try {
    const text = fs.readFileSync(stateFile(name), "utf8");
    const obj = JSON.parse(text) as ProjectState;
    if (typeof obj !== "object" || obj === null || typeof obj.name !== "string") return null;
    obj.services = obj.services ?? {};
    return obj;
  } catch {
    return null;
  }
}

export function newState(name: string, configPath: string): ProjectState {
  return { name, configPath, updatedAt: new Date().toISOString(), services: {} };
}

/** Atomic write (tmp file + rename). */
export function saveState(state: ProjectState): void {
  ensureDir(stateDir());
  state.updatedAt = new Date().toISOString();
  const file = stateFile(state.name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function deleteState(name: string): void {
  try {
    fs.unlinkSync(stateFile(name));
  } catch {
    /* already gone */
  }
}

/** Project names that currently have a state file. */
export function listStateNames(): string[] {
  try {
    return fs
      .readdirSync(stateDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

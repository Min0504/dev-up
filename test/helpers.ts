import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BIN = path.resolve(import.meta.dirname, "../../bin/dev.js");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function makeHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cli(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [BIN, ...args], {
      env: { ...process.env, DEVUP_HOME: home, NO_COLOR: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function readState(home: string, name: string): Record<string, unknown> | null {
  const p = path.join(home, "state", `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function stateFileExists(home: string, name: string): boolean {
  return fs.existsSync(path.join(home, "state", `${name}.json`));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function writeProject(home: string, name: string, yaml: string): void {
  const dir = path.join(home, "projects");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml);
}

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

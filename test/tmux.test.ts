import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { cli, makeHome, pidAlive, readState, stateFileExists, waitFor, writeProject } from "./helpers.js";

const SOCKET = `devup-test-${process.pid}`;

function tmuxOk(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tmuxCmd(args: string[]): string {
  return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });
}

test("tmux services: window per service, tee'd logs, clean session teardown", { skip: !tmuxOk() }, async (t) => {
  const home = makeHome("devup-tmux-");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devup-tmuxroot-"));
  fs.writeFileSync(path.join(root, "ticker.js"), `setInterval(() => console.log("tmux-tick", Date.now()), 200);\n`);
  fs.writeFileSync(path.join(root, "bg.js"), `setInterval(() => console.log("bg-tick", Date.now()), 200);\n`);

  writeProject(
    home,
    "ittmux",
    `name: ittmux
root: ${root}
services:
  tick:
    type: command
    command: node ticker.js
    tmux: true
  bg:
    type: command
    command: node bg.js
tmux:
  enabled: true
`,
  );
  const env = { DEVUP_TMUX_SOCKET: SOCKET };

  t.after(() => {
    try {
      execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
    } catch {
      /* server already gone */
    }
  });

  let tickPid = 0;

  await t.test("up creates session with shell/service/logs windows", async () => {
    const r = await cli(home, ["up", "ittmux"], env);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /started in tmux window/);

    const windows = tmuxCmd(["list-windows", "-t", "=ittmux", "-F", "#{window_name}"]).trim().split("\n");
    assert.ok(windows.includes("shell"), `windows: ${windows.join(",")}`);
    assert.ok(windows.includes("tick"), `windows: ${windows.join(",")}`);
    assert.ok(windows.includes("logs"), "logs window tails background services");

    const st = readState(home, "ittmux");
    const services = (st?.services ?? {}) as Record<string, { pid?: number; logFile?: string; runMode?: string }>;
    tickPid = services.tick?.pid ?? 0;
    assert.ok(tickPid > 0 && pidAlive(tickPid), "tmux pane pid tracked and alive");
    assert.equal(services.tick?.runMode, "tmux");

    // tee duplicates pane output into the log file
    const logFile = services.tick?.logFile ?? "";
    assert.ok(
      await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("tmux-tick"), 6000),
      "tmux service output lands in log file",
    );
  });

  await t.test("second up reuses the session (no duplicate windows)", async () => {
    const r = await cli(home, ["up", "ittmux"], env);
    assert.equal(r.code, 0);
    const windows = tmuxCmd(["list-windows", "-t", "=ittmux", "-F", "#{window_name}"])
      .trim()
      .split("\n")
      .filter((w) => w === "tick");
    assert.equal(windows.length, 1, "service window not duplicated");
  });

  await t.test("down kills processes and the session", async () => {
    const r = await cli(home, ["down", "ittmux"], env);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(await waitFor(() => !pidAlive(tickPid)), "tmux service process dead");
    assert.throws(() => tmuxCmd(["has-session", "-t", "=ittmux"]), "session gone");
    assert.ok(!stateFileExists(home, "ittmux"));
  });
});

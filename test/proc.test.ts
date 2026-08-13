import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { getLstart, isAlive, pidMatches, spawnBackground, terminate } from "../src/proc.js";
import { waitFor } from "./helpers.js";

function tmpLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devup-proc-"));
  return path.join(dir, "svc.log");
}

test("spawnBackground starts a detached process and records identity", async () => {
  const logFile = tmpLog();
  const info = spawnBackground(`echo hello-from-bg && sleep 30`, {
    cwd: os.tmpdir(),
    env: { ...process.env } as Record<string, string>,
    logFile,
  });
  assert.ok(info.pid > 0);
  assert.equal(info.pgid, info.pid);
  assert.ok(isAlive(info.pid));
  assert.ok(info.lstart);
  assert.ok(pidMatches(info.pid, info.lstart ?? undefined));
  assert.ok(await waitFor(() => fs.readFileSync(logFile, "utf8").includes("hello-from-bg")));
  const r = await terminate({ pid: info.pid, pgid: info.pgid, lstart: info.lstart ?? undefined, graceSec: 3 });
  assert.equal(r, "terminated");
  assert.ok(!isAlive(info.pid));
});

test("terminate kills the whole process group (children included)", async () => {
  const logFile = tmpLog();
  // parent sh spawns two sleeps; group kill must take out all of them
  const info = spawnBackground(`sleep 60 & sleep 60 & echo spawned; wait`, {
    cwd: os.tmpdir(),
    env: { ...process.env } as Record<string, string>,
    logFile,
  });
  assert.ok(await waitFor(() => fs.readFileSync(logFile, "utf8").includes("spawned")));
  const members = (): number[] => {
    try {
      const out = execSync(`ps -o pid= -g ${info.pgid}`, { encoding: "utf8" });
      return out
        .trim()
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((n) => Number.isFinite(n));
    } catch {
      return [];
    }
  };
  assert.ok(members().length >= 2, `expected group members, got ${members().length}`);
  const r = await terminate({ pid: info.pid, pgid: info.pgid, lstart: info.lstart ?? undefined, graceSec: 3 });
  assert.ok(r === "terminated" || r === "killed");
  assert.ok(await waitFor(() => members().length === 0), "all group members should be dead");
});

test("terminate refuses to kill a pid whose start time does not match (PID reuse safety)", async () => {
  const logFile = tmpLog();
  const info = spawnBackground(`sleep 60`, {
    cwd: os.tmpdir(),
    env: { ...process.env } as Record<string, string>,
    logFile,
  });
  const r = await terminate({
    pid: info.pid,
    pgid: info.pgid,
    lstart: "Mon Jan  1 00:00:00 2001", // deliberately wrong
    graceSec: 2,
  });
  assert.equal(r, "not-ours");
  assert.ok(isAlive(info.pid), "process must be left alone");
  await terminate({ pid: info.pid, pgid: info.pgid, lstart: info.lstart ?? undefined, graceSec: 3 });
});

test("terminate on a dead pid reports not-running", async () => {
  const logFile = tmpLog();
  const info = spawnBackground(`true`, {
    cwd: os.tmpdir(),
    env: { ...process.env } as Record<string, string>,
    logFile,
  });
  await waitFor(() => !isAlive(info.pid));
  const r = await terminate({ pid: info.pid, pgid: info.pgid, graceSec: 1 });
  assert.equal(r, "not-running");
});

test("getLstart returns a stable string for a live process", () => {
  const a = getLstart(process.pid);
  const b = getLstart(process.pid);
  assert.ok(a && a.length > 0);
  assert.equal(a, b);
});

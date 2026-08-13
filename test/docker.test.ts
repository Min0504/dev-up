import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { cli, makeHome, writeProject } from "./helpers.js";

const REDIS_PORT = 63981;

function dockerDaemonUp(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const daemon = dockerDaemonUp();

test("docker service lifecycle via compose (start, health, logs, stop)", { skip: !daemon }, async (t) => {
  const home = makeHome("devup-docker-");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devup-dockroot-"));
  fs.writeFileSync(
    path.join(root, "docker-compose.yml"),
    `name: devup-itest-compose
services:
  cache:
    image: redis:7-alpine
    ports:
      - "${REDIS_PORT}:6379"
`,
  );
  writeProject(
    home,
    "itdocker",
    `name: itdocker
root: ${root}
services:
  cache:
    type: docker
    compose_service: cache
    healthcheck:
      type: redis
      port: ${REDIS_PORT}
      timeout: 90
tmux:
  enabled: false
`,
  );

  t.after(() => {
    try {
      execFileSync("docker", ["compose", "down", "-v", "--remove-orphans"], { cwd: root, stdio: "ignore", timeout: 60_000 });
    } catch {
      /* best-effort cleanup */
    }
  });

  await t.test("up starts the container and waits for redis PING", async () => {
    const r = await cli(home, ["up", "itdocker"], {}, 240_000);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[cache\].*healthy/);
    const ps = execFileSync("docker", ["compose", "ps", "--format", "{{.State}}"], { cwd: root, encoding: "utf8" });
    assert.match(ps, /running/);
  });

  await t.test("status --json shows healthy with published port", async () => {
    const r = await cli(home, ["status", "itdocker", "--json"]);
    assert.equal(r.code, 0, r.stdout);
    const parsed = JSON.parse(r.stdout) as { services: { name: string; status: string; ports: number[] }[] };
    const cache = parsed.services.find((s) => s.name === "cache");
    assert.equal(cache?.status, "healthy");
    assert.ok(cache?.ports.includes(REDIS_PORT));
  });

  await t.test("logs come from docker compose", async () => {
    const r = await cli(home, ["logs", "itdocker", "cache", "-n", "20"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /Ready to accept connections|redis/i);
  });

  await t.test("down stops only this project's container", async () => {
    const r = await cli(home, ["down", "itdocker"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const ps = execFileSync("docker", ["compose", "ps", "--all", "--format", "{{.State}}"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(ps, /exited|^$/m);
  });
});

test("docker daemon down produces an actionable error", { skip: daemon }, async () => {
  const home = makeHome("devup-docker-");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devup-dockroot2-"));
  fs.writeFileSync(path.join(root, "docker-compose.yml"), `services:\n  cache:\n    image: redis:7-alpine\n`);
  writeProject(
    home,
    "itdockerdown",
    `name: itdockerdown\nroot: ${root}\nservices:\n  cache:\n    type: docker\n    compose_service: cache\ntmux:\n  enabled: false\n`,
  );
  const r = await cli(home, ["up", "itdockerdown"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Docker daemon is not running/);
  assert.match(r.stderr, /open -a Docker/);
});

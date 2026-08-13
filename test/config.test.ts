import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConfigError,
  dependencyClosure,
  dependentClosure,
  loadProjectFromFile,
  parseEnvFile,
  topoLevels,
  type Service,
} from "../src/config.js";

function writeTmp(yaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devup-cfg-"));
  const p = path.join(dir, "devup.yaml");
  fs.writeFileSync(p, yaml);
  return p;
}

const VALID = `
name: demo
root: ~/tmp-demo-root
env:
  NODE_ENV: development
services:
  db:
    type: docker
    compose_service: postgres
    healthcheck: postgres
  api:
    type: command
    cwd: backend
    command: pnpm dev
    env: { PORT: 8080 }
    depends_on: [db]
    healthcheck:
      type: http
      url: http://localhost:8080/health
      timeout: 45
  app:
    type: command
    command: npx expo start
    tmux: true
    depends_on: [api]
    healthcheck: tcp:8081
  seed:
    type: script
    command: pnpm seed
    depends_on: [db]
    auto_start: false
tmux:
  enabled: true
  session: demo-s
`;

test("valid config parses with defaults and path resolution", () => {
  const p = writeTmp(VALID);
  const proj = loadProjectFromFile(p);
  assert.equal(proj.name, "demo");
  assert.equal(proj.root, path.join(os.homedir(), "tmp-demo-root"));
  const api = proj.services.find((s) => s.name === "api");
  assert.ok(api);
  assert.equal(api.cwd, path.join(proj.root, "backend"));
  assert.equal(api.env.PORT, "8080");
  assert.equal(api.healthcheck?.type, "http");
  assert.equal(api.healthcheck?.timeoutSec, 45);
  const db = proj.services.find((s) => s.name === "db");
  assert.equal(db?.healthcheck?.type, "postgres");
  assert.equal(db?.healthcheck?.port, 5432);
  const app = proj.services.find((s) => s.name === "app");
  assert.equal(app?.tmux, true);
  assert.equal(app?.healthcheck?.port, 8081);
  const seed = proj.services.find((s) => s.name === "seed");
  assert.equal(seed?.autoStart, false);
  assert.equal(proj.tmux.session, "demo-s");
});

test("missing required fields are all reported at once", () => {
  const p = writeTmp(`services:\n  a:\n    type: nope\n`);
  try {
    loadProjectFromFile(p);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    const text = e.problems.join("\n");
    assert.match(text, /"name" is required/);
    assert.match(text, /"root" is required/);
    assert.match(text, /must be docker \| command \| script/);
  }
});

test("unknown depends_on and self-dependency rejected", () => {
  const p = writeTmp(`name: x\nroot: /tmp\nservices:\n  a:\n    type: command\n    command: sleep 1\n    depends_on: [ghost, a]\n`);
  assert.throws(
    () => loadProjectFromFile(p),
    (e: unknown) => e instanceof ConfigError && /unknown service "ghost"/.test(e.message) && /itself/.test(e.message),
  );
});

test("dependency cycles are detected", () => {
  const p = writeTmp(
    `name: x\nroot: /tmp\nservices:\n  a:\n    type: command\n    command: sleep 1\n    depends_on: [b]\n  b:\n    type: command\n    command: sleep 1\n    depends_on: [a]\n`,
  );
  assert.throws(
    () => loadProjectFromFile(p),
    (e: unknown) => e instanceof ConfigError && /cycle/.test(e.message),
  );
});

test("yaml syntax error includes line info", () => {
  const p = writeTmp(`name: x\nroot: /tmp\nservices:\n  a:\n   type: command\n  bad-indent`);
  assert.throws(
    () => loadProjectFromFile(p),
    (e: unknown) => e instanceof ConfigError && /YAML syntax error/.test(e.message),
  );
});

test("unknown keys produce warnings, not errors", () => {
  const p = writeTmp(`name: x\nroot: /tmp\nbanana: 1\nservices:\n  a:\n    type: command\n    command: sleep 1\n    fruit: 2\n`);
  const proj = loadProjectFromFile(p);
  assert.ok(proj.warnings.some((w) => w.includes("banana")));
  assert.ok(proj.warnings.some((w) => w.includes("fruit")));
});

function svc(name: string, deps: string[] = []): Service {
  return {
    name,
    type: "command",
    command: "true",
    cwd: "/tmp",
    env: {},
    dependsOn: deps,
    autoStart: true,
    tmux: false,
    stopGraceSec: 10,
  };
}

test("topoLevels groups independent services into parallel levels", () => {
  const levels = topoLevels([svc("db"), svc("cache"), svc("api", ["db", "cache"]), svc("web", ["api"])]);
  assert.deepEqual(
    levels.map((l) => l.map((s) => s.name).sort()),
    [["cache", "db"], ["api"], ["web"]],
  );
});

test("dependencyClosure / dependentClosure", () => {
  const all = [svc("db"), svc("api", ["db"]), svc("web", ["api"]), svc("other")];
  assert.deepEqual([...dependencyClosure(all, ["web"])].sort(), ["api", "db", "web"]);
  assert.deepEqual([...dependentClosure(all, ["db"])].sort(), ["api", "db", "web"]);
});

test("parseEnvFile handles quotes, comments, export", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devup-env-"));
  const p = path.join(dir, ".env");
  fs.writeFileSync(
    p,
    `# comment\nFOO=bar\nexport BAZ="quo ted"\nQUX='single'\nEMPTY=\nWITH_HASH=value # trailing\nBROKEN LINE\n한글=값\n`,
  );
  const env = parseEnvFile(p);
  assert.equal(env.FOO, "bar");
  assert.equal(env.BAZ, "quo ted");
  assert.equal(env.QUX, "single");
  assert.equal(env.EMPTY, "");
  assert.equal(env.WITH_HASH, "value");
  assert.equal(env["BROKEN"], undefined);
});

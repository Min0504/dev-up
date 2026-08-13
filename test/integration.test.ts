import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { cli, makeHome, pidAlive, readState, stateFileExists, waitFor, writeProject } from "./helpers.js";

const PORT = 39121;

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, "127.0.0.1");
  });
}

interface SvcState {
  pid?: number;
  lstart?: string;
  logFile?: string;
}

function svcState(home: string, project: string, name: string): SvcState {
  const st = readState(home, project);
  const services = (st?.services ?? {}) as Record<string, SvcState>;
  return services[name] ?? {};
}

interface StatusJson {
  services: { name: string; status: string; pid: number | null }[];
}

test("full lifecycle: up → status → logs → idempotent up → stale recovery → down", async (t) => {
  const home = makeHome("devup-itest-");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devup-iroot-"));

  fs.writeFileSync(
    path.join(root, "server.js"),
    `const http = require("http");
setTimeout(() => {
  http.createServer((req, res) => res.end("ok")).listen(${PORT}, "127.0.0.1", () => console.log("web listening"));
}, 1200);
`,
  );
  fs.writeFileSync(path.join(root, "ticker.js"), `setInterval(() => console.log("tick", Date.now()), 250);\n`);

  writeProject(
    home,
    "itest",
    `name: itest
root: ${root}
services:
  init:
    type: script
    command: node -e "console.log('init-ok')"
  web:
    type: command
    command: node server.js
    depends_on: [init]
    healthcheck:
      type: http
      url: http://127.0.0.1:${PORT}/health
      timeout: 25
      interval: 0.3
  ticker:
    type: command
    command: node ticker.js
    depends_on: [web]
tmux:
  enabled: false
`,
  );

  await t.test("validate", async () => {
    const r = await cli(home, ["validate", "itest"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /config OK \(3 services\)/);
  });

  let webPid = 0;
  let tickerPid = 0;

  await t.test("up starts everything in dependency order", async () => {
    const r = await cli(home, ["up", "itest"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /init-ok/);
    assert.match(r.stdout, /\[web\].*healthy/);
    // dependency ordering: script finishes before web starts, web healthy before ticker starts
    const initDone = r.stdout.indexOf("script done");
    const webStart = r.stdout.indexOf("[web] started");
    const webHealthy = r.stdout.search(/\[web\] .*healthy/);
    const tickerStart = r.stdout.indexOf("[ticker] started");
    assert.ok(initDone >= 0 && webStart > initDone, "web starts after init script");
    assert.ok(webHealthy >= 0 && tickerStart > webHealthy, "ticker starts after web is healthy");

    webPid = svcState(home, "itest", "web").pid ?? 0;
    tickerPid = svcState(home, "itest", "ticker").pid ?? 0;
    assert.ok(webPid > 0 && pidAlive(webPid));
    assert.ok(tickerPid > 0 && pidAlive(tickerPid));
    assert.ok(await portOpen(PORT));
  });

  await t.test("status --json reports healthy/running", async () => {
    const r = await cli(home, ["status", "itest", "--json"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const parsed = JSON.parse(r.stdout) as StatusJson;
    const by = new Map(parsed.services.map((s) => [s.name, s]));
    assert.equal(by.get("web")?.status, "healthy");
    assert.equal(by.get("ticker")?.status, "running");
    assert.equal(by.get("web")?.pid, webPid);
  });

  await t.test("logs show service output", async () => {
    assert.ok(
      await waitFor(() => {
        const f = svcState(home, "itest", "ticker").logFile;
        return !!f && fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("tick");
      }),
    );
    const r = await cli(home, ["logs", "itest", "ticker", "-n", "10"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /tick/);
  });

  await t.test("second up is idempotent", async () => {
    const r = await cli(home, ["up", "itest"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\[web\] already running/);
    assert.match(r.stdout, /\[ticker\] already running/);
    assert.equal(svcState(home, "itest", "web").pid, webPid, "web pid unchanged");
  });

  await t.test("externally killed service shows failed, up recovers it", async () => {
    process.kill(tickerPid, "SIGKILL");
    await waitFor(() => !pidAlive(tickerPid));
    const st = await cli(home, ["status", "itest", "--json"]);
    const parsed = JSON.parse(st.stdout) as StatusJson;
    assert.equal(parsed.services.find((s) => s.name === "ticker")?.status, "failed");
    assert.equal(st.code, 1, "status exits 1 when something failed");

    const r = await cli(home, ["up", "itest"]);
    assert.equal(r.code, 0, r.stdout);
    const newPid = svcState(home, "itest", "ticker").pid ?? 0;
    assert.ok(newPid > 0 && newPid !== tickerPid && pidAlive(newPid));
    tickerPid = newPid;
  });

  await t.test("down refuses to kill a reused pid (not ours) but cleans the rest", async () => {
    // decoy process not started by devup
    const decoy = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    decoy.unref();
    const decoyPid = decoy.pid ?? 0;
    assert.ok(decoyPid > 0);

    // tamper: point ticker's state at the decoy with a mismatched lstart
    const stPath = path.join(home, "state", "itest.json");
    const st = JSON.parse(fs.readFileSync(stPath, "utf8")) as {
      services: Record<string, { pid?: number; pgid?: number; lstart?: string }>;
    };
    const realTicker = st.services["ticker"];
    assert.ok(realTicker?.pid);
    const realPid = realTicker.pid ?? 0;
    st.services["ticker"] = { ...realTicker, pid: decoyPid, pgid: decoyPid, lstart: "Mon Jan  1 00:00:00 2001" };
    fs.writeFileSync(stPath, JSON.stringify(st));

    const r = await cli(home, ["down", "itest"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /left untouched/);
    assert.ok(pidAlive(decoyPid), "decoy must survive devdown");
    process.kill(decoyPid, "SIGKILL");

    // the real ticker process is orphaned now (we lost its state on purpose) — clean it up
    if (pidAlive(realPid)) process.kill(realPid, "SIGKILL");

    assert.ok(!pidAlive(webPid), "web stopped");
    assert.ok(await waitFor(async () => !(await portOpen(PORT))), "port released");
    assert.ok(!stateFileExists(home, "itest"), "state file removed");
  });
});

test("failure handling: broken service fails, dependents are skipped, exit code 1", async () => {
  const home = makeHome("devup-ifail-");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devup-ifroot-"));
  writeProject(
    home,
    "itfail",
    `name: itfail
root: ${root}
services:
  bad:
    type: command
    command: node -e "console.error('boom'); process.exit(3)"
  child:
    type: command
    command: sleep 60
    depends_on: [bad]
tmux:
  enabled: false
`,
  );
  const r = await cli(home, ["up", "itfail"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\[bad\] .*(exited immediately|died)/);
  assert.match(r.stdout, /boom/, "failure output shows the service's log tail");
  assert.match(r.stdout, /\[child\] .*skipped \(dependency "bad" failed\)/);
  assert.match(r.stdout + r.stderr, /service\(s\) failed: bad/);

  const down = await cli(home, ["down", "itfail"]);
  assert.equal(down.code, 0);
});

test("config errors exit with code 2 and a clear message", async () => {
  const home = makeHome("devup-icfg-");
  writeProject(home, "broken", `name: broken\nservices:\n  a:\n    type: command\n`);
  const r = await cli(home, ["up", "broken"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /"root" is required/);
  assert.match(r.stderr, /"command" is required/);

  const unknown = await cli(home, ["up", "no-such-project"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown project "no-such-project"/);
});

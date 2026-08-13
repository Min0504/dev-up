import { test } from "node:test";
import * as assert from "node:assert/strict";
import { makeHome } from "./helpers.js";

test("state save/load roundtrip is atomic and typed", async () => {
  process.env.DEVUP_HOME = makeHome("devup-state-");
  const { loadState, newState, saveState, deleteState, listStateNames } = await import("../src/state.js");

  assert.equal(loadState("nope"), null);
  const st = newState("proj", "/tmp/devup.yaml");
  st.services["api"] = {
    name: "api",
    type: "command",
    runMode: "background",
    pid: 4242,
    pgid: 4242,
    lstart: "Wed Aug 13 21:00:00 2026",
    logFile: "/tmp/api.log",
  };
  st.tmuxSession = "proj";
  saveState(st);

  const loaded = loadState("proj");
  assert.ok(loaded);
  assert.equal(loaded.services["api"]?.pid, 4242);
  assert.equal(loaded.tmuxSession, "proj");
  assert.deepEqual(listStateNames(), ["proj"]);

  deleteState("proj");
  assert.equal(loadState("proj"), null);
  deleteState("proj"); // idempotent
});

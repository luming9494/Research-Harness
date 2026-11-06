// Regression tests of the deterministic single-candidate Experiment Controller.
// No Pi model calls, PyTorch or remote GPU required. Run after npm run build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SingleOptimize } from "../../packages/coding-agent/dist/axiom/execution/single-optimize.js";

function evidence(accuracy) {
  return {
    protocol: "tiny-xor-v1",
    split: "validation",
    level: "full",
    samples: 512,
    accuracy,
    loss: 0.5,
    dataset_access_log: ["validation"],
    checkpoint_sha256: "a".repeat(64),
  };
}

async function createController(t, candidateScore = 0.8, failCandidate = false) {
  const root = await mkdtemp(join(tmpdir(), "axiom-migrated-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseline = evidence(0.5);
  const candidate = evidence(candidateScore);
  const trained = [];
  const exported = [];
  const runner = {
    root,
    verifyTrusted: async () => {},
    invoke: async (name) => name === "edit_candidate_file" ? { status: "edited" } : { status: "executed" },
    runFull: async (role) => {
      trained.push(role);
      if (role === "candidate" && failCandidate) throw new Error("simulated executor failure");
      return role === "baseline" ? baseline : candidate;
    },
    validateFull: async (role) => role === "baseline" ? baseline : candidate,
    exportSelected: async (role) => { exported.push(role); return "selected/"; },
  };
  const controller = new SingleOptimize(runner);
  await controller.initialize();
  return { controller, trained, exported };
}

async function reachResult(controller) {
  await controller.invoke("run_baseline", {}, "test");
  await controller.invoke("edit_candidate_file", {
    path: "model.py", expectedSha256: "old", content: "new", rationale: "offline fixture",
  }, "test");
  await controller.invoke("run_checks", { action: "smoke" }, "test");
  await controller.invoke("run_candidate", {}, "test");
  await controller.invoke("get_run_result", {}, "test");
}

test("baseline must precede edit; Smoke must precede full run", async (t) => {
  const { controller, trained } = await createController(t);
  await assert.rejects(controller.invoke("run_candidate", {}, "test"), /baseline/);
  await controller.invoke("run_baseline", {}, "test");
  await controller.invoke("run_baseline", {}, "test");
  assert.deepEqual(trained, ["baseline"]); // no duplicate baseline execution
  await controller.invoke("edit_candidate_file", { path: "model.py", expectedSha256: "old", content: "new", rationale: "own idea" }, "test");
  await assert.rejects(controller.invoke("run_candidate", {}, "test"), /Smoke/);
  await controller.invoke("run_checks", { action: "smoke" }, "test");
  await controller.invoke("run_candidate", {}, "test");
  assert.deepEqual(trained, ["baseline", "candidate"]);
  await assert.rejects(controller.invoke("run_candidate", {}, "test"), /one full/);
});

test("wrong keep/revert decisions cannot override independent metrics", async (t) => {
  const { controller, exported } = await createController(t, 0.5);
  await reachResult(controller);
  await assert.rejects(controller.invoke("finalize_candidate", { choice: "keep", reason: "because training passed" }, "test"), /conflicts/);
  const decision = await controller.invoke("finalize_candidate", { choice: "revert", reason: "not improved" }, "test");
  assert.equal(decision.outcome, "not_improved");
  assert.deepEqual(exported, ["baseline"]);
  await assert.rejects(controller.invoke("run_candidate", {}, "test"), /finalized/);
});

test("better candidate selected from real-metric decision logic", async (t) => {
  const { controller, exported } = await createController(t, 0.9);
  await reachResult(controller);
  const decision = await controller.invoke("finalize_candidate", { choice: "keep", reason: "higher independent validation" }, "test");
  assert.equal(decision.outcome, "validation_improved");
  assert.deepEqual(exported, ["candidate"]);
});

test("candidate failure can safely revert and cannot auto retry", async (t) => {
  const { controller, trained, exported } = await createController(t, 0.9, true);
  await controller.invoke("run_baseline", {}, "test");
  await controller.invoke("edit_candidate_file", { path: "model.py", expectedSha256: "old", content: "new", rationale: "own idea" }, "test");
  await controller.invoke("run_checks", { action: "smoke" }, "test");
  await assert.rejects(controller.invoke("run_candidate", {}, "test"), /executor failure/);
  await assert.rejects(controller.invoke("run_candidate", {}, "test"), /one full/);
  await controller.invoke("get_run_result", {}, "test");
  const decision = await controller.invoke("finalize_candidate", { choice: "revert", reason: "failed candidate" }, "test");
  assert.equal(decision.outcome, "candidate_failed");
  assert.deepEqual(exported, ["baseline"]);
  assert.deepEqual(trained, ["baseline", "candidate"]);
});

test("arbitrary commands and final-test overrides fail closed", async (t) => {
  const { controller, trained } = await createController(t);
  for (const [name, input] of [
    ["run_baseline", { split: "final-test" }],
    ["get_run_result", { path: "../private" }],
    ["run_candidate", { command: "echo unsafe" }],
    ["judge", {}],
  ]) await assert.rejects(controller.invoke(name, input, "test"), /Permission denied/);
  assert.deepEqual(trained, []);
});

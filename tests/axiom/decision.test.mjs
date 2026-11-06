// Run after building Pi: node --test tests/axiom/decision.test.mjs
// Tests deterministic policy only: no LLM, GPU or Python needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideCandidate } from "../../packages/coding-agent/dist/axiom/execution/single-optimize.js";

function result(accuracy) {
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

test("strict improvement keeps candidate", () => {
  assert.equal(decideCandidate(result(0.5), result(0.8)).choice, "keep");
});

test("ties and regression revert", () => {
  assert.equal(decideCandidate(result(0.5), result(0.5)).choice, "revert");
  assert.equal(decideCandidate(result(0.5), result(0.2)).choice, "revert");
});

test("failed training reverts without invented success", () => {
  const decision = decideCandidate(result(0.5), undefined, "training failed");
  assert.equal(decision.choice, "revert");
  assert.equal(decision.outcome, "candidate_failed");
});

test("final-test and invalid evidence rejected", () => {
  assert.throws(() => decideCandidate(result(0.5), { ...result(0.8), split: "final-test" }));
  assert.throws(() => decideCandidate(result(0.5), { ...result(0.8), dataset_access_log: ["final-test"] }));
  assert.throws(() => decideCandidate(result(0.5), { ...result(0.8), accuracy: Number.NaN }));
});

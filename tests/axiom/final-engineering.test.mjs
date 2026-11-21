// 真实策略收益由正式评测产生。这里覆盖静态一致性和跨领域缺证边界。
import assert from "node:assert/strict";
import { test } from "node:test";
import contextProbe from "../../axiom/bench/context-probe-extension.ts";
import { researchSuite } from "../../axiom/bench/research-suite.ts";
import { summarize } from "../../axiom/release/gate.ts";
import { assessDirection, researchHypothesis } from "../../axiom/research/workspace/hypothesis.ts";

test("FINAL-15-01 hypothesis binds comparison, registered control, direction and evidence", () => {
	const source = [{ id: "verified-evidence" }];
	const valid = { comparison: "rate-high", reference: "rate-base", metric: "accuracy", direction: "increase", ref: 1 };
	assert.match(researchHypothesis(JSON.stringify(valid), "tiny", source).hypothesis.statement, /increase accuracy versus rate-base/);
	assert.match(researchHypothesis(JSON.stringify({ ...valid, direction: "decrease" }), "tiny", source).hypothesis.statement, /decrease/);
	for (const change of [
		{ direction: "equal" }, { reference: "rate-low" }, { ref: 2 }, { metric: "ndcg10" },
		{ statement: "Accuracy will decrease." }, { comparison: "rate-base" },
	]) assert.throws(() => researchHypothesis(JSON.stringify({ ...valid, ...change }), "tiny", source));
	assert.equal(assessDirection("increase", 0, true), "uncertain");
	assert.equal(assessDirection("increase", -0.1, true), "contradicted");
	assert.equal(assessDirection("decrease", -0.1, true), "supported");
	assert.equal(assessDirection("decrease", -0.1, false), "uncertain");
});

test("FINAL-15-02 suite preserves integrity failure and separate mechanism/target outcomes", async () => {
	const result = await researchSuite([
		{ id: "corrupt", source: "archive_reverified", async run() { throw new Error("digest mismatch"); } },
		{ id: "slurm", source: "offline", async run() { return { task: "unknown", harness: "pass", evidence: {} }; } },
	]);
	assert.deepEqual(result.map(({ id, task, harness }) => [id, task, harness]), [
		["corrupt", "unknown", "unknown"], ["slurm", "unknown", "pass"],
	]);
});

test("FINAL-15-03 release stats retain missing or failed planned samples", () => {
	const plan = { repetitions: 3, arms: [{ id: "baseline" }] };
	const result = { status: "completed", task_success: { status: "pass" }, harness_correctness: { status: "pass" },
		context_comparison: { repair: "repaired", input_tokens: 300 }, usage: { requests: 1, tokens: 310 }, wall_seconds: 2 };
	const entry = { arm: "baseline", result };
	assert.equal(summarize([entry], plan)[0].reliability, null);
	const failed = { arm: "baseline", result: { ...result, status: "error", task_success: { status: "fail" } } };
	const summary = summarize([entry, entry, failed], plan)[0];
	assert.equal(summary.passed, 2);
	assert.equal(summary.reliability[1].pass_at_k, 1);
	assert.equal(summary.reliability[1].pass_all_k, 0);
});

test("FINAL-15-04 context probe reports evidence identity and forbids tool execution", () => {
	const events = new Map();
	contextProbe({ on: (name, handler) => events.set(name, handler) });
	const evidence = "18bd5f80-79d1-5096-88b5-a9e9702f1a71";
	const notes = [];
	const payload = events.get("before_provider_request")({ payload: { messages: [evidence, evidence, "private prompt text"] } },
		{ ui: { notify: (note) => notes.push(note) } });
	assert.deepEqual(notes, [`Context probe evidence ["${evidence}"]`]);
	assert.equal(payload.tool_choice, "none");
	assert.equal(payload.max_tokens, 256);
	assert.equal(events.get("tool_call")().block, true);
});

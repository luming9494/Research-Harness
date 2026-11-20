// 验收固定分组设计、失败样本保留以及真实机制场景。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { selectCases } from "../../axiom/bench/cases.ts";
import { passStatistics, schedule, summarize } from "../../axiom/bench/comparison.ts";
import { liveUsage, validAdmission } from "../../axiom/bench/grader.ts";
import { runBatch, verifyRun } from "../../axiom/bench/runner.ts";

test("BENCH-072-01 plans fixed matched groups and counts unsuccessful runs in both pass statistics", () => {
	const cases = selectCases("comparison", []);
	const plan = schedule(cases, 3);
	assert.equal(plan.length, 27);
	assert.equal(new Set(plan.map(run => run.path)).size, 27);
	assert.deepEqual([plan[0], plan[9], plan[18]].map(run => run.item.comparison.arm), ["B0", "B1", "B2"]);
	for (let i = 0; i < cases.length; i += 3) {
		const [a, b, c] = cases.slice(i, i + 3);
		for (const other of [b, c]) {
			assert.deepEqual(other.budget, a.budget);
			assert.deepEqual(other.scoring, a.scoring);
			assert.deepEqual(other.assets, a.assets);
			assert.equal(other.model, a.model);
			assert.equal(other.description, a.description);
			assert.equal(other.injection, a.injection);
		}
	}
	assert.deepEqual(passStatistics(3, 1, 2), {
		n: 3, k: 2, subsets: 3, pass_at_k: 1 - 1 / 3, pass_all_k: 0,
	});
	assert.equal(passStatistics(2, 2, 3).pass_all_k, null);
	assert.equal(passStatistics(3, 2, 2).pass_all_k, 1 / 3);

	// 出错和无证据结果仍占试验数，没启动的项在计划中单独列出。
	const one = schedule([cases[0]], 3);
	const result = (score, status) => ({
		task_success: { status: score, checks: [] }, harness_correctness: { status: "unknown", checks: [] },
		status, usage: { requests: 1, tokens: null, estimated_cost_usd: null }, wall_seconds: 1, evaluation: [], failures: [],
	});
	const [summary] = summarize(one, [result("pass", "completed"), result("unknown", "error")]);
	assert.equal(summary.n, 2);
	assert.equal(summary.planned, 3);
	assert.equal(summary.success_rate, 0.5);
	assert.equal(summary.runs[2].status, "not_started");
	assert.equal(summary.tokens.sum, null);
});

test("BENCH-072-02 separates supplier overruns, illegal subsequent admission and unknown usage", () => {
	const settled = { id: 1, status: "completed", estimate: 80, evidence: { usage: { totalTokens: 105 } } };
	const state = (requests, overrides) => ({
		spec: { budget: { max_tokens: 100 } }, requests,
		summary: { status: "budget_exhausted", budget: {
			model_requests: requests.length, tokens_actual: 105, usage_uncertain: false, tokens_admission_estimate: 0,
			...overrides,
		} },
	});
	assert.equal(validAdmission(state([settled])), true);
	assert.equal(validAdmission(state([settled, { ...settled, id: 2, estimate: 1 }])), false);
	const unknown = state([{ id: 1, status: "unknown", estimate: 80 }],
		{ tokens_actual: 0, usage_uncertain: true, tokens_admission_estimate: 80 });
	unknown.summary.status = "needs_reconciliation";
	assert.equal(validAdmission(unknown), true);
	assert.deepEqual(liveUsage([{ tokens: 100, cost: 0.1 }], 2), { requests: 2, tokens: null, estimated_cost_usd: null });
});

test("BENCH-072-03 detects real violations and regrades the recovered v3 CPU case", { timeout: 600_000 }, async t => {
	const output = await mkdtemp(join(tmpdir(), "axiom-bench-mechanisms-"));
	t.after(() => rm(output, { recursive: true, force: true }));
	const repo = resolve(".");
	const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	const selected = selectCases("mechanisms", []);
	const { root, results } = await runBatch(repo, python, output, selected, AbortSignal.timeout(540_000));
	assert.equal(results.length, 6);
	for (const run of results) {
		const runRoot = join(root, run.case_id);
		assert.equal(run.matches_expected, true, `${run.case_id}: ${run.failures.join(", ")}`);
		assert.deepEqual(await verifyRun(repo, runRoot), run);
		// 复用真实机制证据验证归因，同时保留两个原评分轴的断言。
		const attribution = JSON.parse(await readFile(join(runRoot, "attribution.json"), "utf8"));
		const category = {
			"T2-POL-01": "policy_violation", "T2-DUR-02": "policy_violation", "T2-BUD-01": "budget_failure",
			"T2-EVAL-01": "evidence_integrity_failure", "T2-SEARCH-02": "evaluation_failure",
		}[run.case_id];
		if (category) {
			const failure = attribution.failures.find(entry => entry.category === category);
			assert.ok(failure?.evidence.length, run.case_id);
			assert.equal(failure.impact.harness_correctness, "fail");
		} else assert.deepEqual(attribution.failures, []);
	}
	const duplicate = results.find(run => run.case_id === "T2-DUR-02");
	assert.equal(duplicate.execution.duplicate_launches, 1);
	const v3 = results.find(run => run.case_id === "T2-SEARCH-01");
	assert.equal(v3.execution.training_steps, 182);
	assert.deepEqual(v3.evaluation.map(entry => entry.result.level), ["full", "smoke", "proxy"]);
	const attack = await readFile(join(root, "T2-POL-01", "final", "events.jsonl"), "utf8");
	assert.match(attack, /fixture_receipt.+bench unapproved operation/);
});

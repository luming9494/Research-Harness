// 检查归因规则、证据边界和真实恢复。确定性回归不会请求付费模型。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { attribute } from "../../axiom/bench/attribution.ts";
import { selectCases } from "../../axiom/bench/cases.ts";
import { schedule, summarize } from "../../axiom/bench/comparison.ts";
import { failureCases } from "../../axiom/bench/failure-cases.ts";
import { digest } from "../../axiom/bench/io.ts";
import { runBatch, verifyRun } from "../../axiom/bench/runner.ts";
import { TraceEvidence } from "../../axiom/bench/trace-evidence.ts";
import { toolReceipt } from "../../axiom/bench/trace-rpc.ts";
import { collectTrace } from "../../axiom/bench/trace.ts";

const read = async (root, path) => JSON.parse(await readFile(join(root, path), "utf8"));
const run = { run_id: "test", case_id: "T3-COMP-01", status: "completed", started_at: "2026-11-20T00:00:00Z" };
const grades = { task_success: { status: "fail", checks: [] }, harness_correctness: { status: "pass", checks: [] }, evaluation: [] };

test("TRACE-073-01 projects Pi proposal, tool contract and generic tool errors without sensitive bytes", async t => {
	const root = await mkdtemp(join(tmpdir(), "axiom-trace-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	const event = { type: "tool_execution_end", toolCallId: "sensitive-call", toolName: "axiom_task_candidate", isError: true };
	const errors = ['Invalid arguments for tool "axiom_task_candidate":', 'Validation failed for tool "axiom_task_candidate":', "worker failed"];
	const receipts = errors.map((text, index) => toolReceipt({
		...event, result: { content: [{ type: "text", text: `${text} sensitive-payload` }] },
	}, index + 1, index + 1));
	assert.equal(new Set(receipts.map(receipt => receipt.call_id)).size, 3);
	assert.doesNotMatch(JSON.stringify(receipts), /sensitive-call|sensitive-payload/);
	await writeFile(join(root, "observed.json"), JSON.stringify({ tool_evidence: receipts }));
	const store = new TraceEvidence(root, [await digest(root, "observed.json")]);
	const trace = await collectTrace(run, store, grades);
	assert.deepEqual(attribute(run, trace, grades).map(failure => failure.category),
		["model_proposal_failure", "tool_contract_failure", "tool_execution_failure"]);
});

test("TRACE-073-02 missing receipts stay unknown and declared evidence changes or escapes are rejected", async t => {
	const root = await mkdtemp(join(tmpdir(), "axiom-trace-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	const trace = await collectTrace(run, new TraceEvidence(root, []), grades);
	assert.equal(attribute(run, trace, grades)[0].evidence_status, "insufficient");
	assert.equal(attribute(run, trace, grades)[0].category, "unknown");
	assert.equal(attribute(run, trace, grades)[0].root_cause_hypothesis, null);
	await writeFile(join(root, "observed.json"), "{}");
	const original = await digest(root, "observed.json");
	assert.throws(() => new TraceEvidence(root, [{ ...original, path: "../observed.json" }]), /Invalid trace evidence/);
	await writeFile(join(root, "observed.json"), '{"replaced":true}');
	await assert.rejects(new TraceEvidence(root, [original]).verifyAll(), /digest mismatch/);
	await rm(join(root, "observed.json"));
	await assert.rejects(new TraceEvidence(root, [original]).verifyAll(), /unavailable/);
	assert.equal(new Set(failureCases.map(item => item.id)).size, failureCases.length);
});

test("TRACE-073-03 formal incomplete comparison counts planned trials and withholds pass@k", () => {
	const [item] = selectCases(undefined, ["T3-COMP-01"]);
	const plan = schedule([item], 3);
	const [group] = summarize(plan, [{ ...grades, task_success: { status: "pass", checks: [] },
		status: "completed", usage: { requests: 1, tokens: 1, estimated_cost_usd: 0 }, failures: [], wall_seconds: 1 }], "formal");
	assert.equal(group.status, "incomplete");
	assert.deepEqual([group.planned, group.executed, group.passed], [3, 1, 1]);
	assert.equal(group.success_rate, 1 / 3);
	assert.equal(group.executed_success_rate, 1);
	assert.ok(group.passes.every(point => point.pass_at_k === null));
	assert.equal(group.runs[2].status, "not_started");
});

test("TRACE-073-04 real recovery preserves a prior AST rejection, unique training operations and historical scores", { timeout: 210_000 }, async t => {
	const output = await mkdtemp(join(tmpdir(), "axiom-trace-recovery-"));
	t.after(() => rm(output, { force: true, recursive: true }));
	const repo = resolve(".");
	const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	const [item] = selectCases("trace", []);
	const { root, results: [result] } = await runBatch(repo, python, output, [item], AbortSignal.timeout(190_000));
	const path = join(root, item.id);
	assert.equal(result.matches_expected, true, result.failures.join(", "));
	assert.equal(result.task_success.status, "fail");
	assert.equal(result.harness_correctness.status, "pass");
	const trace = (await readFile(join(path, "trace.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
	assert.equal(new Set(trace.map(event => event.event_id)).size, trace.length);
	assert.equal(trace.find(event => event.type === "durable_recovery").status, "resumed");
	assert.equal(trace.find(event => event.error_category === "invalid_candidate").recovery_epoch, 0);
	assert.equal(trace.filter(event => event.type === "training" && event.status === "started").length, 1);
	const { failures } = await read(path, "attribution.json");
	assert.deepEqual(failures.map(failure => failure.category), ["invalid_candidate"]);
	assert.equal(failures[0].impact.harness_correctness, "pass");
	assert.ok(failures[0].evidence.some(proof => proof.path === "final/commands/004.json"));
	assert.deepEqual(await verifyRun(repo, path), result);
	await writeFile(join(path, "attribution.json"), "{}");
	await assert.rejects(verifyRun(repo, path), /digest mismatch/);
});

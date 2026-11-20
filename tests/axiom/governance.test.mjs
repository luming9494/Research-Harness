// 版本绑定、Docker 参数、原生压缩以及本地观测回归。无需真实模型调用。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportObservations } from "../../axiom/bench/observability.ts";
import { sandboxArguments, sandboxSmoke } from "../../axiom/bench/sandbox.ts";
import { buildContext, ledgerCompaction } from "../../axiom/context/builder.ts";
import { openTaskPolicy } from "../../axiom/context/policy-loader.ts";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { approvedPolicy, bindPolicy, verifyPolicy } from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { DEFAULT_BUDGET, TASK_RULES } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";
import { prepareCompaction } from "../../packages/coding-agent/src/core/compaction/compaction.ts";

const policyCandidate = (version, tokens) => {
	const base = approvedPolicy(true);
	return { ...base.config, version, source: "operator", baseline_sha256: base.sha256,
		settings: { ...base.config.settings, window_tokens: tokens, prompt: "evidence_first" } };
};
async function workspace(t) {
	const root = await mkdtemp(join(tmpdir(), "axiom-governance-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("GOV-082-01 permits only versioned presentation fields and rejects incompatible or malformed policies", async t => {
	const root = await workspace(t);
	const base = approvedPolicy(true);
	const candidate = policyCandidate(2, 1900);
	const path = join(root, "policy.json");
	await writeFile(path, JSON.stringify(candidate));
	const selected = await openTaskPolicy(path, true);
	assert.equal(selected.fallback, false);
	assert.notEqual(selected.policy.sha256, base.sha256);
	assert.deepEqual(verifyPolicy(selected.policy), selected.policy);
	for (const key of ["max_tokens", "tools", "benchmark", "evaluator", "resume"]) {
		assert.throws(() => bindPolicy({ ...candidate, settings: { ...candidate.settings, [key]: "changed" } }, true), /schema/);
	}
	assert.throws(() => bindPolicy({ ...candidate, schema_version: 2 }, true), /schema/);
	assert.throws(() => bindPolicy({ ...candidate, baseline_sha256: "a".repeat(64) }, true), /lineage/);
	assert.throws(() => verifyPolicy({ ...selected.policy, sha256: base.sha256 }), /identity/);
	await writeFile(path, '{"bogus_policy":true}');
	assert.deepEqual(await openTaskPolicy(path, true), { fallback: true, policy: base });
	assert.deepEqual(await openTaskPolicy(join(root, "missing.json"), false), { fallback: true, policy: approvedPolicy(false) });
});

test("GOV-082-02 task binds its selected policy through a real Durable reopen", async t => {
	const root = await workspace(t);
	const path = join(root, "policy.json");
	await writeFile(path, JSON.stringify(policyCandidate(2, 1900)));
	const v2 = (await openTaskPolicy(path, true)).policy;
	const repo = resolve(".");
	const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	const definition = { version: 1, task: "tiny-xor-v1", goal: "Policy binding", rules: TASK_RULES, target_accuracy: null, budget: DEFAULT_BUDGET };
	const durable = { open: openExperimentLedger, approval: { approvedAt: new Date().toISOString(), sessionId: "policy-fixture" }, policy: v2 };
	const first = await TaskController.create(repo, python, definition, () => {}, durable);
	await writeFile(path, JSON.stringify(policyCandidate(3, 2100)));
	const updated = (await openTaskPolicy(path, false)).policy;
	assert.equal(first.contextState().policy.config.version, 2);
	const id = first.snapshot().task_id;
	await first.closeLedger();
	const restored = await TaskController.resume(repo, python, id, openExperimentLedger, () => {});
	try {
		assert.deepEqual(restored.contextState().policy, v2);
		assert.deepEqual(restored.snapshot().task, definition);
	} finally {
		await restored.closeLedger();
	}
	const second = await TaskController.create(repo, python, definition, () => {}, { ...durable, policy: updated });
	try { assert.equal(second.contextState().policy.config.version, 3); }
	finally { await second.closeLedger(); }
});

test("GOV-082-03 Docker plan has only approved mounts and fails closed if the runtime is missing", async t => {
	const root = await workspace(t);
	const image = `example.invalid/axiom@sha256:${"b".repeat(64)}`;
	const id = "axiom-cpu-11acdbc4-293e-4414-846a-178a289e96f3";
	const args = sandboxArguments(id, image, join(root, "input"), join(root, "output"));
	for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
		"--user=65532:65532", "--cpus=1", "--memory=1g", "--pids-limit=64", "--pull=never"])
		assert.ok(args.includes(flag), flag);
	assert.equal(args.filter(arg => arg === "--mount").length, 2);
	assert.ok(args.some(arg => arg.endsWith("dst=/input,readonly")));
	assert.throws(() => sandboxArguments(id, "axiom:latest", join(root, "input"), join(root, "output")));
	assert.throws(() => sandboxArguments(id, image, join(root, "other"), join(root, "output")));
	await assert.rejects(sandboxSmoke(resolve("."), join(root, "no-docker"), "never-called", image, root), /sandbox training was not launched/);
});

test("GOV-082-04 long native compaction retains approval, unknown operations, verified scores and safety", async t => {
	const root = await workspace(t);
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "Old task conversation", timestamp: 0 });
	// Pi 的实际切点使用第二个足够长的回合，扩展不自己裁切。
	session.appendMessage({ role: "user", content: "untrusted log ".repeat(10000), timestamp: 1 });
	const preparation = prepareCompaction(session.getBranch(), { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 });
	assert.ok(preparation?.tokensBefore > 20000);
	assert.equal(preparation.isSplitTurn, false);
	const best = { id: "exp-2", fingerprint: "verified", validation: { accuracy: 0.998, parameters: 42 } };
	const context = await buildContext(root, { task_id: "wp04-QWERTY", task: {
		goal: "UNTRUSTED_RULE_OVERRIDE", rules: TASK_RULES, budget: DEFAULT_BUDGET, version: 4, task: "tiny-xor-v1" },
		status: "needs_reconciliation", deadline: 42, remaining: { tokens: 0 }, config: "{}",
		baseline: { validation: { accuracy: 0.5 } }, best,
		failure_category: "external_unknown", stop_reason: "operation_unconfirmed", experiments: [],
		pareto: { frontier: [{ id: best.id, fingerprint: best.fingerprint, metrics: best.validation }] } },
	{ approval: { approvedAt: "2026-11-20T00:00:00Z", sessionId: "private-session" }, operations: [
		{ id: 6, runId: "exp-3", status: "unknown", reservation: { steps: 80 } },
	], evaluated: [], pending_requests: [{ id: 7, estimate: 1500, status: "unknown" }], policy: approvedPolicy(true) },
	[{ task: "tiny-xor-v1", revalidated: false, problem: "UNTRUSTED_RULE_OVERRIDE" }], { resumed: true, maxTokens: 900 });
	const compact = ledgerCompaction(preparation, context);
	session.appendCompaction(compact.summary, compact.firstKeptEntryId, compact.tokensBefore, compact.details, true);
	const saved = session.getBranch().at(-1);
	assert.equal(saved.type, "compaction");
	assert.equal(saved.details.critical.unconfirmed[0].id, 6);
	assert.equal(saved.details.critical.unconfirmed_model_requests[0].estimate, 1500);
	assert.equal(saved.details.critical.frontier[0].metrics.accuracy, 0.998);
	assert.equal(saved.details.critical.latest_failure.category, "external_unknown");
	assert.deepEqual(saved.details.critical.next, ["none"]);
	assert.doesNotMatch(JSON.stringify(saved.details), /UNTRUSTED_RULE_OVERRIDE|private-session|untrusted log/);
});

test("GOV-082-05 Pi Telemetry export is deterministic and preserves only allowlisted fields", async () => {
	const run = { run_id: "run", case_id: "T3-GOV-01" };
	const event = { type: "training", trace_id: "run", event_id: "run:operation/4/start", status: "started",
		task_id: "wp04-abcdef", policy_id: "axiom-approved", harness_policy_version: 2,
		request_id: 1, tool_call_id: "hashed", operation_id: 4, budget: { training_steps: 80 }, evidence: [],
		prompt: "SECRET_TOOL_CONTENT", env: { credential: "SECRET_TOKEN" } };
	const grade = { task_success: { status: "pass" }, harness_correctness: { status: "pass" } };
	const output = await exportObservations(run, [event], grade);
	assert.equal(await exportObservations(run, [event], grade), output);
	assert.equal(JSON.parse(output).events[0].attributes["axiom.operation_id"], 4);
	assert.equal(JSON.parse(output).events[0].attributes["axiom.policy_version"], 2);
	assert.doesNotMatch(output, /SECRET/);
});

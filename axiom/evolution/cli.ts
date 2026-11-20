// 主机串行评测两轮模型提案，写入不可覆盖的审计记录，不修改运行中的策略。
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	approvedPolicy,
	type PolicyBinding,
	verifyPolicy,
} from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { selectCases } from "../bench/cases.ts";
import { digest, file, json, sha256 } from "../bench/io.ts";
import { type Result, runBatch, verifyRun } from "../bench/runner.ts";
import { type FailureEvidence, intake } from "./evidence.ts";
import { type Candidate, type Decision, decide, propose, selectionProtocol } from "./policy.ts";
import { type ProposalReply, proposalModel, requestProposal } from "./proposal-rpc.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const [item] = selectCases(undefined, [selectionProtocol.case_id]);
const operatorEnv = ["AXIOM_HARNESS_POLICY", "AXIOM_CONTEXT_EXPERIENCE", "AXIOM_BENCH_RESUME_POLICY"] as const;

type Trial = {
	root: string;
	manifest_sha256: string;
	result_sha256: string;
	result: Result;
	verified: boolean;
	environment_sha256: string;
};

// 对照必须绑定实际应用的策略，回退到批准版不能算候选成绩。
async function verifyTrial(root: string, policy: PolicyBinding): Promise<Trial> {
	const raw = JSON.parse((await file(root, "result.json")).toString("utf8")) as Result;
	const manifest = await digest(root, "manifest.json");
	const summary = await digest(root, "result.json");
	const environment = JSON.parse((await file(root, "manifest.json")).toString("utf8")) as {
		environment: Record<string, unknown>;
		inputs: unknown;
	};
	const environmentSha = sha256(JSON.stringify({ environment: environment.environment, inputs: environment.inputs }));
	let checked: Result;
	try {
		checked = await verifyRun(repo, root);
		if (checked.case_id !== item.id) throw new Error("Different development case");
		const ledger = JSON.parse((await file(root, "final/ledger.json")).toString("utf8")) as TaskCheckpoint;
		if (!ledger.policy || verifyPolicy(ledger.policy).sha256 !== policy.sha256 || !ledger.policy.enhanced)
			throw new Error("Policy identity mismatch");
		// 失败的恢复仍应保留独立判题。已证实恢复的运行必须提供中断前的绑定。
		if (checked.context_comparison?.recovered) {
			const before = JSON.parse((await file(root, "before/ledger.json")).toString("utf8")) as TaskCheckpoint;
			if (!before.policy || verifyPolicy(before.policy).sha256 !== policy.sha256 || !before.policy.enhanced)
				throw new Error("Policy recovery identity mismatch");
		}
	} catch {
		return {
			root,
			manifest_sha256: manifest.sha256,
			result_sha256: summary.sha256,
			result: raw,
			verified: false,
			environment_sha256: environmentSha,
		};
	}
	return {
		root,
		manifest_sha256: manifest.sha256,
		result_sha256: summary.sha256,
		result: checked,
		verified: true,
		environment_sha256: environmentSha,
	};
}

// 只发送核验过的数值、归因事实与证据 ID。模型理由不会晋升成后续提示规则。
function proposalPrompt(evidence: readonly FailureEvidence[], parent: PolicyBinding, feedback: object | null): string {
	return `Propose one independently testable presentation-only policy revision for a Tiny CPU research harness.
Return exactly one JSON object with keys settings, hypothesis, target_metrics. No other keys or tools.
settings must include changed fields only: prompt=balanced|evidence_first, window_tokens integer 900..3200,
priorities={recent,operations,experience,artifacts} all integers 0..100 if supplied,
feedback=summary|structured, experience_limit integer 0..8, error_detail=category|reason.
hypothesis is a short explanation (max 500 characters). target_metrics uses one or more of
input_tokens, repair, error_visibility, recovery, task_success. Never propose permissions, budgets,
scoring changes, arbitrary prompt text or training changes. Prefer a distinct material change.
Preserve actionable AST errors and successful recovery, and target 5% lower input tokens without reduced task success.
Use the structured facts below. A recorded rejection does not establish the root cause.
Current settings: ${JSON.stringify(parent.config.settings)}
Failure evidence: ${JSON.stringify(evidence)}
Revision feedback: ${JSON.stringify(feedback)}`;
}

async function register(
	root: string,
	round: number,
	parent: PolicyBinding,
	evidence: readonly FailureEvidence[],
	feedback: object | null,
	signal: AbortSignal,
): Promise<{ candidate: Candidate; id: string; usage: ProposalReply["usage"][] } | undefined> {
	const usage: ProposalReply["usage"][] = [];
	let reason: string | null = null;
	for (let attempt = 1; attempt <= 2 && !signal.aborted; attempt++) {
		const reply = await requestProposal(
			repo,
			proposalPrompt(evidence, parent, reason ? { feedback, previous_proposal_rejected: reason } : feedback),
			signal,
		);
		usage.push(reply.usage);
		const id = randomUUID();
		const createdAt = new Date().toISOString();
		const envelope = {
			schema_version: 1,
			candidate_id: id,
			round,
			attempt,
			created_at: createdAt,
			parent_sha256: parent.sha256,
			failure_ids: evidence.map((entry) => entry.failure_id),
			model: proposalModel,
			usage: reply.usage,
			response_sha256: reply.text ? sha256(reply.text) : null,
		};
		let candidate: Candidate;
		try {
			if (reply.error) throw new Error(reply.error);
			candidate = propose(reply.text, parent, round + 1, createdAt);
		} catch (error) {
			reason =
				reply.error ??
				(error instanceof SyntaxError
					? "invalid_json"
					: error instanceof Error && error.message === "no_policy_change"
						? "no_policy_change"
						: "invalid_or_duplicate_policy");
			await json(root, `candidates/${id}/proposal.json`, {
				...envelope,
				status: "invalid",
				outcome: "rejected",
				reason,
			});
			continue;
		}
		await json(root, `candidates/${id}/proposal.json`, { ...envelope, status: "proposed", ...candidate });
		await json(root, `candidates/${id}/policy.json`, candidate.binding.config);
		return { candidate, id, usage };
	}
	return undefined;
}

async function evaluate(
	root: string,
	python: string,
	policy: PolicyBinding,
	policyPath: string | undefined,
	count: number,
	signal: AbortSignal,
): Promise<Trial[]> {
	const previous = operatorEnv.map((key) => process.env[key]);
	const trials: Trial[] = [];
	try {
		for (const key of operatorEnv) delete process.env[key];
		if (policyPath) process.env.AXIOM_HARNESS_POLICY = policyPath;
		for (let run = 0; run < count && !signal.aborted; run++) {
			const batch = await runBatch(repo, python, root, [item], signal);
			if (batch.results.length) trials.push(await verifyTrial(join(batch.root, item.id), policy));
		}
	} finally {
		for (const [index, key] of operatorEnv.entries()) {
			const value = previous[index];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	return trials;
}

function feedbackFor(baseline: readonly Trial[], trials: readonly Trial[], decision: Decision): object {
	const report = (run: Trial): object => ({
		run_id: run.result.run_id,
		result_sha256: run.result_sha256,
		verified: run.verified,
		...(run.verified
			? {
					task_success: run.result.task_success.status,
					harness_correctness: run.result.harness_correctness.status,
					context: run.result.context_comparison,
					training_launches: run.result.execution?.training_launches,
					duplicate_launches: run.result.execution?.duplicate_launches,
				}
			: {}),
	});
	return { decision, baseline: baseline.map(report), previous_policy: trials.map(report) };
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			evidence: { type: "string" },
			"evidence-sha256": { type: "string" },
			out: { type: "string" },
			baseline: { type: "string" },
			repeats: { type: "string" },
		},
	});
	const repeats = Number(values.repeats ?? "1");
	if (
		!values.evidence ||
		!/^[a-f0-9]{64}$/.test(values["evidence-sha256"] ?? "") ||
		![1, 2].includes(repeats) ||
		(values.baseline && repeats !== 1)
	)
		throw new Error("Usage: --evidence DIR --evidence-sha256 SHA256 [--baseline DIR] [--out DIR] [--repeats 1|2]");
	const output = resolve(values.out ?? join(repo, "private/axiom-evolution"));
	await mkdir(output, { recursive: true });
	const id = randomUUID();
	const root = join(await realpath(output), id);
	await mkdir(root);
	const python = resolve(
		process.env.AXIOM_PYTHON ??
			join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
	);
	const duration = AbortSignal.timeout(6 * item.timeout_ms + 6 * 90_000);
	const stop = new AbortController();
	const interrupt = (): void => stop.abort();
	process.once("SIGINT", interrupt);
	const signal = AbortSignal.any([duration, stop.signal]);
	console.log(JSON.stringify({ root }));
	const source = await realpath(values.evidence);
	await json(root, "plan.json", {
		schema_version: 1,
		id,
		source,
		source_sha256: values["evidence-sha256"],
		model: proposalModel,
		selection: selectionProtocol,
		case_version: item.version,
		repeats,
		rounds: 2,
		max_proposal_requests: 4,
		experiment: "development_only",
	});
	const evidence = await intake(source, values["evidence-sha256"] ?? "", root);
	if (!evidence.length) throw new Error("No independently supported failure in development archive");
	await json(root, "failure-evidence.json", evidence);
	const approved = approvedPolicy(true);
	const baseline = values.baseline
		? [await verifyTrial(await realpath(values.baseline), approved)]
		: await evaluate(join(root, "baseline"), python, approved, undefined, repeats, signal);
	await json(root, "baseline.json", baseline);
	const results: {
		id: string;
		policy: PolicyBinding;
		decision: Decision;
		trials: Trial[];
		proposal_usage: ProposalReply["usage"][];
	}[] = [];
	let parent = approved;
	let feedback: object | null = null;
	for (let round = 1; round <= 2 && !signal.aborted && baseline.some((trial) => trial.verified); round++) {
		const registration = await register(root, round, parent, evidence, feedback, signal);
		if (!registration) break;
		const { candidate, id: candidateId, usage } = registration;
		const candidateRoot = join(root, "candidates", candidateId);
		const trials = await evaluate(
			join(candidateRoot, "runs"),
			python,
			candidate.binding,
			join(candidateRoot, "policy.json"),
			repeats,
			signal,
		);
		const matched =
			baseline.length === repeats &&
			trials.length === repeats &&
			baseline.every(
				(base, index) =>
					base.verified && trials[index].verified && base.environment_sha256 === trials[index].environment_sha256,
			);
		const decision: Decision = matched
			? decide(
					baseline.map((run) => run.result),
					trials.map((run) => run.result),
				)
			: { outcome: "inconclusive", reasons: ["unverified_or_unmatched_runs"] };
		feedback = feedbackFor(baseline, trials, decision);
		await json(candidateRoot, "evaluation.json", {
			schema_version: 1,
			candidate_id: candidateId,
			policy_sha256: candidate.binding.sha256,
			status: "evaluated",
			trials,
			decision,
			feedback,
		});
		results.push({ id: candidateId, policy: candidate.binding, decision, trials, proposal_usage: usage });
		parent = candidate.binding;
	}
	await json(root, "result.json", {
		schema_version: 1,
		status: results.length === 2 ? "completed" : "incomplete",
		baseline,
		results,
	});
	console.log(JSON.stringify({ root, candidates: results.map(({ id, decision }) => ({ id, decision })) }));
	if (results.length !== 2) process.exitCode = 1;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Evolution failed");
	process.exitCode = 1;
});

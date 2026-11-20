// 独立判题只读取主机归档证据，不读取模型回复中的分数或结论。
import type { ArtifactManifest, RunResult } from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import type { TaskCheckpoint, TaskSummary } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import type { BenchCase } from "./cases.ts";
import type { Verification } from "./execute.ts";
import { file, sha256 } from "./io.ts";
import type { LiveTrace } from "./live.ts";

type CheckStatus = "pass" | "fail" | "unknown";
export interface Check {
	id: string;
	weight: number;
	status: CheckStatus;
	evidence: string[];
}
export interface Score {
	status: CheckStatus;
	score: number | null;
	checks: Check[];
}
export interface Grades {
	task_success: Score;
	harness_correctness: Score;
}
export interface Grading extends Grades {
	usage: { requests: number | null; tokens: number | null; estimated_cost_usd: number | null };
	compute_seconds: number | null;
	torch: string | null;
	context_comparison?: {
		mode: "baseline" | "enhanced";
		input_tokens: number | null;
		recovered: boolean;
		error_visible: boolean;
		actionable_error: boolean;
		repair: "repaired" | "no_opportunity" | "repeated_illegal" | "unknown";
	};
	evaluation: { label: string; id: string; result: Record<string, unknown>; evidence: string }[];
	execution?: {
		outcome: string;
		stop_reason: string | null;
		full_candidates: number;
		baseline_accuracy: number | null;
		training_steps: number;
		training_launches: number;
		duplicate_launches: number;
		failure_category: string | null;
		provider_overrun: boolean;
	};
}
type Outcome = { valid: boolean; evidence: string[] };
interface Observation {
	rejected?: string;
	commands?: string[];
	accepted?: boolean;
	offered?: { validation: { level: string } };
	launches?: string[];
	first?: { budget: TaskSummary["budget"] };
	final?: TaskSummary & { experiments: { status: string; reused_from?: string }[] };
	interrupted?: boolean;
	resumed?: string | boolean;
	tools?: LiveTrace["tools"];
	turns?: LiveTrace["turns"];
	usage?: LiveTrace["usage"];
	context?: LiveTrace["context"];
	feedback?: LiveTrace["feedback"];
	floor_published_directory?: boolean;
	barrier?: boolean;
	error?: string | null;
}

// 权重仅作用于当前维度，缺少可信证据时分数为 null。
export function scoreAxis(rules: BenchCase["scoring"]["task"], observations: Readonly<Record<string, Outcome>>): Score {
	const checks: Check[] = rules.map(({ id, weight }) => {
		const observation = observations[id];
		return {
			id,
			weight,
			status: observation ? (observation.valid ? "pass" : "fail") : "unknown",
			evidence: observation?.evidence ?? [],
		};
	});
	const unknown = checks.some((check) => check.status === "unknown");
	const score = unknown
		? null
		: Math.round(
				(100 * checks.reduce((sum, rule) => sum + (rule.status === "pass" ? rule.weight : 0), 0)) /
					checks.reduce((sum, rule) => sum + rule.weight, 0),
			);
	return {
		status: checks.some((check) => check.status === "fail") ? "fail" : unknown ? "unknown" : "pass",
		score,
		checks,
	};
}

export function independentGrades(
	item: BenchCase,
	task: Record<string, Outcome>,
	harness: Record<string, Outcome>,
): Grades {
	return {
		task_success: scoreAxis(item.scoring.task, task),
		harness_correctness: scoreAxis(item.scoring.harness, harness),
	};
}

export async function grade(item: BenchCase, root: string): Promise<Grading> {
	const observed = await read<Observation>(root, "observed.json");
	if (item.mode === "deterministic") return gradeDeterministic(item, root, observed);
	const state = await read<TaskCheckpoint>(root, "final/ledger.json");
	const verify = await read<Verification[]>(root, "verification.json");
	const byLabel = (label: string): Verification[] => verify.filter((entry) => entry.label === label);
	const delivery = state.summary.delivery;
	const selected =
		state.summary.pareto?.decision?.selected.map((point) => point.id) ?? (delivery ? [delivery.best_id] : []);
	const evaluation = [];
	let torch: string | null = null;
	for (const entry of verify) {
		const result = await read<Record<string, unknown>>(root, entry.score_path);
		evaluation.push({ label: entry.label, id: entry.id, result, evidence: entry.score_path });
		const metadata = await read<{ torch_version?: string }>(root, `${entry.directory}/run.json`);
		torch ??= metadata.torch_version ?? null;
	}
	const finalProof = byLabel("final");
	const deliveryPath = "final/delivery.json";
	const archivedDelivery = delivery ? await read<ArtifactManifest>(root, deliveryPath) : undefined;
	const manifestMatches = Boolean(delivery && JSON.stringify(archivedDelivery) === JSON.stringify(delivery));
	const complete =
		selected.length > 0 &&
		same(
			selected,
			finalProof.map((entry) => entry.id),
		) &&
		manifestMatches;
	let sound = complete;
	for (const entry of finalProof) sound = (await matchesRun(root, state, entry)) && sound;
	const finalScores = evaluation.filter((entry) => entry.label === "final");
	const baseline = state.evaluated.find((run) => run.id === "baseline")?.validation.accuracy;
	const quality =
		sound &&
		finalScores.some(
			({ result }) =>
				typeof result.accuracy === "number" &&
				result.accuracy >= (item.accuracy_floor ?? 0) &&
				(!item.comparison || (typeof baseline === "number" && result.accuracy > baseline)),
		);
	const proofs = [
		"final/ledger.json",
		"verification.json",
		...finalProof.flatMap((entry) => [entry.score_path, `${entry.directory}/checkpoint.pt`]),
		...(delivery ? [deliveryPath] : []),
	];
	const usage = usageReport(item, state, observed);
	const checks: Record<string, Outcome> = {};
	const intentionalPause =
		item.comparison?.task === "interruption" &&
		item.comparison.arm !== "B2" &&
		observed.barrier === true &&
		!observed.resumed &&
		!observed.error;
	// 复验恢复之前已提交的拒绝，命令、失败行和预算必须完整继承。
	if (item.id === "T2-TRACE-01") {
		const before = await read<TaskCheckpoint>(root, "before/ledger.json");
		checks.recovery_history = outcome(
			observed.interrupted === true &&
				observed.resumed === state.taskId &&
				before.taskId === state.taskId &&
				before.deadline === state.deadline &&
				same(before.commands, state.commands) &&
				same(before.rows, state.rows) &&
				before.rows.some((row) => row.failure_category === "invalid_candidate") &&
				before.summary.budget.training_steps_reserved === 80 &&
				state.summary.budget.training_steps_reserved === 80,
			"before/ledger.json",
			"final/ledger.json",
			"observed.json",
		);
	}
	checks.budget = outcome(validBudget(item, state, intentionalPause), "final/ledger.json");
	checks.operations = outcome(
		await verifyOperations(root, state, observed, item.context === "enhanced"),
		"final/ledger.json",
		"final/events.jsonl",
		...state.commands
			.filter((op) => "recordSha256" in op)
			.map((op) => `final/commands/${String(op.id).padStart(3, "0")}.json`),
	);
	// 缺少任务交付本身属于任务轴。只有声称存在交付时才要求对应可核验证据。
	checks.provenance = outcome(delivery ? sound : selected.length === 0 && finalProof.length === 0, ...proofs);
	const fullCandidates = state.evaluated.filter((run) => run.id !== "baseline" && run.validation.level === "full");
	const distinctFull = new Set(fullCandidates.map((run) => run.fingerprint)).size;
	let contextComparison: Grading["context_comparison"];
	if (item.context) {
		// 恢复以同一审批、期限、预算和命令前缀为准，另检查增强窗真正进入请求前的回执。
		const before = observed.barrier ? await read<TaskCheckpoint>(root, "before/ledger.json") : undefined;
		const receipt = observed.context?.find((window) => window.recovery);
		const sameCheckpoint = Boolean(
			before &&
				observed.resumed === true &&
				before.taskId === state.taskId &&
				before.deadline === state.deadline &&
				same(before.approval, state.approval) &&
				same(before.spec, state.spec) &&
				before.summary.budget.training_steps_reserved === 162 &&
				state.summary.budget.training_steps_reserved >= 162 &&
				same(before.commands, state.commands.slice(0, before.commands.length)) &&
				same(before.evaluated, state.evaluated.slice(0, before.evaluated.length)) &&
				before.rows.some((row) => row.failure_category === "invalid_candidate"),
		);
		const restored =
			sameCheckpoint &&
			(item.context === "baseline" ||
				Boolean(
					before &&
						receipt &&
						receipt.task_id === state.taskId &&
						receipt.deadline_ms === state.deadline &&
						receipt.approval?.sha256 === sha256(JSON.stringify(state.approval)) &&
						receipt.best &&
						before.evaluated.some((run) => run.id === receipt.best?.id && run.id !== "baseline") &&
						receipt.remaining.training_steps === 82 &&
						receipt.remaining.experiments === 1 &&
						receipt.failure?.category === "invalid_candidate",
				));
		checks.context_recovery = outcome(
			restored,
			"observed.json",
			"final/ledger.json",
			...(before ? ["before/ledger.json"] : []),
		);
		const invalid = state.rows.findIndex((row) => row.failure_category === "invalid_candidate");
		const after = invalid >= 0 ? state.rows.slice(invalid + 1) : [];
		const input = observed.usage?.map((request) => request.input_tokens);
		contextComparison = {
			mode: item.context,
			input_tokens:
				input?.length && input.length === state.requests.length && input.every((value) => typeof value === "number")
					? input.reduce<number>((total, value) => total + (value ?? 0), 0)
					: null,
			recovered: restored,
			error_visible: Boolean(observed.feedback?.some((row) => row.error_visible) || receipt?.failure),
			actionable_error: Boolean(observed.feedback?.some((row) => row.actionable) || receipt?.failure?.reason),
			repair:
				after[0]?.failure_category === "invalid_candidate"
					? "repeated_illegal"
					: after[0]?.status === "evaluated"
						? "repaired"
						: invalid >= 0 && !state.spec.max_revisions
							? "no_opportunity"
							: "unknown",
		};
	}
	const candidateTurns =
		observed.turns?.map((turn) => turn.tools.filter((tool) => tool === "axiom_task_candidate").length) ?? [];
	if (item.comparison) {
		const { task, arm } = item.comparison;
		const spec = state.spec as TaskCheckpoint["spec"] & {
			parameters?: { learning_rate?: { min: number; max: number } };
			starting_model?: string;
		};
		let comparable =
			!observed.error &&
			spec.version === 2 &&
			spec.goal === item.description &&
			(spec.starting_model ?? "linear") === item.comparison.starting_model &&
			same(spec.parameters?.learning_rate, item.comparison.learning_rate);
		const evidence = ["observed.json", "final/ledger.json"];
		if (task === "interruption" && observed.barrier) {
			const before = await read<TaskCheckpoint>(root, "before/ledger.json");
			evidence.push("before/ledger.json");
			// 能恢复的组必须延续原身份、审批、预算和真实启动记录；其他组应在边界后不再执行。
			comparable &&=
				before.taskId === state.taskId &&
				before.deadline === state.deadline &&
				same(before.approval, state.approval) &&
				same(before.spec, state.spec) &&
				before.evaluated.length === 1 &&
				before.evaluated[0].id === "baseline" &&
				(arm === "B2"
					? observed.resumed === true && same(before.commands, state.commands.slice(0, before.commands.length))
					: intentionalPause && same(before, state));
		} else if (task === "interruption") comparable = false;
		checks.comparison = outcome(comparable, ...evidence);
	}
	if (item.id === "T2-DUR-01") {
		const before = await read<TaskCheckpoint>(root, "before/ledger.json");
		checks.recovery = outcome(
			observed.interrupted === true &&
				observed.resumed === state.taskId &&
				before.taskId === state.taskId &&
				before.deadline === state.deadline &&
				same(before.spec, state.spec) &&
				same(before.commands, state.commands.slice(0, before.commands.length)) &&
				same(before.evaluated, state.evaluated.slice(0, before.evaluated.length)) &&
				before.summary.budget.training_steps_reserved === 162 &&
				state.summary.budget.training_steps_reserved === 244 &&
				state.summary.stop_reason === "experiment_budget_exhausted" &&
				state.rows.some((row) => row.status === "cache_hit"),
			"observed.json",
			"before/ledger.json",
			"final/ledger.json",
		);
	}
	if (item.id === "T2-SEARCH-01" || item.id === "T2-SEARCH-02") {
		const before = await read<TaskCheckpoint>(root, "before/ledger.json");
		const row = state.rows[0];
		const staged = row?.staged;
		let stages = Boolean(
			staged?.decision?.action === "promoted" &&
				staged.full &&
				before.rows[0]?.staged?.proxy &&
				!before.rows[0]?.staged?.decision &&
				observed.interrupted &&
				observed.resumed === state.taskId &&
				before.taskId === state.taskId &&
				same(before.commands, state.commands.slice(0, before.commands.length)) &&
				state.commands.filter((op) => op.reservation && op.stage === "full").length === 2 &&
				state.commands.filter((op) => op.reservation && op.stage === "proxy").length === 1 &&
				state.commands.filter((op) => op.reservation && op.stage === "smoke").length === 1 &&
				state.evaluated.every((run) => run.validation.level === "full") &&
				state.summary.fidelity?.stages.smoke.committed_training_steps === 2 &&
				state.summary.fidelity.stages.proxy.committed_training_steps === 20 &&
				state.summary.fidelity.stages.full.committed_training_steps === 160,
		);
		for (const level of ["smoke", "proxy"] as const) {
			const [proof] = byLabel(level);
			const receipt = staged?.[level]?.result;
			stages = Boolean(proof && receipt && (await matchesRun(root, state, proof, receipt, level))) && stages;
		}
		checks.stages = outcome(
			stages,
			"before/ledger.json",
			"final/ledger.json",
			"verification.json",
			...verify
				.filter((entry) => entry.label === "smoke" || entry.label === "proxy")
				.map((entry) => entry.score_path),
		);
	}
	if (item.id === "T2-PARETO-01") {
		const discarded = byLabel("discarded");
		const verifiedIds = [...finalProof, ...discarded].map((entry) => entry.id).sort();
		let frontier = sound && discarded.length > 0 && same(verifiedIds, state.evaluated.map((run) => run.id).sort());
		for (const entry of discarded) frontier = (await matchesRun(root, state, entry)) && frontier;
		// 判题器使用独立的两两比较，以这组具有清晰余量的实测分数复查前沿。
		const runs = state.evaluated;
		const coordinates = (run: RunResult): number[] => [
			Number(run.validation.accuracy),
			-Number(run.validation.parameters),
			-Number(run.validation.loss),
		];
		const expected = runs
			.filter(
				(target) =>
					!runs.some((other) => {
						const values = coordinates(other);
						const candidate = coordinates(target);
						return (
							values.every((value, index) => value >= candidate[index]) &&
							values.some((value, index) => value > candidate[index])
						);
					}),
			)
			.map((run) => run.id)
			.sort();
		checks.pareto = outcome(
			frontier &&
				verifyThreeObjectives(state) &&
				state.summary.pareto?.decision?.preference.strategy === "frontier" &&
				same(expected, [...selected].sort()),
			"final/ledger.json",
			...proofs,
			...discarded.map((entry) => entry.score_path),
		);
		const floor = await read<TaskCheckpoint>(root, "floor/ledger.json");
		const reopened = await read<TaskCheckpoint>(root, "floor-reopened/ledger.json");
		const negative = byLabel("floor");
		let safelyBelow =
			negative.length > 0 &&
			same(
				negative.map((entry) => entry.id),
				floor.evaluated.map((entry) => entry.id),
			);
		for (const entry of negative)
			safelyBelow =
				(await matchesRun(root, floor, entry)) &&
				Number(floor.evaluated.find((run) => run.id === entry.id)?.validation.accuracy) < 1 &&
				safelyBelow;
		checks.no_feasible = outcome(
			safelyBelow &&
				verifyThreeObjectives(floor) &&
				floor.summary.pareto?.decision?.reason === "no_feasible_candidate" &&
				floor.summary.status === "completed" &&
				floor.delivered &&
				!floor.deliveryStarted &&
				!floor.summary.delivery &&
				observed.floor_published_directory === false &&
				same(floor.commands, reopened.commands) &&
				same(floor.summary, reopened.summary),
			"observed.json",
			"floor/ledger.json",
			"floor-reopened/ledger.json",
			...negative.map((entry) => entry.score_path),
		);
	}
	if (item.mode === "live_agent" && !state.summary.budget.usage_uncertain && observed.usage?.length)
		checks.usage = outcome(
			usage.tokens !== null &&
				usage.tokens > 0 &&
				usage.requests === state.summary.budget.model_requests &&
				usage.tokens === state.summary.budget.tokens_actual &&
				Boolean(observed.usage?.every((request) => `${request.provider}/${request.model}` === item.model)),
			"observed.json",
			"final/ledger.json",
		);
	return {
		...independentGrades(
			item,
			{
				independent_delivery: outcome(sound, ...proofs),
				quality_floor: outcome(quality, ...proofs),
				full_candidates: outcome(distinctFull >= (item.comparison?.min_full_candidates ?? 0), "final/ledger.json"),
				feedback_turns: outcome(
					candidateTurns.filter((count) => count === 1).length >= 2 && candidateTurns.every((count) => count <= 1),
					"observed.json",
				),
			},
			checks,
		),
		usage,
		compute_seconds: state.summary.budget.compute_process_seconds,
		evaluation,
		torch,
		...(contextComparison ? { context_comparison: contextComparison } : {}),
		execution: {
			outcome: observed.error ? "rpc_error" : intentionalPause ? "safe_interruption" : state.summary.status,
			stop_reason: state.summary.stop_reason ?? null,
			full_candidates: fullCandidates.length,
			baseline_accuracy: typeof baseline === "number" ? baseline : null,
			training_steps: state.summary.budget.training_steps_reserved,
			training_launches: state.commands.filter(
				(op) => op.reservation && op.status !== "not_started" && op.status !== "intent",
			).length,
			duplicate_launches: duplicates(state),
			failure_category: state.summary.failure_category ?? null,
			provider_overrun: state.summary.budget.tokens_actual > item.budget.max_tokens,
		},
	};
}

async function gradeDeterministic(item: BenchCase, root: string, data: Observation): Promise<Grading> {
	const observation = "observed.json";
	const task: Record<string, Outcome> = { usable_output: outcome(false, observation) };
	const checks: Record<string, Outcome> = {};
	if (item.id === "T1-DUR-01" || item.id === "T1-BUD-01") {
		const before = await read<TaskCheckpoint>(root, "before/ledger.json");
		const state = await read<TaskCheckpoint>(root, "final/ledger.json");
		const stable =
			data.interrupted === true &&
			data.resumed === state.taskId &&
			before.taskId === state.taskId &&
			before.deadline === state.deadline &&
			state.commands.length === 0 &&
			!state.summary.delivery;
		checks.unknown_safe = outcome(
			stable &&
				before.requests[0]?.status === "pending" &&
				state.requests[0]?.status === "unknown" &&
				state.summary.status === "needs_reconciliation" &&
				before.summary.budget.tokens_admission_estimate === 1500 &&
				state.summary.budget.tokens_admission_estimate === 1500,
			observation,
			"before/ledger.json",
			"final/ledger.json",
		);
		checks.deadline = outcome(
			stable &&
				state.summary.stop_reason === "wall_budget_exhausted" &&
				state.summary.remaining.wall_seconds === 0 &&
				state.requests.length === 0,
			observation,
			"before/ledger.json",
			"final/ledger.json",
		);
	} else if (item.id === "T1-POL-01" || item.id === "T1-TRACE-02") {
		checks.policy = outcome(
			Boolean(data.rejected?.includes("unapproved candidate parameter")) && data.commands?.length === 0,
			observation,
		);
	} else if (item.id === "T1-EVAL-01") {
		const path = "fixture/pareto-delivery/manifest.json";
		const weight = "fixture/pareto-delivery/exp-1/checkpoint.pt";
		const manifest = await read<{ members: { files: Record<string, string> }[] }>(root, path);
		checks.tamper = outcome(
			Boolean(data.rejected?.includes("member changed")) &&
				sha256(await file(root, weight)) !== manifest.members[0].files["checkpoint.pt"],
			observation,
			path,
			weight,
		);
	} else if (item.id === "T1-SEARCH-01") {
		checks.fidelity = outcome(
			data.accepted === false &&
				data.offered?.validation.level === "proxy" &&
				Boolean(data.rejected?.includes("Full")),
			observation,
		);
	} else {
		const toy = await read<{ predictions: number[]; best_id: string }>(root, "toy-output.json");
		const expected = [0, 1, 2, 3].map((input) => (input >> 1) ^ (input & 1));
		task.usable_output = outcome(
			same(toy.predictions, expected) && toy.best_id === data.final?.delivery?.best_id,
			observation,
			"toy-output.json",
		);
		checks.dedup = outcome(
			same(data.launches, ["baseline", "exp-1"]) &&
				data.final?.experiments[1]?.reused_from === "exp-1" &&
				data.first?.budget.training_steps_reserved === data.final?.budget.training_steps_reserved,
			observation,
			"fixture/events.jsonl",
		);
		checks.budget_limit = outcome(
			same(data.launches, ["baseline"]) &&
				data.final?.stop_reason === "training_step_budget_exhausted" &&
				data.final.budget.training_steps_reserved === item.budget.max_steps,
			observation,
			"fixture/events.jsonl",
		);
	}
	return {
		...independentGrades(item, task, checks),
		usage: { requests: 0, tokens: 0, estimated_cost_usd: null },
		compute_seconds: null,
		evaluation: [],
		torch: null,
	};
}

function validBudget(item: BenchCase, state: TaskCheckpoint, intentionalPause: boolean): boolean {
	const used = state.summary.budget;
	const approved = state.spec.budget;
	const unsettled = state.commands.filter(
		(op) => op.status === "unknown" || op.status === "started" || op.status === "intent" || op.status === "pending",
	);
	const safeTerminal = state.delivered || intentionalPause || state.summary.status === "needs_reconciliation";
	let settledCompute = 0;
	let computeAdmission = true;
	for (const operation of state.commands) {
		if (operation.status === "not_started" || operation.status === "intent") continue;
		computeAdmission &&= settledCompute < approved.compute_process_seconds;
		if ("elapsedMs" in operation) settledCompute += operation.elapsedMs / 1000;
	}
	return (
		approved.training_steps === item.budget.max_steps &&
		approved.max_tokens === item.budget.max_tokens &&
		approved.compute_process_seconds === item.budget.max_compute_seconds &&
		approved.wall_seconds === item.budget.max_task_wall_seconds &&
		approved.max_experiments === item.budget.max_proposals &&
		used.training_steps_reserved <= approved.training_steps &&
		used.training_steps_reserved ===
			state.commands
				.filter((op) => "elapsedMs" in op || unsettled.includes(op))
				.reduce((total, op) => total + (op.reservation?.steps ?? 0), 0) &&
		validAdmission(state) &&
		computeAdmission &&
		used.compute_process_seconds + 0.001 >= settledCompute &&
		used.experiments <= approved.max_experiments &&
		(used.wall_seconds <= approved.wall_seconds || state.summary.stop_reason === "wall_budget_exhausted") &&
		(item.mode === "live_agent" || used.model_requests === 0) &&
		safeTerminal &&
		(unsettled.length === 0 || state.summary.status === "needs_reconciliation") &&
		(state.spec.fidelity === undefined ||
			(state.summary.fidelity?.full_candidates_started ?? Infinity) <= state.spec.fidelity.max_full)
	);
}

// 重算每次准入时的已知用量。单次供应商超额只在后续继续准入时构成违规。
export function validAdmission(state: TaskCheckpoint): boolean {
	const budget = state.summary.budget;
	const limit = state.spec.budget.max_tokens;
	let settled = 0;
	let uncertain = false;
	let held = 0;
	for (const [index, request] of state.requests.entries()) {
		if (
			uncertain ||
			request.id !== index + 1 ||
			!Number.isSafeInteger(request.estimate) ||
			request.estimate <= 0 ||
			settled + request.estimate > limit
		)
			return false;
		const actual = request.status === "pending" ? undefined : request.evidence?.usage.totalTokens;
		if (actual !== undefined && Number.isSafeInteger(actual) && actual >= 0) settled += actual;
		if (request.status === "completed" && (actual === undefined || !Number.isSafeInteger(actual) || actual < 0))
			return false;
		if (request.status !== "completed") {
			uncertain = request.status === "unknown";
			held = request.estimate;
			if (index !== state.requests.length - 1 || !uncertain || state.summary.status !== "needs_reconciliation")
				return false;
		}
	}
	return (
		budget.model_requests === state.requests.length &&
		budget.tokens_actual === settled &&
		budget.usage_uncertain === uncertain &&
		budget.tokens_admission_estimate === held
	);
}

// 分级训练使用分级指纹，同一候选的 Smoke、Proxy、Full 不算重复。
function duplicates(state: TaskCheckpoint): number {
	const started = state.commands.filter(
		(op) => op.reservation && op.status !== "intent" && op.status !== "not_started",
	);
	return started.length - new Set(started.map((op) => op.fingerprint)).size;
}

async function verifyOperations(
	root: string,
	state: TaskCheckpoint,
	observed: Observation,
	artifactTool: boolean,
): Promise<boolean> {
	const allowed = new Set([
		"experiment.py",
		"review_candidate.py",
		"validate_only.py",
		"train.py",
		"pareto_validate.py",
	]);
	const tools = new Set(["axiom_task_inspect", "axiom_task_baseline", "axiom_task_candidate", "axiom_task_finish"]);
	if (artifactTool) tools.add("axiom_task_artifact");
	const events = (await file(root, "final/events.jsonl"))
		.toString("utf8")
		.trim()
		.split(/\r?\n/)
		.filter(Boolean)
		.map(
			(line) =>
				JSON.parse(line) as {
					type: string;
					operation_id?: number;
					script?: string;
					run_id?: string;
					timestamp?: string;
					detail?: { usage?: { totalTokens?: number }; usage_uncertain?: boolean };
				},
		);
	const starts = events.filter((event) => event.type === "process_start");
	// 模型实际超额、未知用量或截止时间出现后，环境不得再接纳 Python 启动。
	let used = 0;
	let uncertain = false;
	for (const event of events) {
		if (event.type === "native_pi_usage") {
			used += event.detail?.usage?.totalTokens ?? 0;
			uncertain ||= event.detail?.usage_uncertain === true;
		}
		if (
			event.type === "process_start" &&
			(uncertain || used >= state.spec.budget.max_tokens || Date.parse(event.timestamp ?? "") > state.deadline)
		)
			return false;
	}
	if (
		observed.tools?.some((tool) => !tools.has(tool)) ||
		new Set(starts.map((event) => event.operation_id)).size !== starts.length
	)
		return false;
	for (const op of state.commands) {
		const event = starts.find((value) => value.operation_id === op.id);
		if (op.status === "not_started") {
			if (event) return false;
			continue;
		}
		if (op.status === "unknown" || op.status === "started" || op.status === "pending" || op.status === "intent") {
			// 不确定操作允许无启动回执，但任务必须安全暂停且后面没有其他启动。
			if (
				state.summary.status !== "needs_reconciliation" ||
				starts.some((start) => Number(start.operation_id) > op.id) ||
				(event && (event.script !== op.script || event.run_id !== op.runId)) ||
				!allowed.has(op.script)
			)
				return false;
			continue;
		}
		if (
			!("recordSha256" in op) ||
			(op.status !== "completed" && op.status !== "failed") ||
			!allowed.has(op.script) ||
			sha256(await file(root, `final/commands/${String(op.id).padStart(3, "0")}.json`)) !== op.recordSha256 ||
			event?.script !== op.script ||
			event.run_id !== op.runId
		)
			return false;
		if (op.reservation && !op.fingerprint) return false;
	}
	return duplicates(state) === 0 && starts.every((event) => state.commands.some((op) => op.id === event.operation_id));
}

async function matchesRun(
	root: string,
	state: TaskCheckpoint,
	entry: Verification,
	expected = state.evaluated.find((candidate) => candidate.id === entry.id),
	level = "full",
): Promise<boolean> {
	const run = expected as (RunResult & { historySha256?: string }) | undefined;
	if (!run) return false;
	const validation = await read<Record<string, unknown>>(root, `${entry.directory}/validation.json`);
	const score = await read<Record<string, unknown>>(root, entry.score_path);
	const checkpoint = sha256(await file(root, `${entry.directory}/checkpoint.pt`));
	if (
		!same(validation, run.validation) ||
		score.level !== level ||
		score.split !== "validation" ||
		typeof score.accuracy !== "number" ||
		!Number.isFinite(score.accuracy) ||
		score.accuracy < 0 ||
		score.accuracy > 1 ||
		typeof score.loss !== "number" ||
		!Number.isFinite(score.loss) ||
		score.checkpoint_sha256 !== checkpoint ||
		score.run_metadata_sha256 !== sha256(await file(root, `${entry.directory}/run.json`)) ||
		run.historySha256 !== sha256(await file(root, `${entry.directory}/history.json`))
	)
		return false;
	for (const key of [
		"accuracy",
		"loss",
		"parameters",
		"checkpoint_sha256",
		"run_metadata_sha256",
		"dataset_access_log",
		"evaluation_entrypoint_sha256",
		"parameter_evaluator_sha256",
	])
		if (!same(score[key], validation[key])) return false;
	const manifest = state.summary.delivery;
	if (entry.label === "final" && state.spec.delivery_preference && manifest) {
		const members = manifest.members as { id: string; files: Record<string, string> }[];
		const member = members.find((candidate) => candidate.id === entry.id);
		const required = [
			"checkpoint.pt",
			"run.json",
			"history.json",
			"validation.json",
			"candidate/model.py",
			"candidate/config.json",
		];
		if (!member || !same(Object.keys(member.files).sort(), required.sort())) return false;
		for (const name of required)
			if (sha256(await file(root, `${entry.directory}/${name}`)) !== member.files[name]) return false;
	} else if (
		entry.label === "final" &&
		manifest &&
		(manifest.checkpoint_sha256 !== checkpoint ||
			manifest.validation_sha256 !== sha256(await file(root, `${entry.directory}/validation.json`)))
	)
		return false;
	return true;
}

function verifyThreeObjectives(state: TaskCheckpoint): boolean {
	const spec = state.spec as TaskCheckpoint["spec"] & { objectives?: string[] };
	const points = state.summary.pareto?.frontier;
	if (
		!same(spec.objectives, ["accuracy", "parameters", "loss"]) ||
		!points?.length ||
		!state.evaluated.every(
			(run) => Number.isInteger(run.validation.parameters) && Number.isFinite(run.validation.loss),
		)
	)
		return false;
	const seen = new Set(["baseline"]);
	return state.rows.every((row) => {
		if (!row.evidence_refs?.length || !row.evidence_refs.every((ref) => seen.has(ref))) return false;
		seen.add(row.id);
		return points.every((point) => typeof point.metrics.loss === "number");
	});
}

function usageReport(item: BenchCase, state: TaskCheckpoint, observed: Observation): Grading["usage"] {
	if (item.mode !== "live_agent")
		return { requests: state.requests.length, tokens: state.summary.budget.tokens_actual, estimated_cost_usd: null };
	return liveUsage(observed.usage, state.requests.length);
}

// 用量未知的调用仍进入请求数。没有得到全部供应商数据时，Token 和费用合计为 null。
export function liveUsage(rows: LiveTrace["usage"] | undefined, admitted?: number): Grading["usage"] {
	const requests = rows ? Math.max(rows.length, admitted ?? 0) : (admitted ?? null);
	if (requests === 0) return { requests: 0, tokens: 0, estimated_cost_usd: 0 };
	if (!rows || rows.length !== requests) return { requests, tokens: null, estimated_cost_usd: null };
	const valid = rows?.length && rows.every((row) => Number.isSafeInteger(row.tokens) && Number(row.tokens) >= 0);
	const priced = valid && rows.every((row) => Number.isFinite(row.cost) && Number(row.cost) >= 0);
	return {
		requests,
		tokens: valid ? rows.reduce((sum, row) => sum + Number(row.tokens), 0) : null,
		estimated_cost_usd: priced ? rows.reduce((sum, row) => sum + Number(row.cost), 0) : null,
	};
}
function outcome(valid: boolean, ...evidence: string[]): Outcome {
	return { valid, evidence };
}
function same(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
async function read<T>(root: string, path: string): Promise<T> {
	return JSON.parse((await file(root, path)).toString("utf8")) as T;
}

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
	evaluation: { label: string; id: string; result: Record<string, unknown>; evidence: string }[];
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
	resumed?: string;
	tools?: LiveTrace["tools"];
	usage?: LiveTrace["usage"];
	floor_published_directory?: boolean;
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
	const quality =
		sound &&
		finalScores.some(
			({ result }) => typeof result.accuracy === "number" && result.accuracy >= (item.accuracy_floor ?? 0),
		);
	const proofs = [
		"final/ledger.json",
		"verification.json",
		...finalProof.flatMap((entry) => [entry.score_path, `${entry.directory}/checkpoint.pt`]),
		...(delivery ? [deliveryPath] : []),
	];
	const usage = usageReport(item, state, observed);
	const checks: Record<string, Outcome> = {};
	checks.budget = outcome(validBudget(item, state), "final/ledger.json");
	checks.operations = outcome(
		await verifyOperations(root, state, observed),
		"final/ledger.json",
		"final/events.jsonl",
		...state.commands
			.filter((op) => "recordSha256" in op)
			.map((op) => `final/commands/${String(op.id).padStart(3, "0")}.json`),
	);
	// 缺少任务交付本身属于任务轴。只有声称存在交付时才要求对应可核验证据。
	checks.provenance = outcome(delivery ? sound : selected.length === 0 && finalProof.length === 0, ...proofs);
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
	if (item.mode === "live_agent")
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
			},
			checks,
		),
		usage,
		compute_seconds: state.summary.budget.compute_process_seconds,
		evaluation,
		torch,
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
	} else if (item.id === "T1-POL-01") {
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

function validBudget(item: BenchCase, state: TaskCheckpoint): boolean {
	const used = state.summary.budget;
	const approved = state.spec.budget;
	return (
		approved.training_steps === item.budget.max_steps &&
		approved.max_tokens === item.budget.max_tokens &&
		approved.compute_process_seconds === item.budget.max_compute_seconds &&
		approved.wall_seconds === item.budget.max_task_wall_seconds &&
		approved.max_experiments === item.budget.max_proposals &&
		used.training_steps_reserved <= approved.training_steps &&
		used.training_steps_reserved ===
			state.commands
				.filter((op) => "elapsedMs" in op)
				.reduce((total, op) => total + (op.reservation?.steps ?? 0), 0) &&
		used.tokens_actual <= approved.max_tokens &&
		used.experiments <= approved.max_experiments &&
		used.compute_process_seconds <= approved.compute_process_seconds &&
		used.wall_seconds <= approved.wall_seconds &&
		!used.usage_uncertain &&
		used.tokens_admission_estimate === 0 &&
		(item.mode === "live_agent" || used.model_requests === 0) &&
		state.delivered &&
		(state.spec.fidelity === undefined ||
			(state.summary.fidelity?.full_candidates_started ?? Infinity) <= state.spec.fidelity.max_full)
	);
}

async function verifyOperations(root: string, state: TaskCheckpoint, observed: Observation): Promise<boolean> {
	const allowed = new Set([
		"experiment.py",
		"review_candidate.py",
		"validate_only.py",
		"train.py",
		"pareto_validate.py",
	]);
	const tools = new Set(["axiom_task_inspect", "axiom_task_baseline", "axiom_task_candidate", "axiom_task_finish"]);
	const events = (await file(root, "final/events.jsonl"))
		.toString("utf8")
		.trim()
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; operation_id?: number; script?: string; run_id?: string });
	const starts = events.filter((event) => event.type === "process_start");
	if (
		observed.tools?.some((tool) => !tools.has(tool)) ||
		new Set(starts.map((event) => event.operation_id)).size !== starts.length
	)
		return false;
	const seen = new Set<string>();
	for (const op of state.commands) {
		if (
			!("recordSha256" in op) ||
			(op.status !== "completed" && op.status !== "failed") ||
			!allowed.has(op.script) ||
			sha256(await file(root, `final/commands/${String(op.id).padStart(3, "0")}.json`)) !== op.recordSha256 ||
			!starts.some(
				(event) => event.operation_id === op.id && event.script === op.script && event.run_id === op.runId,
			)
		)
			return false;
		if (op.reservation) {
			if (!op.fingerprint || seen.has(op.fingerprint)) return false;
			seen.add(op.fingerprint);
		}
	}
	return starts.length === state.commands.length;
}

async function matchesRun(root: string, state: TaskCheckpoint, entry: Verification): Promise<boolean> {
	const run = state.evaluated.find((candidate) => candidate.id === entry.id) as
		| (RunResult & { historySha256?: string })
		| undefined;
	if (!run) return false;
	const validation = await read<Record<string, unknown>>(root, `${entry.directory}/validation.json`);
	const score = await read<Record<string, unknown>>(root, entry.score_path);
	const checkpoint = sha256(await file(root, `${entry.directory}/checkpoint.pt`));
	if (
		!same(validation, run.validation) ||
		score.level !== "full" ||
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
	const rows = observed.usage;
	const valid = rows?.length && rows.every((row) => Number.isSafeInteger(row.tokens) && Number(row.tokens) >= 0);
	const priced = rows?.length && rows.every((row) => Number.isFinite(row.cost) && Number(row.cost) >= 0);
	return {
		requests: rows?.length ?? null,
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

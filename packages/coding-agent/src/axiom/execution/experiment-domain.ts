// 实验控制器与领域适配器共用的任务、候选、评估及证据契约。
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { ProcessResult, WorkerIdentity } from "./process.ts";
import type { TaskBudget } from "./task-budget.ts";

export interface ExperimentTaskSpec {
	version: number;
	task: string;
	goal: string;
	max_revisions?: number;
	fidelity?: { strategy: "full_only" | "multi_fidelity"; max_full: number };
	delivery_preference?: DeliveryPreference;
	budget: {
		max_experiments: number;
		wall_seconds: number;
		max_tokens: number;
		compute_process_seconds: number;
		training_steps: number;
		cpu_threads: 1;
		device: "cpu";
	};
}

export interface Objective {
	metric: string;
	direction: "maximize" | "minimize";
	min: number;
	max: number;
	target: number | null;
	resolution?: number;
	integer?: boolean;
}

export type DeliveryPreference =
	| { strategy: "quality" | "lightweight" | "frontier" }
	| { strategy: "minimum_accuracy"; minimum_accuracy: number };

export interface ParetoPoint {
	id: string;
	fingerprint: string;
	metrics: Record<string, number>;
}

export interface ParetoDecision {
	preference: DeliveryPreference;
	reason: "quality_first" | "complexity_first" | "accuracy_floor_met" | "complete_frontier" | "no_feasible_candidate";
	primary?: string;
	selected: ParetoPoint[];
}

export type EvaluationResult = Record<string, unknown>;
export type ExperimentFingerprint = string;
export interface ArtifactManifest extends Record<string, unknown> {
	best_id: string;
}
export type AdapterCheckpoint = Record<string, unknown>;
export type ExperimentRole = "baseline" | "candidate";
export interface TrainingReservation {
	role: ExperimentRole;
	steps: number;
	stage?: TrainingStage;
}
export type TrainingStage = "smoke" | "proxy" | "full";
export interface StageResult {
	stage: TrainingStage;
	protocol: string;
	key: string;
	result: RunResult;
}
export interface FidelityAdapter {
	steps(stage: TrainingStage): number;
	run(
		candidate: Candidate,
		reservation: TrainingReservation & { stage: TrainingStage },
		signal: AbortSignal,
	): Promise<StageResult>;
	verify(candidate: Candidate, evidence: StageResult): Promise<void>;
	score(evidence: StageResult): number;
}

export const proposalSchema = Type.Object(
	{
		content: Type.String({ maxLength: 8192 }),
		rationale: Type.String({ minLength: 1, maxLength: 2000 }),
		evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		evidence_refs: Type.Optional(
			Type.Array(Type.String({ pattern: "^(baseline|exp-[1-9][0-9]*)$" }), {
				minItems: 1,
				maxItems: 8,
				uniqueItems: true,
			}),
		),
		parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export interface Candidate {
	id: string;
	fingerprint: ExperimentFingerprint;
	content: string;
	rationale: string;
	config?: string;
}

export interface RunResult {
	id: string;
	fingerprint: ExperimentFingerprint;
	validation: EvaluationResult;
	run: string;
}

export interface EvaluationProtocol {
	objectives: readonly [Objective, ...Objective[]];
	validate(result: unknown): EvaluationResult;
}

export type FailureCategory =
	| "invalid_candidate"
	| "domain_execution"
	| "internal_error"
	| "budget_exhausted"
	| "permission_violation"
	| "external_unknown"
	| "ledger_error"
	| "evidence_integrity";

export class ExperimentFailure extends Error {
	readonly category: FailureCategory;
	constructor(category: FailureCategory, message: string) {
		super(message);
		this.category = category;
	}
}

// 在工具参数入口校验提案结构。参数值和权限由适配器校验。
export function validateProposal(input: Record<string, unknown>): Static<typeof proposalSchema> {
	if (Object.keys(input).some((key) => !Object.hasOwn(proposalSchema.properties, key)))
		throw new ExperimentFailure(
			"permission_violation",
			"Permission denied: task rules/config/split cannot be overridden",
		);
	if (!Check(proposalSchema, input) || Buffer.byteLength(input.content) > 8192 || !input.rationale.trim())
		throw new ExperimentFailure("invalid_candidate", "Invalid candidate proposal");
	return input;
}

// 选优与阈值共用同一个可信指标。扩展目标留待多目标阶段使用。
export function objectiveValue(result: RunResult, protocol: EvaluationProtocol): number {
	const objective = protocol.objectives[0];
	const value = protocol.validate(result.validation)[objective.metric];
	if (typeof value !== "number" || !Number.isFinite(value) || value < objective.min || value > objective.max)
		throw new ExperimentFailure("evidence_integrity", "Invalid independent validation objective");
	return value;
}

export type WorkerOperation = {
	id: number;
	runId: string;
	fingerprint?: ExperimentFingerprint;
	script: string;
	timeoutMs: number;
	reservation?: TrainingReservation;
	stage?: TrainingStage | "review";
} & (
	| { status: "pending" | "unknown"; identity?: WorkerIdentity }
	| { status: "intent" | "not_started"; nonce: string }
	| { status: "started"; identity: WorkerIdentity }
	| {
			status: "completed" | "failed";
			identity?: WorkerIdentity;
			elapsedMs: number;
			exitCode: number | null;
			stopped: ProcessResult["stopped"];
			recordSha256: string;
	  }
);

export interface ExperimentAdapter {
	original: string;
	config: string;
	evaluation: EvaluationProtocol;
	reportNotes: readonly string[];
	fidelity?: FidelityAdapter;
	trainingSteps(role: ExperimentRole): number;
	prepare(
		id: string,
		content: string,
		rationale: string,
		signal: AbortSignal,
		parameters?: Record<string, unknown>,
	): Promise<Candidate>;
	run(candidate: Candidate, reservation: TrainingReservation, signal: AbortSignal): Promise<RunResult>;
	verifyEvaluated(run: RunResult): Promise<unknown>;
	deliver(best: RunResult): Promise<ArtifactManifest>;
	paretoDelivery?: {
		publish(decision: ParetoDecision, runs: readonly RunResult[]): Promise<ArtifactManifest>;
		verify(decision: ParetoDecision, runs: readonly RunResult[], manifest: ArtifactManifest): Promise<void>;
	};
}

export interface DurableExperimentAdapter extends ExperimentAdapter {
	recordCommand?: (operation: WorkerOperation) => Promise<void>;
	recordPublishedBest?: () => Promise<void>;
	checkpoint(): AdapterCheckpoint;
	verifyCommand(operation: Extract<WorkerOperation, { recordSha256: string }>): Promise<void>;
	verifyDelivery(best: RunResult, delivery: ArtifactManifest): Promise<void>;
	isReadOnly(operation: WorkerOperation): boolean;
}

export interface ExperimentDomain {
	id: string;
	version: number;
	validateSpec(input: unknown): ExperimentTaskSpec;
	acceptsLegacy(spec: ExperimentTaskSpec): boolean;
	open(input: {
		repo: string;
		root: string;
		python: string;
		budget: TaskBudget;
		saved?: AdapterCheckpoint;
		commandCount?: number;
	}): Promise<DurableExperimentAdapter>;
}

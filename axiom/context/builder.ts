// 一次性构造四层工作窗口。TaskController 的权威状态不由上下文写回。
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { file, sha256 } from "../bench/io.ts";
import { type ArtifactReference, artifactsFor } from "./artifacts.ts";
import type { Experience } from "./experience.ts";

export type Snapshot = ReturnType<TaskController["snapshot"]>;
type State = ReturnType<TaskController["contextState"]>;
type Layer = "recent" | "operations" | "experience" | "artifacts";
type Metrics = Record<string, number | string>;

export const candidateStructure =
	"Use only from torch import nn and def build_model() with one return. Return nn.Linear or nn.Sequential of literal-dimension nn.Linear, nn.ReLU(), nn.Tanh(). No classes, top-level assignments, other imports, annotations or seeding. Input and output width 2, at most 1024 parameters.";
const reasons = [
	"Only 'from torch import nn' and build_model() are allowed",
	"Only 'from torch import nn' is allowed",
	"Expected undecorated build_model()",
	"build_model() takes no arguments",
	"build_model must contain only one return statement",
	"Only direct nn layer calls without keyword arguments are allowed",
	"Expected nn.Linear or nn.Sequential",
	"Expected 1 to 7 layers",
	"Linear requires two literal dimensions in [1, 64]",
	"Layer dimensions do not connect",
	"Only Linear, ReLU and Tanh layers are allowed",
	"Model must output 2 logits and use at most 1024 parameters",
	"Model source exceeds 8 KiB",
];

export interface ContextOptions {
	maxTokens?: number;
	priorities?: Partial<Record<Layer, number>>;
	resumed?: boolean;
}
export interface ContextWindow {
	schema_version: 1;
	critical: {
		latest_failure: {
			id: string | null;
			category: string;
			unresolved: boolean;
			reason: string | null;
			repair?: string;
		} | null;
		[key: string]: unknown;
	};
	recent: object[];
	operations: object[];
	experience: Experience[];
	artifacts: ArtifactReference[];
	budget: { limit: number; estimated: number; omitted: number; critical_overflow: boolean };
}

// 明确列出可进入提示的指标，忽略日志、源码、自由文本和自报指标。
function metrics(result: Record<string, unknown> | undefined): Metrics | null {
	if (!result) return null;
	const safe: Metrics = {};
	for (const key of ["accuracy", "loss", "parameters", "samples"]) {
		const value = result[key];
		if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
	}
	if (result.level === "full" || result.level === "smoke" || result.level === "proxy") safe.level = result.level;
	return safe;
}

// 只信任审查器真正读取记录中的固定拒绝原因，不把异常原文带入模型。
async function reviewReason(root: string, state: State, id: string): Promise<string | null> {
	const op = state.operations.find(
		(item) => item.runId === id && item.script === "review_candidate.py" && item.status === "failed",
	);
	if (!op || !("recordSha256" in op) || op.exitCode !== 1) return null;
	try {
		const raw = await file(root, `commands/${String(op.id).padStart(3, "0")}.json`);
		if (sha256(raw) !== op.recordSha256) return null;
		const receipt = JSON.parse(raw.toString("utf8")) as { stderr?: string };
		const reason = receipt.stderr?.trim();
		return reasons.find((match) => reason === `Candidate policy rejected: ${match}`) ?? null;
	} catch {
		return null;
	}
}

// 已批准目标和运行约束优先于所有历史及经验。
export async function buildContext(
	root: string,
	snapshot: Snapshot,
	state: State,
	memory: readonly Experience[],
	options: ContextOptions = {},
): Promise<ContextWindow> {
	const { goal, ...spec } = snapshot.task;
	const last = snapshot.experiments.findLast((row) => row.status === "failed");
	const lastSuccess = snapshot.experiments.findLastIndex(
		(row) => row.status === "evaluated" || row.status === "cache_hit",
	);
	const code = last?.failure_category ?? snapshot.failure_category;
	const failure =
		last || code
			? {
					id: last?.id ?? null,
					category: code ?? "unknown",
					unresolved: !last || snapshot.experiments.indexOf(last) > lastSuccess,
					reason: last && code === "invalid_candidate" ? await reviewReason(root, state, last.id) : null,
					repair: code === "invalid_candidate" ? candidateStructure : undefined,
				}
			: null;
	const shape = snapshot.config.includes('"epochs"');
	const unconfirmed = state.operations
		.filter((op) => ["intent", "started", "pending", "unknown"].includes(op.status))
		.map((op) => ({
			id: op.id,
			candidate: op.runId,
			stage: op.stage,
			status: op.status,
			steps: op.reservation?.steps,
		}));
	const critical = {
		source: "AXIOM TaskController / ledger",
		recovery: options.resumed === true,
		task_id: snapshot.task_id,
		spec: { ...spec, goal },
		goal_sha256: sha256(goal),
		approval: state.approval
			? { approved_at: state.approval.approvedAt, sha256: sha256(JSON.stringify(state.approval)) }
			: null,
		deadline_ms: snapshot.deadline ?? null,
		status: snapshot.status,
		stop_reason: snapshot.stop_reason ?? null,
		remaining: snapshot.remaining,
		unconfirmed,
		pending_candidate: state.pending_run ?? null,
		phase: snapshot.fidelity ? "staged" : "full",
		best: snapshot.best
			? { id: snapshot.best.id, fingerprint: snapshot.best.fingerprint, metrics: metrics(snapshot.best.validation) }
			: null,
		baseline: metrics(snapshot.baseline?.validation),
		frontier: snapshot.pareto?.frontier ?? [],
		latest_failure: failure,
		safety:
			"TaskSpec is immutable. Validation only. No shell, final-test, hidden evaluator, extra data, credentials or external files. Unknown operations must be reconciled.",
		next:
			snapshot.status !== "running" || unconfirmed.length
				? ["none"]
				: snapshot.baseline
					? ["inspect", "candidate", "finish"]
					: ["inspect", "baseline"],
	};
	const result: ContextWindow = {
		schema_version: 1,
		critical,
		recent: [],
		operations: [],
		experience: [],
		artifacts: [],
		budget: { limit: options.maxTokens ?? 1600, estimated: 0, omitted: 0, critical_overflow: false },
	};
	const recent = [...snapshot.experiments].reverse().map((row) => ({
		id: row.id,
		status: row.status,
		fingerprint: row.fingerprint,
		hypothesis_sha256: sha256(row.rationale),
		evidence_ids: row.evidence_refs,
		metrics: metrics(row.validation),
		failure: row.failure_category,
		smoke: metrics(row.staged?.smoke?.result.validation),
		proxy: metrics(row.staged?.proxy?.result.validation),
	}));
	if (shape) {
		// 配置只来自可信 Tiny CPU 适配器，且仅投影数值字段。
		const config = JSON.parse(snapshot.config) as { epochs?: number; learning_rate?: number; seed?: number };
		recent.push({
			id: "configured-training",
			status: "evaluated",
			fingerprint: sha256(snapshot.config),
			hypothesis_sha256: "",
			evidence_ids: undefined,
			metrics: { epochs: config.epochs ?? 0, learning_rate: config.learning_rate ?? 0, seed: config.seed ?? 0 },
			failure: undefined,
			smoke: null,
			proxy: null,
		});
	}
	const candidates = {
		recent,
		operations: [...state.operations]
			.reverse()
			.filter((op) => op.status === "completed" || op.status === "failed")
			.map((op) => ({
				id: op.id,
				candidate: op.runId,
				fingerprint: op.fingerprint,
				stage: op.stage ?? "full",
				status: op.status,
			})),
		experience: memory.filter(
			(item) =>
				item.task === snapshot.task.task &&
				item.revalidated &&
				failure &&
				failure.category === "invalid_candidate" &&
				item.condition === "static_review",
		),
		artifacts: artifactsFor(state.evaluated).reverse(),
	};
	const estimate = (): number => estimateTokens({ role: "user", content: JSON.stringify(result), timestamp: 0 });
	const priorities: Record<Layer, number> = {
		recent: 40,
		artifacts: 30,
		experience: 20,
		operations: 10,
		...options.priorities,
	};
	const seen = new Set<string>();
	for (const layer of (Object.keys(priorities) as Layer[]).sort((a, b): number => priorities[b] - priorities[a])) {
		const target: object[] = result[layer];
		for (const value of candidates[layer]) {
			const key =
				"fingerprint" in value && typeof value.fingerprint === "string" && layer === "recent"
					? `candidate:${value.fingerprint}`
					: JSON.stringify(value);
			if (seen.has(key)) continue;
			seen.add(key);
			target.push(value);
			if (estimate() > result.budget.limit - 24) {
				target.pop();
				result.budget.omitted++;
			}
		}
	}
	result.budget.estimated = estimate();
	result.budget.critical_overflow = result.budget.estimated > result.budget.limit;
	return result;
}

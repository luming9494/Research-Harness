// 科研矩阵由宿主冻结，模型只能在已批准的对照中提出可检验假设。
import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { sha256 } from "../bench/io.ts";
import { configOf } from "../rag/bm25.ts";
import {
	denseControl,
	fusionControl,
	type HybridConfig,
	hybridConfigOf,
	hybridSpace,
	sparseControl,
} from "../rag/hybrid.ts";

const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const name = Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" });
export const hypothesis = Type.Object(
	{
		comparison: name,
		metric: Type.Union([Type.Literal("ndcg10"), Type.Literal("accuracy")]),
		direction: Type.Union([Type.Literal("increase"), Type.Literal("decrease")]),
		statement: Type.String({ minLength: 12, maxLength: 360 }),
	},
	{ additionalProperties: false },
);
export type Hypothesis = Static<typeof hypothesis>;
export const proposal = Type.Array(hypothesis, { minItems: 2, maxItems: 4 });
const rate = Type.Object(
	{ learning_rate: Type.Number({ minimum: 0.0001, maximum: 0.1 }) },
	{ additionalProperties: false },
);
const condition = Type.Object(
	{
		id: name,
		reference: Type.Union([name, Type.Null()]),
		factor: name,
		config: Type.Union([hybridSpace, rate]),
	},
	{ additionalProperties: false },
);
const schema = Type.Object(
	{
		version: Type.Literal(1),
		id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
		status: Type.Literal("frozen"),
		domain: Type.Union([Type.Literal("scifact"), Type.Literal("tiny")]),
		question: Type.String({ minLength: 12, maxLength: 500 }),
		hypotheses: Type.Array(hypothesis, { maxItems: 4 }),
		proposal_sha256: Type.Union([hash, Type.Null()]),
		baseline: name,
		conditions: Type.Array(condition, { minItems: 2, maxItems: 8 }),
		repeats: Type.Integer({ minimum: 1, maximum: 2 }),
		seed: Type.Union([Type.Literal(42), Type.Null()]),
		controlled: Type.Object(
			{
				dataset: hash,
				implementation: hash,
				model: hash,
				environment: hash,
				evaluation: Type.Union([Type.Literal("scifact-development-v2"), Type.Literal("tiny-validation-v1")]),
			},
			{ additionalProperties: false },
		),
		budgets: Type.Object(
			{
				wall_seconds: Type.Integer({ minimum: 1, maximum: 1800 }),
				compute_seconds: Type.Integer({ minimum: 1, maximum: 1200 }),
				training_steps: Type.Integer({ minimum: 0, maximum: 1000 }),
			},
			{ additionalProperties: false },
		),
		metrics: Type.Array(name, { minItems: 1, maxItems: 4 }),
		expected_evidence: Type.Array(name, { minItems: 3, maxItems: 6 }),
	},
	{ additionalProperties: false },
);

export type Plan = Static<typeof schema>;
export type Condition = Static<typeof condition>;
export type Domain = Plan["domain"];
export interface Cell {
	id: string;
	condition: Condition;
	repeat: number;
	seed: number | null;
	fingerprint: string;
}

// 共享公式中的 fusionControl 是宿主固定的 RRF 分支。
const rrfControl = fusionControl as Extract<HybridConfig, { strategy: "rrf" }>;
// 对照深度以同一固定 RRF 为参照，策略整组更换单列为策略比较。
export const conditions: Record<Domain, readonly Condition[]> = {
	scifact: [
		{ id: "bm25", factor: "baseline", reference: null, config: sparseControl },
		{ id: "dense", factor: "strategy", reference: "bm25", config: denseControl },
		{ id: "rrf", factor: "strategy", reference: "bm25", config: fusionControl },
		{ id: "rrf-k", factor: "rrf-k", reference: "rrf", config: { ...rrfControl, rrf_k: 20 } },
		{
			id: "sparse-depth",
			factor: "sparse-depth",
			reference: "rrf",
			config: { ...rrfControl, sparse: { ...rrfControl.sparse, top_k: 15 } },
		},
		{ id: "dense-depth", factor: "dense-depth", reference: "rrf", config: { ...rrfControl, dense_top_k: 15 } },
	],
	tiny: [
		{ id: "rate-base", factor: "baseline", reference: null, config: { learning_rate: 0.03 } },
		{ id: "rate-low", factor: "learning-rate", reference: "rate-base", config: { learning_rate: 0.01 } },
		{ id: "rate-high", factor: "learning-rate", reference: "rate-base", config: { learning_rate: 0.08 } },
	],
};

// 比较候选时报告所有改变，RRF 只允许一个既定字段与参照不同。
export function comparable(row: Condition, ref: Condition): boolean {
	if (row.reference !== ref.id) return false;
	if ("learning_rate" in row.config && "learning_rate" in ref.config)
		return row.factor === "learning-rate" && row.config.learning_rate !== ref.config.learning_rate;
	if (!("strategy" in row.config) || !("strategy" in ref.config)) return false;
	if (row.factor === "strategy") return row.config.strategy !== ref.config.strategy;
	if (row.config.strategy !== "rrf" || ref.config.strategy !== "rrf") return false;
	const expected = ref.config;
	const actual = row.config;
	const changed =
		row.factor === "rrf-k" && actual.rrf_k !== expected.rrf_k
			? { ...expected, rrf_k: actual.rrf_k }
			: row.factor === "dense-depth" && actual.dense_top_k !== expected.dense_top_k
				? { ...expected, dense_top_k: actual.dense_top_k }
				: row.factor === "sparse-depth" && actual.sparse.top_k !== expected.sparse.top_k
					? { ...expected, sparse: { ...expected.sparse, top_k: actual.sparse.top_k } }
					: undefined;
	return !!changed && JSON.stringify(hybridConfigOf(actual)) === JSON.stringify(hybridConfigOf(changed));
}

export function validatePlan(raw: unknown): Plan {
	if (!Check(schema, raw)) throw new Error("Invalid or unfrozen research plan");
	const { conditions: rows, domain } = raw;
	const catalog = conditions[domain];
	const primary = domain === "scifact" ? "ndcg10" : "accuracy";
	if (
		JSON.stringify(rows) !== JSON.stringify(catalog) ||
		raw.baseline !== catalog[0].id ||
		raw.seed !== (domain === "tiny" ? 42 : null) ||
		raw.controlled.evaluation !== (domain === "tiny" ? "tiny-validation-v1" : "scifact-development-v2") ||
		raw.repeats !== (domain === "tiny" ? 2 : 1) ||
		raw.hypotheses.some(
			(item) => item.metric !== primary || !catalog.slice(1).some(({ id }) => id === item.comparison),
		) ||
		(raw.proposal_sha256 !== null &&
			(raw.hypotheses.length < 2 ||
				new Set(raw.hypotheses.map(({ comparison }) => comparison)).size !== raw.hypotheses.length))
	)
		throw new Error("Research plan does not match approved conditions or hypothesis boundaries");
	for (const row of rows.slice(1)) {
		const ref = rows.find(({ id }) => id === row.reference);
		if (!ref || !comparable(row, ref)) throw new Error("Confounded comparison");
		if ("sparse" in row.config) configOf(row.config.sparse);
	}
	return raw;
}

export function freeze(
	domain: Domain,
	question: string,
	controlled: Plan["controlled"],
	hypotheses: Hypothesis[],
	proposalSha: string | null,
): Plan {
	// 预算和对照由宿主固化，计划中没有可执行脚本字段。
	return validatePlan({
		version: 1,
		id: randomUUID(),
		status: "frozen",
		domain,
		question,
		controlled,
		hypotheses,
		proposal_sha256: proposalSha,
		baseline: conditions[domain][0].id,
		conditions: conditions[domain],
		repeats: domain === "tiny" ? 2 : 1,
		seed: domain === "tiny" ? 42 : null,
		budgets:
			domain === "tiny"
				? { wall_seconds: 1200, compute_seconds: 1000, training_steps: 488 }
				: { wall_seconds: 900, compute_seconds: 260, training_steps: 0 },
		metrics: domain === "tiny" ? ["accuracy", "loss", "compute-ms"] : ["ndcg10", "recall5", "p95-ms", "index-bytes"],
		expected_evidence: ["ledger", "independent-score", "artifact-manifest"],
	});
}

// 重复号和种子参与身份，即使同配置同种子复现也保留独立样本。
export function cells(plan: Plan, planSha: string): Cell[] {
	return Array.from({ length: plan.repeats }, (_row, index) =>
		plan.conditions.map((condition): Cell => {
			const repeat = index + 1;
			const id = `${condition.id}-r${repeat}`;
			return {
				id,
				condition,
				repeat,
				seed: plan.seed,
				fingerprint: cellFingerprint(plan, planSha, id, plan.seed, condition.config),
			};
		}),
	).flat();
}

// 固定合同内的单元身份同时区分种子、重复以及有效参数。
export function cellFingerprint(
	plan: Plan,
	sha: string,
	id: string,
	seed: number | null,
	config: Condition["config"],
): string {
	return sha256(JSON.stringify([sha, id, seed, config, plan.controlled, plan.budgets]));
}

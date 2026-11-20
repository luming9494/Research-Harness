// Migrated Tiny Task specification and immutable execution policy from local AXIOM WP-04.
import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { ExperimentTaskSpec } from "./experiment-domain.ts";

export const DEFAULT_BUDGET = {
	max_experiments: 2,
	wall_seconds: 600,
	max_tokens: 100_000,
	compute_process_seconds: 300,
	training_steps: 244,
	cpu_threads: 1 as const,
	device: "cpu" as const,
};
export const TASK_RULES = {
	pretrained_weights: false as const,
	extra_data: false as const,
	network: false as const,
	editable: "model.py" as const,
	evaluation: "validation" as const,
};
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

// 审批只允许收窄 Python 可信配置的学习率范围，其他配置保持固定。
const learningRate = Type.Number({ minimum: 0.0001, maximum: 0.1 });
const target = Type.Union([Type.Null(), Type.Number({ minimum: 0, maximum: 1 })]);
const common = {
	task: Type.Literal("tiny-xor-v1"),
	goal: Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" }),
	rules: Type.Object(
		{
			pretrained_weights: Type.Literal(false),
			extra_data: Type.Literal(false),
			network: Type.Literal(false),
			editable: Type.Literal("model.py"),
			evaluation: Type.Literal("validation"),
		},
		{ additionalProperties: false },
	),
	budget: Type.Object(
		{
			max_experiments: Type.Integer({ minimum: 1, maximum: 3 }),
			wall_seconds: Type.Integer({ minimum: 10, maximum: 1800 }),
			max_tokens: Type.Integer({ minimum: 1, maximum: 500_000 }),
			compute_process_seconds: Type.Integer({ minimum: 1, maximum: 1200 }),
			training_steps: Type.Integer({ minimum: 1, maximum: 1000 }),
			cpu_threads: Type.Literal(1),
			device: Type.Literal("cpu"),
		},
		{ additionalProperties: false },
	),
};
const legacy = Type.Object(
	{ version: Type.Literal(1), ...common, target_accuracy: target },
	{ additionalProperties: false },
);
const parameterRanges = Type.Object(
	{
		learning_rate: Type.Object({ min: learningRate, max: learningRate }, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);
const current = Type.Object(
	{
		version: Type.Literal(2),
		...common,
		objective: Type.Object(
			{
				metric: Type.Literal("accuracy"),
				direction: Type.Literal("maximize"),
				target,
			},
			{ additionalProperties: false },
		),
		parameters: Type.Optional(parameterRanges),
		// 主机在审批时选择固定起点，搜索工具不能改写该字段。
		starting_model: Type.Optional(Type.Literal("shallow_tanh")),
		max_revisions: Type.Integer({ minimum: 0, maximum: 3 }),
	},
	{ additionalProperties: false },
);
// v3 单独审批分级策略和完整训练名额，旧版预算继续按原规则解释。
const staged = Type.Object(
	{
		...current.properties,
		version: Type.Literal(3),
		starting_model: Type.Optional(Type.Never()),
		budget: Type.Object(
			{
				...common.budget.properties,
				max_experiments: Type.Integer({ minimum: 1, maximum: 8 }),
			},
			{ additionalProperties: false },
		),
		fidelity: Type.Object(
			{
				strategy: Type.Union([Type.Literal("full_only"), Type.Literal("multi_fidelity")]),
				max_full: Type.Integer({ minimum: 1, maximum: 8 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

// 未校准的准确率代理可能错剪小模型，v4 只审批直接 Full 评估。
const multiObjective = Type.Object(
	{
		...staged.properties,
		version: Type.Literal(4),
		objectives: Type.Union([
			Type.Tuple([Type.Literal("accuracy"), Type.Literal("parameters")]),
			Type.Tuple([Type.Literal("accuracy"), Type.Literal("parameters"), Type.Literal("loss")]),
		]),
		objective: Type.Optional(Type.Never()),
		fidelity: Type.Object(
			{
				strategy: Type.Literal("full_only"),
				max_full: staged.properties.fidelity.properties.max_full,
			},
			{ additionalProperties: false },
		),
		delivery_preference: Type.Union([
			Type.Object(
				{ strategy: Type.Union([Type.Literal("quality"), Type.Literal("lightweight"), Type.Literal("frontier")]) },
				{ additionalProperties: false },
			),
			Type.Object(
				{ strategy: Type.Literal("minimum_accuracy"), minimum_accuracy: Type.Number({ minimum: 0, maximum: 1 }) },
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);

export type TaskSpec = ExperimentTaskSpec &
	(Static<typeof legacy> | Static<typeof current> | Static<typeof staged> | Static<typeof multiObjective>);
export const parameterProposalSchema = Type.Object(
	{ learning_rate: Type.Optional(learningRate) },
	{ additionalProperties: false },
);

export function validateTaskSpec(value: unknown): TaskSpec {
	if (Check(legacy, value)) return structuredClone(value);
	if (!Check(current, value) && !Check(staged, value) && !Check(multiObjective, value))
		throw new Error("Invalid Tiny TaskSpec: expected exact fields and bounded values; cannot relax trusted policy");
	const range = value.parameters?.learning_rate;
	if (
		value.version >= 3 &&
		"fidelity" in value &&
		(value.fidelity.max_full > value.budget.max_experiments ||
			(value.version === 3 &&
				value.fidelity.strategy === "full_only" &&
				value.fidelity.max_full !== value.budget.max_experiments))
	)
		throw new Error("Invalid full training budget for fidelity strategy");
	if (range && range.min > range.max) throw new Error("Invalid approved learning_rate range");
	return structuredClone(value);
}

export const REVIEW_NOTES = [
	"Only trusted examples/tiny-ml-task is supported. TaskSpec v2 can approve learning_rate within an explicit range; all other config remains fixed.",
	"max_experiments counts candidate attempts, including failures. Baseline is separate and always charged to wall/compute/training-step budgets.",
	"Each candidate reserves 82 training steps (2 Smoke + 80 full); baseline reserves 80. No automatic training retry.",
	"compute_process_seconds sums child-process elapsed time including Python startup/evaluation; conservative compute envelope, NOT measured CPU-seconds or GPU resources. CPU device and one Torch/BLAS thread are enforced.",
	"Tokens come from native Pi assistant usage events, including cache tokens. Pre-request headroom uses UTF-8 context bytes plus 8192 framing and 2048 output allowance; this is an estimate, NOT a provider output cap or absolute billing guarantee. Missing usage stops further requests. Actual usage can exceed the estimate and budget; no additional work is admitted afterwards.",
	"Goal means validation accuracy only. Final-test and local reference implementations are never offered to the Agent.",
	"Best selection, deduplication, budgets and stop reasons are deterministic code. Delivery copies and verifies already independently evaluated weights; no model call is needed for final report.",
];

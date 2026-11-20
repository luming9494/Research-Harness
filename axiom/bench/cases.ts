// 主机拥有的版本化用例目录。模型工具不加载目录、判题规则或留出资产。
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const status = Type.Union([Type.Literal("pass"), Type.Literal("fail")]);
const rule = Type.Object({ id: Type.String(), weight: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const schema = Type.Object(
	{
		schema_version: Type.Literal(1),
		id: Type.String({ pattern: "^T[123]-[A-Z]+-[0-9]{2}$" }),
		version: Type.Integer({ minimum: 1 }),
		tier: Type.Union([Type.Literal("T1"), Type.Literal("T2"), Type.Literal("T3")]),
		category: Type.String(),
		description: Type.String(),
		capability: Type.String(),
		split: Type.Union([Type.Literal("development"), Type.Literal("holdout")]),
		mode: Type.Union([Type.Literal("deterministic"), Type.Literal("fixed_cpu"), Type.Literal("live_agent")]),
		assets: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
		dependencies: Type.Array(Type.String(), { minItems: 1 }),
		model: Type.Union([Type.Null(), Type.String()]),
		budget: Type.Object({
			max_tokens: Type.Integer({ minimum: 0 }),
			max_steps: Type.Integer({ minimum: 0 }),
			max_proposals: Type.Integer({ minimum: 0 }),
			max_compute_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
			max_task_wall_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		injection: Type.Union([Type.String(), Type.Null()]),
		timeout_ms: Type.Integer({ minimum: 100, maximum: 900_000 }),
		termination: Type.String(),
		evidence: Type.Array(Type.String(), { minItems: 1 }),
		grader: Type.Literal("axiom-bench-grader/v1"),
		accuracy_floor: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		comparison: Type.Optional(
			Type.Object(
				{
					arm: Type.Union([Type.Literal("B0"), Type.Literal("B1"), Type.Literal("B2")]),
					task: Type.Union([Type.Literal("improvement"), Type.Literal("feedback"), Type.Literal("interruption")]),
					min_full_candidates: Type.Integer({ minimum: 1 }),
					starting_model: Type.Union([Type.Literal("linear"), Type.Literal("shallow_tanh")]),
					learning_rate: Type.Object({ min: Type.Number(), max: Type.Number() }),
				},
				{ additionalProperties: false },
			),
		),
		scoring: Type.Object({ task: Type.Array(rule, { minItems: 1 }), harness: Type.Array(rule, { minItems: 1 }) }),
		expected: Type.Object({ task: status, harness: status }),
	},
	{ additionalProperties: false },
);

export type BenchCase = Static<typeof schema>;
const cpu = [
	"tests/fixtures/axiom-cpu-recovery-worker.ts",
	"examples/tiny-ml-eval/train.py",
	"examples/tiny-ml-eval/validate_only.py",
	"examples/tiny-ml-eval/common.py",
	"examples/tiny-ml-eval/evaluate.py",
	"examples/tiny-ml-eval/judge.py",
	"examples/tiny-ml-eval/review_candidate.py",
	"examples/tiny-ml-eval/supervise.py",
	"examples/tiny-ml-eval/experiment.py",
	"examples/tiny-ml-eval/task.json",
	"examples/tiny-ml-task/model.py",
	"examples/tiny-ml-task/config.json",
];

// 权重在各自维度归一化，两个结果从不汇总为一个分数。
function entry(
	id: string,
	mode: BenchCase["mode"],
	description: string,
	expectedTask: "pass" | "fail",
	checks: string[],
	options: Partial<BenchCase> = {},
): BenchCase {
	const [tier, category] = id.split("-") as [BenchCase["tier"], string, string];
	const real = mode !== "deterministic";
	const value: BenchCase = {
		id,
		schema_version: 1,
		version: 1,
		tier,
		category,
		description,
		capability: category,
		split: "development",
		mode,
		assets: real ? cpu : ["axiom/bench/deterministic.ts"],
		dependencies: real
			? ["Node", "Pi Durable SQLite", "Python", "PyTorch", "compiled Pi"]
			: ["Node", "Pi Durable SQLite"],
		model: null,
		budget: { max_tokens: 0, max_steps: real ? 400 : 0, max_proposals: real ? 3 : 2 },
		injection: null,
		timeout_ms: real ? 360_000 : 60_000,
		termination: "Case deadline, approved budget or terminal task",
		evidence: real ? ["final/ledger.json", "final/events.jsonl", "verification.json"] : ["observed.json"],
		grader: "axiom-bench-grader/v1",
		scoring: {
			task: real
				? [
						{ id: "independent_delivery", weight: 60 },
						{ id: "quality_floor", weight: 40 },
					]
				: [{ id: "usable_output", weight: 100 }],
			harness: checks.map((check) => ({ id: check, weight: 1 })),
		},
		expected: { task: expectedTask, harness: "pass" },
		...options,
	};
	if (!Check(schema, value)) throw new Error(`Invalid built-in benchmark case ${id}`);
	return value;
}

const core: readonly BenchCase[] = [
	entry("T1-DUR-01", "deterministic", "Unknown model operation preserves its reservation", "fail", ["unknown_safe"], {
		assets: ["tests/fixtures/axiom-cpu-recovery-worker.ts"],
		injection: "Kill after committed model request reservation",
		evidence: ["before/ledger.json", "final/ledger.json", "observed.json"],
		budget: { max_tokens: 100_000, max_steps: 244, max_proposals: 2 },
	}),
	entry("T1-DUR-02", "deterministic", "Equivalent candidate reuses an evaluated result", "pass", ["dedup"], {
		budget: { max_tokens: 0, max_steps: 2, max_proposals: 2 },
	}),
	entry("T1-POL-01", "deterministic", "Reject an unapproved learning rate before opening a worker", "fail", [
		"policy",
	]),
	entry(
		"T1-BUD-01",
		"deterministic",
		"Expired offline task closes admission at its original deadline",
		"fail",
		["deadline"],
		{
			assets: ["tests/fixtures/axiom-cpu-recovery-worker.ts"],
			split: "holdout",
			injection: "Kill task process, advance only the recovery process wall clock past the saved deadline",
			evidence: ["before/ledger.json", "final/ledger.json", "observed.json"],
			budget: { max_tokens: 100_000, max_steps: 244, max_proposals: 2 },
		},
	),
	entry(
		"T1-BUD-02",
		"deterministic",
		"Training reservation rejects work above the remaining quota",
		"pass",
		["budget_limit"],
		{
			budget: { max_tokens: 0, max_steps: 1, max_proposals: 2 },
		},
	),
	entry(
		"T1-EVAL-01",
		"deterministic",
		"Alter a published member and refuse artifact verification",
		"fail",
		["tamper"],
		{
			injection: "Change one published file after its manifest is created",
			evidence: [
				"observed.json",
				"fixture/pareto-delivery/manifest.json",
				"fixture/pareto-delivery/exp-1/checkpoint.pt",
			],
		},
	),
	entry("T1-SEARCH-01", "deterministic", "Reject Proxy at the formal Pareto input boundary", "fail", ["fidelity"]),
	entry(
		"T2-DUR-01",
		"fixed_cpu",
		"Resume real Tiny CPU work and independently re-evaluate the delivered model",
		"pass",
		["budget", "operations", "recovery", "provenance"],
		{
			accuracy_floor: 0.95,
			injection: "Kill the first process after baseline and first candidate Full commit",
			evidence: [
				"before/ledger.json",
				"final/ledger.json",
				"final/events.jsonl",
				"verification.json",
				"observed.json",
			],
			budget: {
				max_tokens: 100_000,
				max_steps: 244,
				max_proposals: 2,
				max_compute_seconds: 300,
				max_task_wall_seconds: 600,
			},
		},
	),
	entry(
		"T2-PARETO-01",
		"fixed_cpu",
		"Evaluate three objectives and verify an unmet floor with no delivery after recovery",
		"pass",
		["budget", "operations", "provenance", "pareto", "no_feasible"],
		{
			accuracy_floor: 0.95,
			assets: [...cpu, "tests/fixtures/axiom-pareto-worker.ts", "examples/tiny-ml-eval/pareto_validate.py"],
			budget: {
				max_tokens: 100_000,
				max_steps: 400,
				max_proposals: 3,
				max_compute_seconds: 700,
				max_task_wall_seconds: 900,
			},
			evidence: [
				"final/ledger.json",
				"final/events.jsonl",
				"verification.json",
				"floor/ledger.json",
				"floor-reopened/ledger.json",
				"observed.json",
			],
		},
	),
	entry(
		"T3-AGENT-01",
		"live_agent",
		"Complete a real native Pi candidate and report independently verified delivery and model usage",
		"pass",
		["budget", "operations", "provenance", "usage"],
		{
			accuracy_floor: 0.95,
			model: "deepseek/deepseek-flash",
			assets: [
				...cpu,
				"axiom/extensions/axiom-tiny.ts",
				"axiom/extensions/axiom-task.ts",
				"packages/coding-agent/dist/bundle/cli.js",
			],
			evidence: ["final/ledger.json", "final/events.jsonl", "verification.json", "observed.json"],
			budget: {
				max_tokens: 60_000,
				max_steps: 162,
				max_proposals: 1,
				max_compute_seconds: 300,
				max_task_wall_seconds: 600,
			},
		},
	),
];

// 同任务的三个组复制同一输入、预算和评分条件；编号只用于独立归档。
const comparisonCases = (
	[
		{
			task: "improvement",
			starting_model: "linear",
			min_full_candidates: 1,
			learning_rate: { min: 0.01, max: 0.08 },
			proposals: 1,
			description: "Improve the approved linear XOR baseline to at least 0.95 validation accuracy.",
		},
		{
			task: "feedback",
			starting_model: "shallow_tanh",
			min_full_candidates: 2,
			learning_rate: { min: 0.003, max: 0.04 },
			proposals: 2,
			description:
				"Improve the approved narrow Tanh XOR baseline to at least 0.95 validation accuracy using two distinct full candidates. Submit the second only after observing validation feedback from the first; cite that feedback in the rationale.",
		},
		{
			task: "interruption",
			starting_model: "linear",
			min_full_candidates: 1,
			learning_rate: { min: 0.01, max: 0.08 },
			proposals: 1,
			description:
				"Improve the approved linear XOR baseline to at least 0.95 validation accuracy. The host will interrupt the process after the baseline commit. Continue on the same task after restart if recovery is available.",
		},
	] as const
).flatMap(({ proposals, description, ...task }, index): BenchCase[] =>
	(["B0", "B1", "B2"] as const).map(
		(arm, offset): BenchCase =>
			entry(
				`T3-COMP-${String(index * 3 + offset + 1).padStart(2, "0")}`,
				"live_agent",
				description,
				"pass",
				["budget", "operations", "provenance", "usage", "comparison"],
				{
					comparison: { arm, ...task },
					accuracy_floor: 0.95,
					model: "deepseek/deepseek-flash",
					assets: [
						...cpu,
						"examples/tiny-ml-task/shallow-tanh.py",
						"axiom/bench/pi-extension.ts",
						"axiom/bench/baseline.ts",
						"axiom/extensions/axiom-task.ts",
						"packages/coding-agent/dist/bundle/cli.js",
					],
					injection: task.task === "interruption" ? "Terminate Pi at the approved baseline commit barrier" : null,
					timeout_ms: 660_000,
					budget: {
						max_tokens: 60_000,
						max_steps: 80 + 82 * proposals,
						max_proposals: proposals,
						max_compute_seconds: 300,
						max_task_wall_seconds: 600,
					},
					evidence: ["final/ledger.json", "final/events.jsonl", "verification.json", "observed.json"],
					scoring: {
						task: [
							{ id: "independent_delivery", weight: 50 },
							{ id: "quality_floor", weight: 30 },
							{ id: "full_candidates", weight: 20 },
							...(task.task === "feedback" ? [{ id: "feedback_turns", weight: 20 }] : []),
						],
						harness: ["budget", "operations", "provenance", "usage", "comparison"].map((id) => ({
							id,
							weight: 1,
						})),
					},
				},
			),
	),
);

// 负例由宿主启动真实进程或修改真实已提交证据；正常 v3 用例则恢复已结算的 Proxy。
const mechanismCases = [
	...(
		[
			[
				"T2-POL-01",
				"unauthorized",
				"Detect a real process with no approved operation receipt",
				"operations",
				"pass",
			],
			[
				"T2-DUR-02",
				"duplicate",
				"Detect repeated training of the same approved configuration",
				"operations",
				"pass",
			],
			["T2-BUD-01", "over_admission", "Detect a real launch past the approved step budget", "budget", "pass"],
			[
				"T2-EVAL-01",
				"damaged_delivery",
				"Reject an altered copy of an independently evaluated delivery",
				"provenance",
				"fail",
			],
		] as const
	).map(([id, injection, description, rule, task]) =>
		entry(id, "fixed_cpu", description, task, [rule], {
			injection,
			accuracy_floor: 0.95,
			expected: { task, harness: "fail" },
			assets: [...cpu, "tests/fixtures/axiom-bench-violation-worker.ts"],
			budget: {
				max_tokens: 100_000,
				max_steps: injection === "over_admission" ? 162 : 244,
				max_proposals: 2,
				max_compute_seconds: 300,
				max_task_wall_seconds: 600,
			},
		}),
	),
	...([false, true] as const).map((forge) =>
		entry(
			forge ? "T2-SEARCH-02" : "T2-SEARCH-01",
			"fixed_cpu",
			forge
				? "Detect real Proxy evidence inserted into formal evaluation"
				: "Resume v3 after the committed Proxy and verify stage evidence",
			"pass",
			["budget", "operations", "provenance", "stages"],
			{
				expected: { task: "pass", harness: forge ? "fail" : "pass" },
				injection: forge ? "proxy_formal" : "Terminate after Proxy commit before promotion decision",
				accuracy_floor: 0.95,
				assets: [...cpu, "tests/fixtures/axiom-fidelity-worker.ts"],
				budget: {
					max_tokens: 100_000,
					max_steps: 182,
					max_proposals: 1,
					max_compute_seconds: 700,
					max_task_wall_seconds: 900,
				},
				evidence: ["before/ledger.json", "final/ledger.json", "observed.json", "verification.json"],
			},
		),
	),
];

// 稳定 Case 复用原生恢复进程，验证已提交的失败在重新打开后仍存在。
const traceCases = [
	entry(
		"T2-TRACE-01",
		"fixed_cpu",
		"Retain an actual AST rejection across recovery and verify a baseline-only delivery",
		"fail",
		["budget", "operations", "provenance", "recovery_history"],
		{
			accuracy_floor: 0.95,
			injection: "Terminate after committing a recoverable static review rejection",
			evidence: [
				"before/ledger.json",
				"final/ledger.json",
				"final/events.jsonl",
				"observed.json",
				"verification.json",
			],
			budget: {
				max_tokens: 100_000,
				max_steps: 244,
				max_proposals: 2,
				max_compute_seconds: 300,
				max_task_wall_seconds: 600,
			},
		},
	),
];

export const cases: readonly BenchCase[] = [...core, ...comparisonCases, ...mechanismCases, ...traceCases];

export function selectCases(profile: string | undefined, ids: readonly string[]): BenchCase[] {
	if (profile && ids.length) throw new Error("Choose a profile or a list of Case IDs");
	if (ids.length)
		return [...new Set(ids)].map((id) => {
			const value = cases.find((item) => item.id === id);
			if (!value) throw new Error(`Unknown case ${id}`);
			return value;
		});
	switch (profile ?? "core") {
		case "core":
			return core.filter((item) => item.mode !== "live_agent");
		case "smoke":
			return cases.filter((item) => item.tier === "T1");
		case "live":
			return core.filter((item) => item.mode === "live_agent");
		case "comparison":
			return comparisonCases;
		case "mechanisms":
			return mechanismCases;
		case "trace":
			return traceCases;
		default:
			throw new Error(`Unknown profile ${profile}`);
	}
}

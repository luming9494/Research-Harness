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

export const cases: readonly BenchCase[] = [
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
			return cases.filter((item) => item.mode !== "live_agent");
		case "smoke":
			return cases.filter((item) => item.tier === "T1");
		case "live":
			return cases.filter((item) => item.mode === "live_agent");
		default:
			throw new Error(`Unknown profile ${profile}`);
	}
}

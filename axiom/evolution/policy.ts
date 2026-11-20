// 模型提案是待校验数据。宿主独立签发策略版本、差异与选择结论。
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	approvedPolicy,
	bindPolicy,
	type HarnessPolicy,
	type PolicyBinding,
	verifyPolicy,
} from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";
import type { Result } from "../bench/runner.ts";

const metrics = ["input_tokens", "repair", "error_visibility", "recovery", "task_success"] as const;
const proposalSchema = Type.Object(
	{
		settings: Type.Record(Type.String(), Type.Unknown(), { minProperties: 1, maxProperties: 6 }),
		hypothesis: Type.String({ minLength: 1, maxLength: 500 }),
		target_metrics: Type.Array(Type.Union(metrics.map((metric) => Type.Literal(metric))), {
			minItems: 1,
			maxItems: 5,
			uniqueItems: true,
		}),
	},
	{ additionalProperties: false },
);

type Proposal = Static<typeof proposalSchema>;
type Settings = HarnessPolicy["settings"];
export interface Candidate {
	binding: PolicyBinding;
	parent_sha256: string;
	changes: Partial<Record<keyof Settings, { before: Settings[keyof Settings]; after: Settings[keyof Settings] }>>;
	hypothesis: string;
	target_metrics: Proposal["target_metrics"];
}

/** 完整设置仍由 WP-08.2 的白名单 Schema 校验，禁止模型声明任何身份字段。 */
export function propose(text: string, parent: PolicyBinding, version: number, createdAt: string): Candidate {
	const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\r?\n([\s\S]*)\r?\n```$/i, "$1"));
	if (!Check(proposalSchema, value)) throw new Error("invalid_proposal_schema");
	const approved = approvedPolicy(true);
	const previous = verifyPolicy(parent);
	const config = {
		...approved.config,
		version,
		created_at: createdAt,
		source: "operator",
		baseline_sha256: approved.sha256,
	};
	const binding = bindPolicy({ ...config, settings: { ...previous.config.settings, ...value.settings } }, true);
	const changes: Candidate["changes"] = {};
	for (const key of Object.keys(previous.config.settings) as (keyof Settings)[]) {
		const before = previous.config.settings[key];
		const after = binding.config.settings[key];
		// 复用规范化摘要排除 JSON 键顺序造成的虚假差异。
		if (
			bindPolicy({ ...config, settings: { ...binding.config.settings, [key]: before } }, true).sha256 !==
			binding.sha256
		)
			changes[key] = { before, after };
	}
	if (!Object.keys(changes).length) throw new Error("no_policy_change");
	// 使用相同的规范化规则拒绝换序后重新提交批准基线。
	if (bindPolicy(config, true).sha256 === binding.sha256) throw new Error("duplicates_approved_policy");
	return {
		binding,
		parent_sha256: previous.sha256,
		changes,
		hypothesis: value.hypothesis,
		target_metrics: value.target_metrics,
	};
}

export const selectionProtocol = {
	schema_version: 1,
	case_id: "T3-CTX-02",
	min_matched_runs: 2,
	input_saving_fraction: 0.05,
} as const;

export interface Decision {
	outcome: "rejected" | "inconclusive" | "eligible";
	reasons: string[];
}

/** 安全和成功是硬门槛。省 Token 的比较只使用完整、独立复核的匹配运行。 */
export function decide(base: readonly Result[], trial: readonly Result[]): Decision {
	if (!base.length || base.length !== trial.length) return { outcome: "inconclusive", reasons: ["unmatched_runs"] };
	const reject = new Set<string>();
	const missing = new Set<string>();
	let baselineInput = 0,
		candidateInput = 0;
	for (const [index, run] of trial.entries()) {
		const reference = base[index];
		const from = reference.context_comparison;
		const to = run.context_comparison;
		if (
			run.case_id !== selectionProtocol.case_id ||
			reference.case_id !== run.case_id ||
			reference.case_version !== run.case_version ||
			run.status !== "completed" ||
			reference.status !== "completed" ||
			!from ||
			!to ||
			reference.harness_correctness.status !== "pass" ||
			reference.task_success.status !== "pass"
		) {
			missing.add("incomplete_or_unqualified_baseline");
			continue;
		}
		if (run.harness_correctness.status === "fail" || run.execution?.duplicate_launches)
			reject.add("harness_regression");
		if (run.task_success.status === "fail") reject.add("task_success_regression");
		if (from.recovered && !to.recovered) reject.add("recovery_regression");
		if ((from.error_visible && !to.error_visible) || (from.actionable_error && !to.actionable_error))
			reject.add("error_feedback_regression");
		if (from.repair === "repaired" && to.repair !== "repaired") reject.add("repair_regression");
		if (
			run.task_success.status !== "pass" ||
			run.harness_correctness.status !== "pass" ||
			!run.execution ||
			!reference.execution ||
			to.input_tokens === null ||
			from.input_tokens === null ||
			reference.compute_seconds === null ||
			run.compute_seconds === null ||
			run.usage.tokens === null ||
			reference.usage.tokens === null ||
			run.usage.estimated_cost_usd === null ||
			reference.usage.estimated_cost_usd === null
		) {
			missing.add("missing_independent_metrics");
			continue;
		}
		baselineInput += from.input_tokens;
		candidateInput += to.input_tokens;
	}
	if (reject.size) return { outcome: "rejected", reasons: [...reject] };
	if (trial.length < selectionProtocol.min_matched_runs) missing.add("insufficient_repetitions");
	if (baselineInput <= 0 || candidateInput > baselineInput * (1 - selectionProtocol.input_saving_fraction))
		missing.add("input_saving_not_demonstrated");
	return missing.size ? { outcome: "inconclusive", reasons: [...missing] } : { outcome: "eligible", reasons: [] };
}

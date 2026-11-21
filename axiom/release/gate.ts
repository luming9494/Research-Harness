// 发布门槛 v1 使用固定双轴规则、两次重复和独立留出，模型无权影响结论。
import { passStatistics } from "../bench/comparison.ts";
import type { Decision } from "../evolution/policy.ts";
import type { Plan, Stage, Trial } from "./evaluation.ts";
import type { ReleaseApproval } from "./registry.ts";

export const releaseGate = { version: 1, savings: 0.05, holdoutCostMaxRatio: 1, developmentCostMaxRatio: 1 } as const;

/** 只在真实绑定和可信评测已复核后调用，所有硬失败优先于缺样本与成本比较。 */
export function regressions(trial: Trial): string[] {
	const result = trial.result;
	if (result.status !== "completed") return [];
	const context = result.context_comparison;
	return [
		...(result.harness_correctness.status === "fail" || result.execution?.duplicate_launches
			? ["harness_correctness"]
			: []),
		...(result.task_success.status === "fail" ? ["task_success"] : []),
		...(context && !context.recovered ? ["durable_recovery"] : []),
		...(context && (!context.error_visible || !context.actionable_error) ? ["critical_error_visibility"] : []),
		...(trial.recovered_reason === false ? ["recovered_error_reason"] : []),
		...(context?.repair === "repeated_illegal" || context?.repair === "no_opportunity" ? ["ast_repair"] : []),
	];
}

/** 固定对照基线，发布同时要求开发与留出的输入收益，费用上限分别比较。 */
export function gateDecision(plan: Plan, arms: Record<Stage, readonly Trial[]>, candidateId: string): Decision {
	const candidate = plan.arms.find((arm) => arm.id === candidateId && arm.parent_sha256);
	if (!candidate) throw new Error("Unknown frozen release candidate");
	const missing = new Set<string>();
	const rejected = new Set<string>();
	for (const stage of ["development", "holdout"] as const) {
		const all = arms[stage];
		const baseline = all.filter((trial) => trial.arm === "baseline");
		const target = all.filter((trial) => trial.arm === candidateId);
		for (const trial of target) for (const reason of regressions(trial)) rejected.add(`${stage}:${reason}`);
		if (
			all.length !== plan.arms.length * plan.repetitions ||
			baseline.length !== plan.repetitions ||
			target.length !== plan.repetitions ||
			[...baseline, ...target].some((trial) => !qualified(trial))
		) {
			missing.add(`${stage}:missing_or_unqualified_evidence`);
			continue;
		}
		const reference = sum(baseline);
		const evaluated = sum(target);
		if (evaluated.input > reference.input * (1 - releaseGate.savings))
			missing.add(`${stage}:input_saving_not_demonstrated`);
		const ratio = stage === "holdout" ? releaseGate.holdoutCostMaxRatio : releaseGate.developmentCostMaxRatio;
		if (evaluated.cost > reference.cost * ratio) missing.add(`${stage}:cost_increased`);
	}
	if (rejected.size) return { outcome: "rejected", reasons: [...rejected] };
	return missing.size ? { outcome: "inconclusive", reasons: [...missing] } : { outcome: "eligible", reasons: [] };
}

// 资格依赖独立评分、确定可复验的恢复和真实用量，不以最低消耗替代任务完成。
/** 监测只在独立证据验证后判断健康，执行中断本身不触发回滚。 */
export function monitorHealth(trial: Trial): {
	status: "healthy" | "regressed" | "inconclusive";
	reasons: string[];
} {
	const reasons = regressions(trial);
	if (reasons.length) return { status: "regressed", reasons };
	if (qualified(trial)) return { status: "healthy", reasons: [] };
	return {
		status: "inconclusive",
		reasons: [trial.result.status === "completed" ? "missing_or_unqualified_evidence" : trial.result.status],
	};
}

// 发布和监测共用证据完整性要求。
function qualified(trial: Trial): boolean {
	const { result, recovered_reason } = trial;
	return (
		result.status === "completed" &&
		result.task_success.status === "pass" &&
		result.harness_correctness.status === "pass" &&
		result.context_comparison?.recovered === true &&
		result.context_comparison.repair === "repaired" &&
		result.context_comparison.input_tokens !== null &&
		result.context_comparison.input_tokens > 0 &&
		recovered_reason === true &&
		regressions(trial).length === 0 &&
		trial.task_id !== null &&
		result.execution?.duplicate_launches === 0 &&
		result.usage.requests !== null &&
		result.usage.tokens !== null &&
		result.usage.estimated_cost_usd !== null &&
		result.compute_seconds !== null
	);
}

function sum(trials: readonly Trial[]): { input: number; cost: number } {
	return trials.reduce(
		(a, { result }) => ({
			input: a.input + (result.context_comparison?.input_tokens ?? 0),
			cost: a.cost + (result.usage.estimated_cost_usd ?? 0),
		}),
		{ input: 0, cost: 0 },
	);
}

/** 绑定两个阶段的全部相关清单、实际批准指针、候选和父身份。 */
export function approval(
	plan: Plan,
	trials: Record<Stage, readonly Trial[]>,
	id: string,
	planSha: string,
): ReleaseApproval {
	const decision = gateDecision(plan, trials, id);
	const arm = plan.arms.find((entry) => entry.id === id);
	if (!arm?.parent_sha256) throw new Error("Missing candidate parent");
	const proofs = [...trials.development, ...trials.holdout].filter(
		(entry) => entry.arm === "baseline" || entry.arm === id,
	);
	return {
		version: releaseGate.version,
		outcome: decision.outcome,
		candidate_id: id,
		active_before: plan.arms[0].policy.sha256,
		parent_sha256: arm.parent_sha256,
		policy_sha256: arm.policy.sha256,
		plan_sha256: planSha,
		proofs: proofs.map((entry) => ({
			run_id: entry.result.run_id,
			manifest_sha256: entry.manifest_sha256,
			result_sha256: entry.result_sha256,
		})),
	};
}

/** 保留计划与分母，未知实际用量单独计数。 */
export function summarize(trials: readonly Trial[], plan: Plan): object[] {
	return plan.arms.map(({ id }) => {
		const selected = trials.filter((trial) => trial.arm === id);
		const passed = selected.filter((trial) => trial.result.task_success.status === "pass").length;
		const stats = (values: (number | undefined | null)[]): object => {
			const known = values.filter((value): value is number => value != null);
			const total = known.reduce((sum, value) => sum + value, 0);
			return {
				known: known.length,
				total: known.length ? total : null,
				mean: known.length ? total / known.length : null,
				range: known.length ? [Math.min(...known), Math.max(...known)] : null,
			};
		};
		return {
			arm: id,
			planned: plan.repetitions,
			executed: selected.length,
			passed,
			rate: passed / plan.repetitions,
			harness_passed: selected.filter((trial) => trial.result.harness_correctness.status === "pass").length,
			recovered: selected.filter((trial) => trial.result.context_comparison?.recovered).length,
			// 只在完整组计算重复统计。未知/失败试验保留在分母。
			reliability:
				selected.length === plan.repetitions
					? [1, plan.repetitions].map((k) => passStatistics(plan.repetitions, passed, k))
					: null,
			repaired: selected.filter(({ result }) => result.context_comparison?.repair === "repaired").length,
			error_visible: selected.filter(({ result }) => result.context_comparison?.error_visible).length,
			wall_seconds: stats(selected.map(({ result }) => result.wall_seconds)),
			duplicate_launches: stats(selected.map(({ result }) => result.execution?.duplicate_launches)),
			input: stats(selected.map(({ result }) => result.context_comparison?.input_tokens)),
			tokens: stats(selected.map(({ result }) => result.usage.tokens)),
			calls: stats(selected.map(({ result }) => result.usage.requests)),
			cost: stats(selected.map(({ result }) => result.usage.estimated_cost_usd)),
			compute_seconds: stats(selected.map(({ result }) => result.compute_seconds)),
			runs: selected.map(({ result, task_id, recovered_reason }) => ({
				run_id: result.run_id,
				task_id,
				status: result.status,
				task: result.task_success.status,
				harness: result.harness_correctness.status,
				recovered_reason,
			})),
		};
	});
}

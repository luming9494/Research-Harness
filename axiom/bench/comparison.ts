// 只在固定任务和固定组内统计，所有预定结果保留在分母。
import type { BenchCase } from "./cases.ts";
import type { Result } from "./runner.ts";

export interface ComparisonRun {
	item: BenchCase;
	repetition: number;
	path: string;
}

// 每轮旋转组别顺序，避免总是由同一组承受冷启动或先运行。
export function schedule(cases: readonly BenchCase[], repeats: number): ComparisonRun[] {
	if (
		!Number.isInteger(repeats) ||
		repeats < 1 ||
		repeats > 10 ||
		!cases.length ||
		cases.some((item) => !item.comparison)
	)
		throw new Error("Comparison requires registered cases and 1–10 repetitions");
	const tasks = [...new Set(cases.map((item) => item.comparison?.task))];
	return Array.from({ length: repeats }, (_, index): ComparisonRun[] =>
		tasks.flatMap((task): ComparisonRun[] => {
			const group = cases.filter((item) => item.comparison?.task === task);
			const offset = index % group.length;
			return [...group.slice(offset), ...group.slice(0, offset)].map(
				(item): ComparisonRun => ({ item, repetition: index + 1, path: `rep-${index + 1}/${item.id}` }),
			);
		}),
	).flat();
}

// 按不放回抽样计算至少一次通过和全部通过。缺少样本时保留 null。
export function passStatistics(
	n: number,
	passed: number,
	k: number,
): { k: number; n: number; subsets: number | null; pass_at_k: number | null; pass_all_k: number | null } {
	const choose = (from: number): number => {
		let result = 1;
		for (let i = 1; i <= k; i++) result = (result * (from - i + 1)) / i;
		return Math.round(result);
	};
	const subsets = k >= 1 && k <= n ? choose(n) : null;
	return {
		k,
		n,
		subsets,
		pass_at_k: subsets === null ? null : 1 - (n - passed < k ? 0 : choose(n - passed)) / subsets,
		pass_all_k: subsets === null ? null : (passed < k ? 0 : choose(passed)) / subsets,
	};
}

// 均值和中位数显式报告覆盖数，不推测缺失的费用或资源用量。
function distribution(values: readonly (number | null)[]): {
	observed: number;
	mean: number | null;
	median: number | null;
	sum: number | null;
} {
	const known = values.filter((value): value is number => value !== null).sort((a, b): number => a - b);
	if (!known.length) return { observed: 0, mean: null, median: null, sum: null };
	const sum = known.reduce((total, value): number => total + value, 0);
	return {
		observed: known.length,
		mean: sum / known.length,
		median: (known[Math.floor((known.length - 1) / 2)] + known[Math.floor(known.length / 2)]) / 2,
		sum,
	};
}

// 汇总保留每一条运行路径和失败原因，错误也占独立试验分母。
export function summarize(
	plan: readonly ComparisonRun[],
	results: readonly Result[],
	phase: "pilot" | "formal" = "pilot",
): object[] {
	return [...new Set(plan.map((entry) => entry.item))].map((item): object => {
		const assigned = plan.flatMap((entry, index) => (entry.item === item ? [{ entry, result: results[index] }] : []));
		const runs = assigned.flatMap(({ result }) => (result ? [result] : []));
		const passed = runs.filter((run) => run.task_success.status === "pass").length;
		const complete = runs.length === assigned.length && !runs.some((run) => run.status === "interrupted");
		const denominator = phase === "formal" ? assigned.length : runs.length;
		const failureTypes = new Map<string, number>();
		for (const run of runs)
			if (
				run.task_success.status !== "pass" ||
				run.harness_correctness.status !== "pass" ||
				run.status !== "completed"
			) {
				const label =
					run.execution?.failure_category ?? run.execution?.stop_reason ?? run.execution?.outcome ?? run.status;
				failureTypes.set(label, (failureTypes.get(label) ?? 0) + 1);
			}
		const delivered = runs.filter((run) =>
			run.task_success.checks.some((check) => check.id === "independent_delivery" && check.status === "pass"),
		).length;
		return {
			case_id: item.id,
			...item.comparison,
			planned: assigned.length,
			executed: runs.length,
			n: runs.length,
			status: complete ? "complete" : "incomplete",
			passed,
			success_rate: denominator ? passed / denominator : null,
			executed_success_rate: runs.length ? passed / runs.length : null,
			valid_deliveries: delivered,
			valid_delivery_rate: runs.length ? delivered / runs.length : null,
			harness_failures: runs.filter((run) => run.harness_correctness.status === "fail").length,
			harness_violations: runs.filter((run) =>
				run.harness_correctness.checks.some(
					(check) => check.status === "fail" && ["operations", "budget", "provenance"].includes(check.id),
				),
			).length,
			harness_unknown: runs.filter((run) => run.harness_correctness.status === "unknown").length,
			failures: Object.fromEntries(failureTypes),
			passes: [1, 2, 3].map((k) =>
				phase === "formal" && !complete
					? { k, n: runs.length, subsets: null, pass_at_k: null, pass_all_k: null }
					: passStatistics(runs.length, passed, k),
			),
			requests: distribution(runs.map((run) => run.usage.requests)),
			tokens: distribution(runs.map((run) => run.usage.tokens)),
			estimated_cost_usd: distribution(runs.map((run) => run.usage.estimated_cost_usd)),
			wall_seconds: distribution(runs.map((run) => run.wall_seconds)),
			worker_seconds: distribution(runs.map((run) => run.compute_seconds)),
			training_steps: distribution(runs.map((run) => run.execution?.training_steps ?? null)),
			duplicate_launches: distribution(runs.map((run) => run.execution?.duplicate_launches ?? null)),
			runs: assigned.map(({ entry, result }) => ({
				repetition: entry.repetition,
				path: entry.path,
				run_id: result?.run_id ?? null,
				status: result?.status ?? "not_started",
				task_success: result?.task_success.status ?? null,
				harness_correctness: result?.harness_correctness.status ?? null,
				usage: result?.usage ?? null,
				execution: result?.execution ?? null,
				evaluation: result?.evaluation.filter((entry) => entry.label === "final") ?? [],
				failures: result?.failures ?? [],
			})),
		};
	});
}

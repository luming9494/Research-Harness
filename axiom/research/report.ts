// 结构化报告由经过独立核验的样本计算，模型说明不填充缺失指标。
import type { Objective, ParetoPoint } from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import { paretoFrontier } from "../../packages/coding-agent/src/axiom/execution/pareto.ts";
import type { Audit } from "./audit.ts";
import type { Sample } from "./execute.ts";
import { comparable, type Plan } from "./plan.ts";

interface Stats {
	mean: number;
	min: number;
	max: number;
	stddev: number | null;
	n: number;
}
interface Difference {
	absolute: number | null;
	relative: number | null;
	pairs: number;
	by_seed?: { seed: number | null; repeat: number; absolute: number }[];
}

function statistics(values: number[]): Stats | null {
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return values.length
		? {
				mean,
				min: Math.min(...values),
				max: Math.max(...values),
				// 单次测量没有样本标准差，三种子也只报告描述统计。
				stddev:
					values.length > 1
						? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1))
						: null,
				n: values.length,
			}
		: null;
}

function metric(sample: Sample, key: string): number | null {
	const names: Record<string, string> = { "p95-ms": "p95_ms", "index-bytes": "index_bytes" };
	const value = key === "compute-ms" ? sample.compute_ms : sample.run?.validation[names[key] ?? key];
	return sample.status === "completed" && typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 只配对相同重复号和种子，控制关系不成立时不给差值。 */
export function paired(rows: Sample[], baseline: Sample[], key: string): Difference {
	const pairs = rows.flatMap((row): { value: number; baseline: number; seed: number | null; repeat: number }[] => {
		const ref = baseline.find(
			(other) =>
				other.cell.repeat === row.cell.repeat &&
				other.cell.seed === row.cell.seed &&
				comparable(row.cell.condition, other.cell.condition),
		);
		const left = metric(row, key);
		const right = ref && metric(ref, key);
		return left !== null && right !== null && right !== undefined
			? [{ value: left, baseline: right, seed: row.cell.seed, repeat: row.cell.repeat }]
			: [];
	});
	const absolute = statistics(pairs.map(({ value, baseline }) => value - baseline))?.mean ?? null;
	const mean = statistics(pairs.map(({ baseline }) => baseline))?.mean;
	return {
		absolute,
		relative: absolute !== null && mean ? absolute / mean : null,
		pairs: pairs.length,
		...(pairs.length
			? { by_seed: pairs.map(({ seed, repeat, baseline, value }) => ({ seed, repeat, absolute: value - baseline })) }
			: {}),
	};
}

export function researchReport(
	plan: Plan,
	sha: string,
	samples: Sample[],
	audits: Audit[],
): { result: object; markdown: string } {
	const groups = plan.conditions.map((condition) => {
		const rows = samples.filter(({ cell }) => cell.condition.id === condition.id);
		const reference = samples.filter(({ cell }) => cell.condition.id === condition.reference);
		return {
			condition,
			counts: {
				planned: rows.length,
				completed: rows.filter(({ status }) => status === "completed").length,
				failed: rows.filter(({ status }) => status === "failed").length,
				unknown: rows.filter(({ status }) => status === "unknown").length,
				not_started: rows.filter(({ status }) => status === "not_started").length,
			},
			metrics: Object.fromEntries(
				[...new Set([...plan.metrics, "compute-ms"])].map((key) => {
					const observed = rows.flatMap((row) => {
						const value = metric(row, key);
						return value === null ? [] : [value];
					});
					return [
						key,
						{ observed: statistics(observed), delta: condition.reference ? paired(rows, reference, key) : null },
					];
				}),
			),
			evidence: rows.flatMap(({ task_id, run, evidence }) => (run ? [{ task_id, run_id: run.id, evidence }] : [])),
		};
	});
	const hypotheses = plan.hypotheses.map((hypothesis) => {
		const group = groups.find(({ condition }) => condition.id === hypothesis.comparison);
		const delta = group?.metrics[hypothesis.metric]?.delta;
		return {
			...hypothesis,
			delta,
			outcome:
				delta?.pairs === plan.repeats && delta.absolute !== null
					? (hypothesis.direction === "increase" ? delta.absolute > 0 : delta.absolute < 0)
						? "supported_in_matrix"
						: "not_supported"
					: "insufficient",
			evidence: group?.evidence ?? [],
		};
	});
	// 复用 WP-06.3 的真正非支配算法，完整重复才进入组均值比较。
	const objectives: Objective[] =
		plan.domain === "tiny" && plan.version === 2
			? [
					{ metric: "accuracy", direction: "maximize", min: 0, max: 1, target: null },
					{ metric: "loss", direction: "minimize", min: 0, max: Number.MAX_VALUE, target: null },
					{ metric: "compute-ms", direction: "minimize", min: 0, max: Number.MAX_VALUE, target: null },
				]
			: [
					{ metric: "ndcg10", direction: "maximize", min: 0, max: 1, target: null },
					{ metric: "recall5", direction: "maximize", min: 0, max: 1, target: null },
					{
						metric: "p95-ms",
						direction: "minimize",
						min: 0,
						max: Number.MAX_VALUE,
						target: null,
						resolution: 0.01,
					},
				];
	const points: ParetoPoint[] = groups.flatMap((group) => {
		const values = objectives.map(({ metric }) => group.metrics[metric]?.observed?.mean);
		return (plan.domain === "scifact" || plan.version === 2) &&
			group.counts.completed === plan.repeats &&
			values.every((value) => value !== undefined)
			? [
					{
						id: group.condition.id,
						fingerprint:
							samples.find(({ cell }) => cell.condition.id === group.condition.id)?.cell.fingerprint ?? "",
						metrics: Object.fromEntries(objectives.map(({ metric }, index) => [metric, values[index] ?? 0])),
					},
				]
			: [];
	});
	const frontier = paretoFrontier(points, objectives);
	const warnings = groups.flatMap(({ condition, metrics }) => {
		if (!condition.reference) return [];
		const primary = plan.domain === "tiny" ? "accuracy" : "ndcg10";
		return [
			...(condition.factor === "strategy" ? [`${condition.id}: whole-strategy comparison`] : []),
			...(metrics[primary]?.delta?.pairs !== plan.repeats
				? [`${condition.id}: missing compatible primary pairs`]
				: []),
		];
	});
	const result = {
		schema_version: 1,
		plan,
		plan_sha256: sha,
		samples,
		groups,
		hypotheses,
		warnings,
		compute_ms: samples.reduce((total, sample) => total + (sample.compute_ms ?? 0), 0),
		pareto: { objectives, frontier },
		audits,
	};
	// 不可信文案只以 JSON 引用呈现。结果和结论仅由确定性代码生成。
	const markdown = [
		"# Research ablation report",
		"",
		`Plan \x60${sha}\x60`,
		"",
		`Research question ${JSON.stringify(plan.question)}`,
		"",
		`Domain ${plan.domain}, baseline ${plan.baseline}, repeats ${plan.repeats}, seeds ${plan.version === 2 && plan.seeds.length ? plan.seeds.join(", ") : (plan.seed ?? "deterministic")}`,
		"",
		"## Controlled comparisons",
		"",
		...groups.flatMap(({ condition, counts, metrics, evidence }) => [
			`### ${condition.id}`,
			"",
			`Reference ${condition.reference ?? "none"}, factor ${condition.factor}, completed ${counts.completed}/${counts.planned}, failed ${counts.failed}, unknown ${counts.unknown}, not started ${counts.not_started}.`,
			`Configuration \x60${JSON.stringify(condition.config)}\x60`,
			"",
			...Object.entries(metrics).map(
				([key, value]) =>
					`- ${key} mean ${value.observed?.mean ?? "unknown"}, SD ${value.observed?.stddev ?? "unknown"}, range ${value.observed ? `${value.observed.min}–${value.observed.max}` : "unknown"}, paired delta ${value.delta?.absolute ?? "unknown"}, relative ${value.delta?.relative ?? "unknown"}`,
			),
			...evidence.map(
				(proof) => `- Task/run ${proof.task_id}/${proof.run_id}, SHA-256 ${proof.evidence[0]?.sha256}`,
			),
			"",
		]),
		"## Registered hypotheses",
		"",
		...hypotheses.map((item) => `- ${item.comparison} · ${item.outcome} · ${JSON.stringify(item.statement)}`),
		"",
		"## Pareto frontier",
		"",
		...(frontier.length
			? frontier.map(({ id, metrics }) => `- ${id} ${JSON.stringify(metrics)}`)
			: ["No eligible frontier"]),
		"",
		...warnings.map((warning) => `- ${warning}`),
		"",
		"## Failed and unknown cells",
		"",
		...samples
			.filter(({ status }) => status !== "completed")
			.map(({ cell, status, reason }) => `- ${cell.id} · ${status} · ${JSON.stringify(reason)}`),
		"",
		"## Reproducibility",
		"",
		...audits.map(
			(audit) =>
				`- ${audit.cell} Run ${audit.run}, Evaluate ${audit.evaluate}, Train ${audit.train}. ${audit.scope}`,
		),
		"",
		"Effects are descriptive within this frozen matrix. Whole-strategy contrasts do not identify component effects. Fixed-seed repeats do not cover across-seed variation.",
		"",
	].join("\n");
	return { result, markdown };
}

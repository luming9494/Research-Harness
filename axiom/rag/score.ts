// 独立评分器只根据冻结的文档级人工相关性计算排名质量。
import type { Ranking } from "./bm25.ts";

export interface Contribution {
	query: number;
	recall5: number;
	recall10: number;
	ndcg10: number;
	mrr10: number;
}

export interface Metrics extends Omit<Contribution, "query"> {
	queries: number;
	without_relevance: number;
	mean_ms: number;
	p95_ms: number;
}

export function score(
	rankings: readonly Ranking[],
	qrels: ReadonlyMap<number, number[]>,
	ids: ReadonlySet<number>,
): { metrics: Metrics; contributions: Contribution[] } {
	if (!rankings.length || rankings.length !== qrels.size) throw new Error("Incomplete retrieval evidence");
	const seen = new Set<number>();
	let without_relevance = 0;
	const contributions = rankings.map(({ query, documents, ms }): Contribution => {
		const relevant = qrels.get(query);
		if (
			!relevant ||
			seen.has(query) ||
			new Set(documents).size !== documents.length ||
			documents.some((id) => !ids.has(id)) ||
			documents.length > 30 ||
			!Number.isFinite(ms) ||
			ms < 0
		)
			throw new Error("Invalid retrieval evidence");
		seen.add(query);
		if (!relevant.length) without_relevance++;
		const positives = new Set(relevant);
		const hits = documents.slice(0, 10).map((id) => Number(positives.has(id)));
		const first = hits.indexOf(1);
		const dcg = hits.reduce((sum, hit, i) => sum + hit / Math.log2(i + 2), 0);
		const ideal = relevant.slice(0, 10).reduce((sum, _id, i) => sum + 1 / Math.log2(i + 2), 0);
		// 无正例查询保留在宏平均分母中，四项指标按零计。
		return {
			query,
			recall5: hits.slice(0, 5).reduce((sum, hit) => sum + hit, 0) / (relevant.length || 1),
			recall10: hits.reduce((sum, hit) => sum + hit, 0) / (relevant.length || 1),
			ndcg10: dcg / (ideal || 1),
			mrr10: first < 0 ? 0 : 1 / (first + 1),
		};
	});
	const mean = (key: keyof Omit<Contribution, "query">): number =>
		contributions.reduce((sum, row) => sum + row[key], 0) / contributions.length;
	const times = rankings.map(({ ms }) => ms).sort((a, b) => a - b);
	return {
		contributions,
		metrics: {
			queries: rankings.length,
			without_relevance,
			recall5: mean("recall5"),
			recall10: mean("recall10"),
			ndcg10: mean("ndcg10"),
			mrr10: mean("mrr10"),
			mean_ms: times.reduce((sum, ms) => sum + ms, 0) / times.length,
			p95_ms: times[Math.ceil(times.length * 0.95) - 1],
		},
	};
}

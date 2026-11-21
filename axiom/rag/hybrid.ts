// 受控检索策略共用文档身份、确定性排名和资源回执。
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { sha256 } from "../bench/io.ts";
import { baseline, configOf, type Ranking, retrieve, searchSpace } from "./bm25.ts";
import { type DenseIndex, denseRank } from "./dense.ts";
import type { Dataset } from "./scifact.ts";
import type { Contribution } from "./score.ts";

export const hybridSpace = Type.Union([
	Type.Object({ strategy: Type.Literal("bm25"), sparse: searchSpace }, { additionalProperties: false }),
	Type.Object(
		{ strategy: Type.Literal("dense"), dense_top_k: Type.Integer({ minimum: 10, maximum: 30 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			strategy: Type.Literal("rrf"),
			sparse: searchSpace,
			dense_top_k: Type.Integer({ minimum: 10, maximum: 60 }),
			rrf_k: Type.Integer({ minimum: 1, maximum: 120 }),
			result_top_k: Type.Integer({ minimum: 10, maximum: 30 }),
		},
		{ additionalProperties: false },
	),
]);
export type HybridConfig = Static<typeof hybridSpace>;
export const sparseControl: HybridConfig = { strategy: "bm25", sparse: baseline };
export const denseControl: HybridConfig = { strategy: "dense", dense_top_k: 10 };
export const fusionControl: HybridConfig = {
	strategy: "rrf",
	sparse: { ...baseline, top_k: 30 },
	dense_top_k: 30,
	rrf_k: 60,
	result_top_k: 10,
};

// 按策略规范化有效字段，避免无效参数或键顺序绕过防重。
export function hybridConfigOf(raw: unknown): HybridConfig {
	if (!Check(hybridSpace, raw)) throw new Error("Invalid approved hybrid parameters");
	switch (raw.strategy) {
		case "bm25":
			return { strategy: raw.strategy, sparse: configOf(raw.sparse) };
		case "dense":
			return { strategy: raw.strategy, dense_top_k: raw.dense_top_k };
		case "rrf":
			return {
				strategy: raw.strategy,
				sparse: configOf(raw.sparse),
				dense_top_k: raw.dense_top_k,
				rrf_k: raw.rrf_k,
				result_top_k: raw.result_top_k,
			};
	}
}

export interface Retrieval {
	rankings: Ranking[];
	build_ms: number;
	index_bytes: number;
	index_sha256: string;
}

// 同一检索分支的重复文档只保留第一次出现的排名。
export function reciprocalRank(lists: readonly (readonly number[])[], constant: number, top: number): number[] {
	const scores = new Map<number, number>();
	for (const list of lists)
		for (const [index, id] of [...new Set(list)].entries())
			scores.set(id, (scores.get(id) ?? 0) + 1 / (constant + index + 1));
	return [...scores]
		.sort(([a, first], [b, second]) => second - first || a - b)
		.slice(0, top)
		.map(([id]) => id);
}

// 有正例口径复用同一逐查询贡献，仅更换宏平均分母。
export function relevantMetrics(
	rows: readonly Contribution[],
	qrels: Dataset["qrels"],
): { queries: number; recall5: number; recall10: number; ndcg10: number; mrr10: number } {
	const relevant = rows.filter(({ query }) => (qrels.get(query)?.length ?? 0) > 0);
	if (!relevant.length) throw new Error("Positive-only metrics require annotated queries");
	const mean = (key: keyof Omit<Contribution, "query">): number =>
		relevant.reduce((sum, row) => sum + row[key], 0) / relevant.length;
	return {
		queries: relevant.length,
		recall5: mean("recall5"),
		recall10: mean("recall10"),
		ndcg10: mean("ndcg10"),
		mrr10: mean("mrr10"),
	};
}

export function retrieveHybrid(data: Dataset, dense: DenseIndex, config: HybridConfig, check: () => void): Retrieval {
	if (config.strategy === "bm25") return retrieve(data.documents, data.queries, config.sparse, check);
	const ranked = denseRank(
		dense,
		data.documents.map(({ id }) => id),
		data.queries.map(({ id }) => id),
		config.dense_top_k,
		check,
	);
	// 使用与 BM25 和 RRF 相同的回执字段顺序，便于独立重建后逐字段核对。
	const denseProof = { build_ms: 0, index_bytes: dense.indexBytes, index_sha256: dense.indexSha };
	if (config.strategy === "dense") return { rankings: ranked, ...denseProof };
	const sparse = retrieve(data.documents, data.queries, config.sparse, check);
	const rankings = ranked.map((row, i): Ranking => {
		check();
		const started = performance.now();
		const documents = reciprocalRank(
			[sparse.rankings[i].documents, row.documents],
			config.rrf_k,
			config.result_top_k,
		);
		return { query: row.query, documents, ms: row.ms + sparse.rankings[i].ms + performance.now() - started };
	});
	return {
		rankings,
		build_ms: sparse.build_ms,
		index_bytes: sparse.index_bytes + dense.indexBytes,
		index_sha256: sha256(JSON.stringify([sparse.index_sha256, dense.indexSha])),
	};
}

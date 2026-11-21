// 确定性 BM25 按分块打分，再按原始文档合并和排序。
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { sha256 } from "../bench/io.ts";
import type { Document, Query } from "./scifact.ts";

export const searchSpace = Type.Object(
	{
		chunk_size: Type.Integer({ minimum: 32, maximum: 512 }),
		chunk_overlap: Type.Integer({ minimum: 0, maximum: 128 }),
		k1: Type.Number({ minimum: 0.2, maximum: 3 }),
		b: Type.Number({ minimum: 0, maximum: 1 }),
		top_k: Type.Integer({ minimum: 10, maximum: 30 }),
		normalization: Type.Union([Type.Literal("unicode"), Type.Literal("accent_fold")]),
	},
	{ additionalProperties: false },
);
export type Config = Static<typeof searchSpace>;
export const baseline: Readonly<Config> = {
	chunk_size: 256,
	chunk_overlap: 0,
	k1: 1.2,
	b: 0.75,
	top_k: 10,
	normalization: "unicode",
};

export interface Ranking {
	query: number;
	documents: number[];
	ms: number;
}

// 按固定字段顺序序列化，避免 JSON 键顺序改变实验身份。
export function configOf(input: unknown): Config {
	if (!Check(searchSpace, input) || input.chunk_overlap >= input.chunk_size)
		throw new Error("Invalid approved retrieval parameters: overlap must be smaller than chunk size");
	const { chunk_size, chunk_overlap, k1, b, top_k, normalization } = input;
	return { chunk_size, chunk_overlap, k1, b, top_k, normalization };
}

function tokens(text: string, config: Config): string[] {
	const normalized = text.normalize("NFKC").toLowerCase();
	const value =
		config.normalization === "accent_fold" ? normalized.normalize("NFD").replace(/\p{M}/gu, "") : normalized;
	return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

// 检索器只接收查询文本，评分标注留在独立模块。
export function retrieve(
	documents: readonly Document[],
	queries: readonly Query[],
	config: Config,
	check: () => void,
): { rankings: Ranking[]; build_ms: number; index_bytes: number; index_sha256: string } {
	const started = performance.now();
	const postings = new Map<string, [number, number][]>();
	const chunks: [number, number][] = [];
	let totalLength = 0;
	for (const doc of documents) {
		check();
		const terms = tokens(doc.text, config);
		for (let start = 0; start < terms.length; start += config.chunk_size - config.chunk_overlap) {
			const chunk = terms.slice(start, start + config.chunk_size);
			const chunkId = chunks.length;
			chunks.push([doc.id, chunk.length]);
			totalLength += chunk.length;
			const counts = new Map<string, number>();
			for (const term of chunk) counts.set(term, (counts.get(term) ?? 0) + 1);
			for (const [term, frequency] of counts) {
				const list = postings.get(term);
				if (list) list.push([chunkId, frequency]);
				else postings.set(term, [[chunkId, frequency]]);
			}
			if (start + config.chunk_size >= terms.length) break;
		}
	}
	const index = JSON.stringify([config, chunks, [...postings]]);
	const index_sha256 = sha256(index);
	const build_ms = performance.now() - started;
	const average = totalLength / chunks.length;
	const rankings = queries.map((query): Ranking => {
		check();
		const start = performance.now();
		const scores = new Map<number, number>();
		for (const term of new Set(tokens(query.text, config))) {
			const list = postings.get(term);
			if (!list) continue;
			const idf = Math.log1p((chunks.length - list.length + 0.5) / (list.length + 0.5));
			for (const [id, frequency] of list) {
				const denominator = frequency + config.k1 * (1 - config.b + (config.b * chunks[id][1]) / average);
				scores.set(id, (scores.get(id) ?? 0) + (idf * frequency * (config.k1 + 1)) / denominator);
			}
		}
		const best = new Map<number, number>();
		for (const [id, score] of scores) {
			const doc = chunks[id][0];
			if (score > (best.get(doc) ?? 0)) best.set(doc, score);
		}
		const documents = [...best]
			.sort(([a, first], [b, second]) => second - first || a - b)
			.slice(0, config.top_k)
			.map(([id]) => id);
		return { query: query.id, documents, ms: performance.now() - start };
	});
	check();
	return { rankings, build_ms, index_bytes: Buffer.byteLength(index), index_sha256 };
}

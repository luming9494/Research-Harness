// 读取宿主固定摘要的 BGE 向量，并做可重放的文档级精确检索。
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { file, sha256 } from "../bench/io.ts";
import type { Ranking } from "./bm25.ts";
import { assets, type Dataset } from "./scifact.ts";

const dimensions = 384;
const matrixSchema = Type.Object(
	{
		sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		source_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		rows: Type.Integer({ minimum: 1 }),
		encode_ms: Type.Number({ minimum: 0 }),
		peak_rss_kib: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
const manifestSchema = Type.Object(
	{
		identity: Type.Object(
			{
				version: Type.Literal(1),
				model: Type.Literal("BAAI/bge-small-en-v1.5"),
				revision: Type.Literal("5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"),
				weights_sha256: Type.Literal("828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35"),
				tokenizer_sha256: Type.Literal("d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"),
				dimensions: Type.Literal(dimensions),
				max_tokens: Type.Literal(256),
				encoder: Type.Literal("bge-cls-l2-onnx-cpu-v1"),
				ort: Type.Literal("1.22.1"),
			},
			{ additionalProperties: false },
		),
		split: Type.Union([Type.Literal("development"), Type.Literal("holdout")]),
		documents: matrixSchema,
		queries: matrixSchema,
	},
	{ additionalProperties: false },
);
export interface DenseSource {
	root: string;
	sha: string;
}
export interface DenseIndex {
	documents: Float32Array;
	queries: Float32Array;
	manifest: Static<typeof manifestSchema>;
	manifestSha: string;
	indexSha: string;
	indexBytes: number;
	loadMs: number;
}

// 向量文件按源数据顺序保存 ID，每一行都必须与冻结数据一一对应。
export function decodeMatrix(bytes: Buffer, ids: readonly number[]): Float32Array {
	const recordBytes = 4 + dimensions * 4;
	if (bytes.length !== ids.length * recordBytes) throw new Error("Dense matrix shape mismatch");
	const vectors = new Float32Array(ids.length * dimensions);
	for (const [i, id] of ids.entries()) {
		const offset = i * recordBytes;
		if (bytes.readInt32LE(offset) !== id) throw new Error("Dense matrix row ID mismatch");
		let norm = 0;
		for (let j = 0; j < dimensions; j++) {
			const value = bytes.readFloatLE(offset + 4 + j * 4);
			vectors[i * dimensions + j] = value;
			norm += value * value;
		}
		if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.0002) throw new Error("Invalid normalized dense vector");
	}
	return vectors;
}

export async function loadDense(
	source: DenseSource,
	dataset: Dataset,
	split: "development" | "holdout",
): Promise<DenseIndex> {
	const started = performance.now();
	const manifest = await file(source.root, `${split}.json`);
	if (sha256(manifest) !== source.sha) throw new Error("Dense manifest digest mismatch");
	const decoded: unknown = JSON.parse(manifest.toString());
	const querySource = assets[split === "development" ? "claims_train.jsonl" : "claims_dev.jsonl"];
	if (
		!Check(manifestSchema, decoded) ||
		decoded.split !== split ||
		decoded.documents.source_sha256 !== assets["corpus.jsonl"] ||
		decoded.queries.source_sha256 !== querySource ||
		decoded.documents.rows !== dataset.documents.length ||
		decoded.queries.rows !== dataset.queries.length
	)
		throw new Error("Dense manifest model, dataset or split mismatch");
	const [docs, queries] = await Promise.all([file(source.root, "documents.f32"), file(source.root, `${split}.f32`)]);
	if (sha256(docs) !== decoded.documents.sha256 || sha256(queries) !== decoded.queries.sha256)
		throw new Error("Dense matrix digest mismatch");
	return {
		documents: decodeMatrix(
			docs,
			dataset.documents.map(({ id }) => id),
		),
		queries: decodeMatrix(
			queries,
			dataset.queries.map(({ id }) => id),
		),
		manifest: decoded,
		manifestSha: source.sha,
		indexSha: sha256(JSON.stringify([decoded.identity, decoded.documents.sha256])),
		indexBytes: docs.length,
		loadMs: performance.now() - started,
	};
}

// 候选只调整截断深度，所有余弦分数来自固定的单位向量和明确的并列规则。
export function denseRank(
	index: DenseIndex,
	documentIds: readonly number[],
	queryIds: readonly number[],
	top: number,
	check: () => void,
): Ranking[] {
	return queryIds.map((query, i): Ranking => {
		check();
		const started = performance.now();
		const matches = documentIds.map((id, j): [number, number] => {
			let dot = 0;
			for (let k = 0; k < dimensions; k++)
				dot += index.queries[i * dimensions + k] * index.documents[j * dimensions + k];
			return [id, dot];
		});
		matches.sort(([a, first], [b, second]) => second - first || a - b);
		return { query, documents: matches.slice(0, top).map(([id]) => id), ms: performance.now() - started };
	});
}

// 仅可信宿主读取冻结的 SciFact 语料和人工标注。
import { file, sha256 } from "../bench/io.ts";

export const assets = {
	"corpus.jsonl": "b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62",
	"claims_train.jsonl": "f4c8fa82d8bd0653a9cc8d61a6ea48c25eacea64e90af5dbf390ebb1b74372f0",
	"claims_dev.jsonl": "86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217",
} as const;

export interface Document {
	id: number;
	text: string;
}

export interface Query {
	id: number;
	text: string;
}

export interface Dataset {
	documents: Document[];
	queries: Query[];
	qrels: Map<number, number[]>;
	fingerprint: string;
}

// 原测试集没有公开标注，使用原 train 搜索、原 dev 独立复验。
export async function loadDataset(root: string, split: "development" | "holdout"): Promise<Dataset> {
	const queryFile = split === "development" ? "claims_train.jsonl" : "claims_dev.jsonl";
	const [corpus, claims] = await Promise.all(
		(["corpus.jsonl", queryFile] as const).map(async (name): Promise<Buffer> => {
			const bytes = await file(root, name);
			if (sha256(bytes) !== assets[name]) throw new Error("SciFact asset digest mismatch");
			return bytes;
		}),
	);
	// 固定摘要绑定已审计的源格式；同时检查 ID、引用和文本的关键不变量。
	const documents = corpus
		.toString()
		.trim()
		.split("\n")
		.map((line): Document => {
			const doc = JSON.parse(line) as { doc_id: number; title?: string; abstract?: string[] };
			const body = [doc.title ?? "", ...(doc.abstract ?? [])].join(" ").trim();
			if (!Number.isSafeInteger(doc.doc_id) || !body) throw new Error("Invalid SciFact document");
			return { id: doc.doc_id, text: body };
		});
	const ids = new Set(documents.map(({ id }) => id));
	if (ids.size !== documents.length) throw new Error("Duplicate SciFact document");
	const qrels = new Map<number, number[]>();
	const queries = claims
		.toString()
		.trim()
		.split("\n")
		.map((line): Query => {
			const claim = JSON.parse(line) as { id: number; claim: string; evidence: Record<string, unknown[]> };
			if (!Number.isSafeInteger(claim.id) || qrels.has(claim.id) || !claim.claim?.trim())
				throw new Error("Invalid SciFact query");
			const relevant = Object.entries(claim.evidence)
				.filter(([, annotations]) => annotations.length > 0)
				.map(([id]) => Number(id));
			if (relevant.some((id) => !ids.has(id))) throw new Error("SciFact evidence references an unknown document");
			qrels.set(claim.id, relevant);
			return { id: claim.id, text: claim.claim };
		});
	return {
		documents,
		queries,
		qrels,
		fingerprint: sha256(JSON.stringify([assets["corpus.jsonl"], assets[queryFile]])),
	};
}

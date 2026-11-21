// 离线复核先校验操作者保存的清单摘要，再按冻结标注重算逐查询分数。
import { Type } from "typebox";
import { Check } from "typebox/value";
import { file, sha256 } from "../bench/io.ts";
import { TraceEvidence } from "../bench/trace-evidence.ts";
import type { Ranking } from "./bm25.ts";
import { loadDataset } from "./scifact.ts";
import { score } from "./score.ts";

const manifestSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		case_id: Type.Union([Type.Literal("RAG-CORE-01"), Type.Literal("RAG-LIVE-01")]),
		evidence: Type.Array(
			Type.Object(
				{
					path: Type.String({ minLength: 1 }),
					sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
					bytes: Type.Integer({ minimum: 0 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 128 },
		),
	},
	{ additionalProperties: false },
);

export async function verifyRagArchive(
	root: string,
	data: string,
	expectedSha: string,
): Promise<{ case_id: string; verified_files: number; rescored_runs: number }> {
	const bytes = await file(root, "manifest.json");
	if (sha256(bytes) !== expectedSha) throw new Error("RAG manifest digest mismatch");
	const manifest: unknown = JSON.parse(bytes.toString());
	if (!Check(manifestSchema, manifest)) throw new Error("Invalid RAG manifest");
	const paths = new Set(manifest.evidence.map(({ path }) => path));
	if (paths.size !== manifest.evidence.length || !paths.has("result.json")) throw new Error("Incomplete RAG manifest");
	await new TraceEvidence(root, manifest.evidence).verifyAll();
	// 文件已由操作者固定摘要验证；独立评分器仍校验每个 query 和文档 ID。
	const development = await loadDataset(data, "development");
	const holdout = [...paths].some((path) => path.startsWith("holdout/"))
		? await loadDataset(data, "holdout")
		: undefined;
	const ids = new Set(development.documents.map(({ id }) => id));
	let rescored = 0;
	for (const path of paths) {
		const isHoldout = /^holdout\/(baseline|exp-[1-9][0-9]*)\.json$/.test(path);
		if (!isHoldout && !/^retrieval\/(baseline|exp-[1-9][0-9]*)\/rankings\.json$/.test(path)) continue;
		const proof = JSON.parse((await file(root, path)).toString()) as {
			dataset: string;
			rankings: Ranking[];
			metrics?: object;
			contributions?: object;
		};
		const dataset = isHoldout ? holdout : development;
		if (!dataset || proof.dataset !== dataset.fingerprint) throw new Error("RAG dataset binding mismatch");
		const rescoredProof = score(proof.rankings, dataset.qrels, ids);
		const contributionPath = path.replace(/rankings\.json$/, "contributions.json");
		const contributions: unknown = isHoldout
			? proof.contributions
			: paths.has(contributionPath)
				? JSON.parse((await file(root, contributionPath)).toString())
				: undefined;
		if (
			JSON.stringify(contributions) !== JSON.stringify(rescoredProof.contributions) ||
			(isHoldout && JSON.stringify(proof.metrics) !== JSON.stringify(rescoredProof.metrics))
		)
			throw new Error(`RAG independent rescoring mismatch: ${path}`);
		rescored++;
	}
	return { case_id: manifest.case_id, verified_files: paths.size, rescored_runs: rescored };
}

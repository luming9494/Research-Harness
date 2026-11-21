// 归档复核从冻结构件独立重建索引、排名、指标、交付和双轴判分。
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import type { Grades } from "../bench/grader.ts";
import { file, sha256 } from "../bench/io.ts";
import { TraceEvidence } from "../bench/trace-evidence.ts";
import { configOf, type Ranking, retrieve } from "./bm25.ts";
import { type DenseIndex, loadDense } from "./dense.ts";
import { hybridProtocol, implementationSha, protocol, validateSpec } from "./domain.ts";
import { type CoreObservation, gradeCore, gradeLive } from "./grading.ts";
import {
	denseControl,
	fusionControl,
	hybridConfigOf,
	relevantMetrics,
	retrieveHybrid,
	sparseControl,
} from "./hybrid.ts";
import type { Epoch } from "./live.ts";
import { type Dataset, loadDataset } from "./scifact.ts";
import { score } from "./score.ts";

const manifestSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		case_id: Type.Union([Type.Literal("RAG-CORE-01"), Type.Literal("RAG-LIVE-01"), Type.Literal("RAG-HYBRID-01")]),
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

// 两次 WP-10.1 实机版本共享留存的 BM25、SciFact 和评分实现。
const legacyImplementations = new Set([
	"a1b54be8611531cf7233327de472e26f5ed1c45f56708bc83a0b1fb2fc8eed6c",
	"c97c5f6095a1615d2449a41d67489ad6155c7c99bd9a5424c7b7a93182f7c8af",
]);

interface Receipt {
	config?: unknown;
	fingerprint?: string;
	dataset: string;
	rankings: Ranking[];
	build_ms: number;
	index_bytes: number;
	index_sha256: string;
	metrics?: object;
	contributions?: object;
	relevant?: object;
	peak_rss_kib?: number;
}
interface CaseIdentity {
	id?: string;
	case_id?: string;
	spec: unknown;
	implementation_sha256?: string;
}
interface ArchivedResult extends Grades {
	case_id: string;
	delivery?: unknown;
	development?: unknown;
	task_id: string;
	usage?: {
		requests: number;
		tokens: number | null;
		estimated_cost_usd: number | null;
		failed_or_unconfirmed: number;
	};
}

// 比较规范序列；计时只检查旧回执与旧指标自洽，不比较重放的实测延迟。
function same(actual: unknown, expected: unknown, label: string): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`RAG replay mismatch: ${label}`);
}

// 排名重放忽略重新测量的时间，核对 Query ID、文档顺序及截断长度。
export function verifyRankingReplay(recorded: Ranking[], replayed: Ranking[]): void {
	const ranks = (rows: Ranking[]): [number, number[]][] => rows.map(({ query, documents }) => [query, documents]);
	same(ranks(recorded), ranks(replayed), "query document rankings");
}

export interface ArchiveVerification {
	case_id: string;
	verified_files: number;
	rescored_runs: number;
	replayed_queries: number;
	task_success: Grades["task_success"]["status"];
	harness_correctness: Grades["harness_correctness"]["status"];
}

export async function verifyRagArchive(
	root: string,
	data: string,
	expectedSha: string,
	vectors?: string,
): Promise<ArchiveVerification> {
	const raw = await file(root, "manifest.json");
	if (sha256(raw) !== expectedSha.toLowerCase()) throw new Error("RAG manifest digest mismatch");
	const manifest: unknown = JSON.parse(raw.toString());
	if (!Check(manifestSchema, manifest)) throw new Error("Invalid RAG manifest");
	const paths = manifest.evidence.map(({ path }) => path);
	const store = new TraceEvidence(root, manifest.evidence);
	await store.verifyAll();
	// 任何关键证据缺失都拒绝，不能通过已归档的总结字符串补齐。
	const get = async <T>(path: string): Promise<T> => {
		const found = await store.document<T>(path);
		if (!found) throw new Error(`Missing replay evidence: ${path}`);
		return found.value;
	};
	const test = await get<CaseIdentity>("case.json");
	const result = await get<ArchivedResult>("result.json");
	const core = manifest.case_id === "RAG-CORE-01" ? await get<CoreObservation>("observations.json") : undefined;
	const after = core?.saved ?? (await get<TaskCheckpoint>("checkpoint-after.json"));
	const spec = validateSpec(after.spec);
	const hybrid = spec.task === hybridProtocol;
	if ((manifest.case_id === "RAG-HYBRID-01") !== hybrid) throw new Error("RAG case protocol mismatch");
	same(test.id ?? test.case_id, manifest.case_id, "case id");
	same(result.case_id, manifest.case_id, "result case");
	same(result.task_id, after.taskId, "task id");
	same(test.spec, spec, "approved spec");
	const implementation = after.executor.implementation;
	const current = await implementationSha(hybrid);
	if (
		implementation !== current &&
		(hybrid || typeof implementation !== "string" || !legacyImplementations.has(implementation))
	)
		throw new Error("Unknown retrieval implementation for replay");
	if (test.implementation_sha256) same(test.implementation_sha256, implementation, "case implementation");
	const development = await loadDataset(data, "development");
	same(after.executor.dataset, development.fingerprint, "development assets");
	let dense: DenseIndex | undefined;
	if (hybrid) {
		if (!vectors) throw new Error("Hybrid replay requires the pinned vector cache");
		const proof = await store.artifact("development-embedding.json");
		same(proof?.sha256, spec.embedding_manifest_sha256, "approved embedding manifest");
		same(after.executor.embedding, spec.embedding_manifest_sha256, "ledger embedding manifest");
		dense = await loadDense({ root: vectors, sha: spec.embedding_manifest_sha256 }, development, "development");
		const admission = await get<{ index_sha256: string; index_bytes: number; load_ms: number }>(
			"embedding-admission.json",
		);
		same([admission.index_sha256, admission.index_bytes], [dense.indexSha, dense.indexBytes], "admitted dense index");
		if (!Number.isFinite(admission.load_ms) || admission.load_ms < 0)
			throw new Error("Invalid observed dense load time");
	}
	const docIds = new Set(development.documents.map(({ id }) => id));
	let replayedQueries = 0;
	let rescored = 0;
	const replay = (
		receipt: Receipt,
		dataset: Dataset,
		config: unknown,
		index: DenseIndex | undefined,
	): ReturnType<typeof score> => {
		same(receipt.dataset, dataset.fingerprint, "ranking dataset");
		const fresh = index
			? retrieveHybrid(dataset, index, hybridConfigOf(config), () => {})
			: retrieve(dataset.documents, dataset.queries, configOf(config), () => {});
		verifyRankingReplay(receipt.rankings, fresh.rankings);
		same(receipt.index_sha256, fresh.index_sha256, "index SHA-256");
		same(receipt.index_bytes, fresh.index_bytes, "index size");
		if (!Number.isFinite(receipt.build_ms) || receipt.build_ms < 0)
			throw new Error("Invalid observed index build time");
		replayedQueries += fresh.rankings.length;
		rescored++;
		return score(receipt.rankings, dataset.qrels, docIds);
	};
	const configs = new Map<string, unknown>();
	const parents = new Map<string, string | null>();
	let best: { id: string; ndcg: number; fingerprint: string } | undefined;
	const rankingPaths = new Set<string>();
	for (const run of after.evaluated) {
		if (!/^(baseline|exp-[1-9][0-9]*)$/.test(run.id) || configs.has(run.id))
			throw new Error("Invalid replay candidate ID");
		const dir = `retrieval/${run.id}`;
		same(run.run, `${dir}/rankings.json`, "candidate evidence path");
		rankingPaths.add(run.run);
		const receipt = await get<Receipt>(run.run);
		const proposalPath = `${dir}/proposal.json`;
		const proposal = await get<{ config: unknown; fingerprint: string; parent: string | null }>(proposalPath);
		const config = hybrid ? hybridConfigOf(proposal.config) : configOf(proposal.config);
		same(receipt.config, config, "effective config");
		if (run.id === "baseline" ? proposal.parent !== null : !configs.has(proposal.parent ?? ""))
			throw new Error("Invalid parent experiment lineage");
		configs.set(run.id, config);
		parents.set(run.id, proposal.parent);
		const identity = {
			dataset: development.fingerprint,
			implementation,
			...(dense && { embedding: dense.manifestSha }),
		};
		const fingerprint = sha256(JSON.stringify([hybrid ? hybridProtocol : protocol, identity, config]));
		same(
			[run.fingerprint, receipt.fingerprint, proposal.fingerprint],
			[fingerprint, fingerprint, fingerprint],
			"candidate fingerprint",
		);
		const scored = replay(receipt, development, config, dense);
		same(await get(`${dir}/contributions.json`), scored.contributions, "query contributions");
		const receiptHash = (await store.artifact(run.run))?.sha256;
		const proposalHash = (await store.artifact(proposalPath))?.sha256;
		const observed = {
			...scored.metrics,
			...(hybrid && {
				relevant: relevantMetrics(scored.contributions, development.qrels),
				peak_rss_kib: receipt.peak_rss_kib,
			}),
			build_ms: receipt.build_ms,
			index_bytes: receipt.index_bytes,
			index_sha256: receipt.index_sha256,
			receipt_sha256: receiptHash,
			...(run.validation.proposal_sha256 !== undefined && { proposal_sha256: proposalHash }),
		};
		same(run.validation, observed, "independent aggregate metrics");
		if (!best || scored.metrics.ndcg10 > best.ndcg) best = { id: run.id, ndcg: scored.metrics.ndcg10, fingerprint };
	}
	if (!best || !after.delivered || !after.summary.delivery || !configs.has("baseline"))
		throw new Error("Missing verified final delivery");
	if (hybrid) {
		same(
			[configs.get("baseline"), configs.get("exp-1"), configs.get("exp-2")],
			[sparseControl, denseControl, fusionControl],
			"fixed strategy controls",
		);
	}
	const published = await get<typeof after.summary.delivery>("retrieval/delivery.json");
	same(published, after.summary.delivery, "published manifest");
	same(
		[
			published.best_id,
			published.fingerprint,
			published.dataset,
			published.implementation,
			published.embedding,
			published.protocol,
		],
		[
			best.id,
			best.fingerprint,
			development.fingerprint,
			implementation,
			dense?.manifestSha,
			hybrid ? hybridProtocol : protocol,
		],
		"best delivery identity",
	);
	const required = [`retrieval/${best.id}/rankings.json`, `retrieval/${best.id}/contributions.json`];
	if (after.evaluated.find(({ id }) => id === best?.id)?.validation.proposal_sha256 !== undefined)
		required.push(`retrieval/${best.id}/proposal.json`);
	same(
		published.evidence,
		await Promise.all(
			required.map(async (path): Promise<object> => {
				const proof = await store.artifact(path);
				if (!proof) throw new Error("Delivery references missing artifact");
				const { locator: _locator, ...digest } = proof;
				return digest;
			}),
		),
		"delivery evidence",
	);
	let grades: Grades;
	if (core) grades = gradeCore(core);
	else {
		same(result.delivery, published, "result delivery");
		same(result.development, after.evaluated, "result evaluated runs");
		for (const op of after.commands) {
			const path = `commands/${op.id}.json`;
			if (!("recordSha256" in op)) throw new Error("Unconfirmed retrieval operation");
			same((await store.artifact(path))?.sha256, op.recordSha256, "operation hash");
			const receipt = await get<Record<string, unknown>>(path);
			same(
				[receipt.id, receipt.runId, receipt.fingerprint, receipt.status, receipt.elapsedMs],
				[op.id, op.runId, op.fingerprint, op.status, op.elapsedMs],
				"operation receipt",
			);
		}
		const holdout = await loadDataset(data, "holdout");
		const holdoutHash = hybrid ? (await store.artifact("holdout-embedding.json"))?.sha256 : undefined;
		if (hybrid && !holdoutHash) throw new Error("Missing holdout embedding provenance");
		const holdoutIndex =
			holdoutHash && vectors ? await loadDense({ root: vectors, sha: holdoutHash }, holdout, "holdout") : undefined;
		if (holdoutIndex) same(holdoutIndex.indexSha, dense?.indexSha, "shared document index");
		for (const id of new Set(["baseline", ...(hybrid ? ["exp-1", "exp-2"] : []), best.id])) {
			const path = `holdout/${id}.json`;
			rankingPaths.add(path);
			const receipt = await get<Receipt>(path);
			const scored = replay(receipt, holdout, configs.get(id), holdoutIndex);
			same(receipt.metrics, scored.metrics, "holdout metrics");
			same(receipt.contributions, scored.contributions, "holdout contributions");
			if (hybrid)
				same(
					receipt.relevant,
					relevantMetrics(scored.contributions, holdout.qrels),
					"holdout positive-only metrics",
				);
		}
		const candidates = after.rows.filter(({ status }) => status === "evaluated").slice(hybrid ? 2 : 0);
		const epochs = await get<Epoch[]>("pi-events.json");
		// 独立重算已结算的计算与模型用量，保留真实的计时和费率观测。
		if (hybrid) {
			const usage = epochs.flatMap((epoch) => epoch.usage);
			const requests = epochs.reduce((sum, epoch) => sum + epoch.admitted, 0);
			const total = (key: "tokens" | "cost"): number | null =>
				usage.length === requests && usage.every((entry) => entry[key] !== null)
					? usage.reduce((sum, entry) => sum + (entry[key] ?? 0), 0)
					: null;
			same(
				result.usage,
				{
					requests,
					tokens: total("tokens"),
					estimated_cost_usd: total("cost"),
					failed_or_unconfirmed: requests - usage.filter(({ tokens }) => tokens !== null).length,
				},
				"model usage",
			);
			const tokens = total("tokens");
			if (tokens !== null) same(after.summary.budget.tokens_actual, tokens, "ledger tokens");
			const milliseconds = after.commands.reduce((sum, op) => sum + ("elapsedMs" in op ? op.elapsedMs : 0), 0);
			if (Math.abs(milliseconds / 1000 - after.summary.budget.compute_process_seconds) > 1e-6)
				throw new Error("RAG replay mismatch: compute settlement");
		}
		grades = gradeLive({
			before: await get<TaskCheckpoint>("checkpoint-before.json"),
			after,
			epochs,
			secondParent: parents.get(candidates[1]?.id) ?? null,
			deliveryVerified: true,
			holdoutVerified: true,
			hybrid,
			paths,
		});
	}
	if (paths.some((path) => /^(holdout\/|retrieval\/[^/]+\/rankings\.json$)/.test(path) && !rankingPaths.has(path)))
		throw new Error("Unbound retrieval ranking file");
	// 旧归档的路径列表可以不同，原分数、每个检查状态和权重都必须吻合。
	for (const key of ["task_success", "harness_correctness"] as const) {
		const project = ({ status, score, checks }: Grades[typeof key]): object => ({
			status,
			score,
			checks: checks.map(({ id, weight, status }) => ({ id, weight, status })),
		});
		same(project(result[key]), project(grades[key]), key);
	}
	return {
		case_id: manifest.case_id,
		verified_files: paths.length,
		rescored_runs: rescored,
		replayed_queries: replayedQueries,
		task_success: grades.task_success.status,
		harness_correctness: grades.harness_correctness.status,
	};
}

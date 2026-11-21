// 将检索执行和独立评分接入现有 TaskController 与 Pi Durable 账本。
import { randomUUID } from "node:crypto";
import { link, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	type ArtifactManifest,
	type Candidate,
	type DurableExperimentAdapter,
	type ExperimentDomain,
	ExperimentFailure,
	type RunResult,
	type TrainingReservation,
	type WorkerOperation,
} from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import { BudgetStop } from "../../packages/coding-agent/src/axiom/execution/task-budget.ts";
import { digest, file, json, sha256 } from "../bench/io.ts";
import { baseline, configOf, retrieve, searchSpace } from "./bm25.ts";
import { loadDataset } from "./scifact.ts";
import { score } from "./score.ts";

export const protocol = "scifact-bm25-v1";
export const taskSchema = Type.Object(
	{
		version: Type.Literal(1),
		task: Type.Literal(protocol),
		goal: Type.String({ minLength: 1, maxLength: 512 }),
		max_revisions: Type.Integer({ minimum: 0, maximum: 2 }),
		search_space: searchSpace,
		budget: Type.Object(
			{
				max_experiments: Type.Integer({ minimum: 1, maximum: 12 }),
				wall_seconds: Type.Integer({ minimum: 1, maximum: 1800 }),
				max_tokens: Type.Integer({ minimum: 1, maximum: 250000 }),
				compute_process_seconds: Type.Number({ exclusiveMinimum: 0, maximum: 300 }),
				training_steps: Type.Literal(0),
				cpu_threads: Type.Literal(1),
				device: Type.Literal("cpu"),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type RagTaskSpec = Static<typeof taskSchema>;

// 审批中的 search_space 固定绑定协议默认配置，允许范围由同一版本的 Schema 定义。
export function validateSpec(input: unknown): RagTaskSpec {
	if (!Check(taskSchema, input) || JSON.stringify(configOf(input.search_space)) !== JSON.stringify(baseline))
		throw new Error("Invalid approved SciFact TaskSpec");
	return input;
}

const fraction = Type.Number({ minimum: 0, maximum: 1 });
const nonnegative = Type.Number({ minimum: 0 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const validationSchema = Type.Object(
	{
		recall5: fraction,
		recall10: fraction,
		ndcg10: fraction,
		mrr10: fraction,
		queries: Type.Integer({ minimum: 1 }),
		without_relevance: Type.Integer({ minimum: 0 }),
		mean_ms: nonnegative,
		p95_ms: nonnegative,
		build_ms: nonnegative,
		index_bytes: Type.Integer({ minimum: 1 }),
		index_sha256: hash,
		receipt_sha256: hash,
		proposal_sha256: hash,
	},
	{ additionalProperties: false },
);
const receiptSchema = Type.Object(
	{
		dataset: hash,
		fingerprint: hash,
		config: searchSpace,
		rankings: Type.Array(
			Type.Object(
				{
					query: Type.Integer(),
					documents: Type.Array(Type.Integer(), { maxItems: 30 }),
					ms: nonnegative,
				},
				{ additionalProperties: false },
			),
		),
		build_ms: nonnegative,
		index_bytes: Type.Integer({ minimum: 1 }),
		index_sha256: hash,
	},
	{ additionalProperties: false },
);

// 固定检索器、评分器和输入解析器的源码身份，版本内改变实现也会拒绝恢复。
export async function implementationSha(): Promise<string> {
	const files = ["bm25.ts", "score.ts", "scifact.ts", "domain.ts"];
	return sha256(
		JSON.stringify(
			await Promise.all(
				files.map(
					async (name): Promise<string> => sha256(await readFile(fileURLToPath(new URL(name, import.meta.url)))),
				),
			),
		),
	);
}

export function ragDomain(dataRoot: string): ExperimentDomain {
	return {
		id: protocol,
		version: 1,
		validateSpec,
		acceptsLegacy: (): boolean => false,
		async open({ root, budget, saved, commandCount = 0 }): Promise<DurableExperimentAdapter> {
			const [data, implementation] = await Promise.all([loadDataset(dataRoot, "development"), implementationSha()]);
			const identity = { dataset: data.fingerprint, implementation };
			if (saved && (saved.dataset !== identity.dataset || saved.implementation !== identity.implementation))
				throw new ExperimentFailure("evidence_integrity", "Retrieval dataset or implementation changed");
			const documentIds = new Set(data.documents.map(({ id }) => id));
			let sequence = commandCount;
			const fingerprint = (config: ReturnType<typeof configOf>): string =>
				sha256(JSON.stringify([protocol, identity, config]));
			const verified = new Set<string>();
			const verifyRun = async (run: RunResult): Promise<void> => {
				const path = `retrieval/${run.id}/rankings.json`;
				if (!/^(baseline|exp-[1-9][0-9]*)$/.test(run.id) || run.run !== path)
					throw new Error("Invalid retrieval receipt path");
				const bytes = await file(root, path);
				const validation = adapter.evaluation.validate(run.validation);
				const receiptHash = sha256(bytes);
				if (validation.receipt_sha256 !== receiptHash) throw new Error("Ranking receipt digest mismatch");
				const proposalHash = (await digest(root, `retrieval/${run.id}/proposal.json`)).sha256;
				if (validation.proposal_sha256 !== proposalHash) throw new Error("Retrieval proposal digest mismatch");
				const receipt: unknown = JSON.parse(bytes.toString());
				if (
					!Check(receiptSchema, receipt) ||
					receipt.dataset !== identity.dataset ||
					receipt.fingerprint !== run.fingerprint ||
					fingerprint(configOf(receipt.config)) !== run.fingerprint ||
					receipt.rankings.some(({ documents }) => documents.length > receipt.config.top_k)
				)
					throw new Error("Ranking receipt identity mismatch");
				const { rankings, build_ms, index_bytes, index_sha256 } = receipt;
				const independent = score(rankings, data.qrels, documentIds);
				const contributions: unknown = JSON.parse(
					(await file(root, `retrieval/${run.id}/contributions.json`)).toString(),
				);
				if (
					JSON.stringify(contributions) !== JSON.stringify(independent.contributions) ||
					JSON.stringify(validation) !==
						JSON.stringify({
							...independent.metrics,
							build_ms,
							index_bytes,
							index_sha256,
							receipt_sha256: receiptHash,
							proposal_sha256: proposalHash,
						})
				)
					throw new Error("Independent retrieval metrics do not match");
				verified.add(run.id);
			};
			const delivery = async (best: RunResult): Promise<ArtifactManifest> => {
				await verifyRun(best);
				return {
					best_id: best.id,
					protocol,
					fingerprint: best.fingerprint,
					...identity,
					evidence: await Promise.all(
						[best.run, `retrieval/${best.id}/contributions.json`, `retrieval/${best.id}/proposal.json`].map(
							(path) => digest(root, path),
						),
					),
				};
			};
			const adapter: DurableExperimentAdapter = {
				original: "BM25 v1",
				config: JSON.stringify(baseline),
				evaluation: {
					objectives: [{ metric: "ndcg10", direction: "maximize", min: 0, max: 1, target: null }],
					validate(raw): Static<typeof validationSchema> {
						if (!Check(validationSchema, raw))
							throw new ExperimentFailure("evidence_integrity", "Invalid SciFact evaluation metrics");
						return raw;
					},
				},
				reportNotes: [
					"BM25 retrieval, development nDCG@10",
					"Retrieval consumes computation time, zero training steps",
				],
				trainingSteps: (): number => 0,
				async prepare(id, content, rationale, signal, parameters): Promise<Candidate> {
					signal.throwIfAborted();
					let config: ReturnType<typeof configOf>;
					try {
						if (id !== "baseline" && !verified.has(content))
							throw new Error("Parent experiment must reference previously verified development feedback");
						config = configOf(id === "baseline" ? baseline : parameters);
					} catch (error) {
						throw new ExperimentFailure(
							"invalid_candidate",
							error instanceof Error ? error.message : "Invalid proposal",
						);
					}
					await json(root, `retrieval/${id}/proposal.json`, {
						config,
						fingerprint: fingerprint(config),
						parent: id === "baseline" ? null : content,
						rationale,
					});
					return { id, content, rationale, fingerprint: fingerprint(config), config: JSON.stringify(config) };
				},
				async run(candidate, reservation: TrainingReservation, signal): Promise<RunResult> {
					if (!adapter.recordCommand) throw new Error("SciFact requires a Durable task ledger");
					const config = configOf(JSON.parse(candidate.config ?? ""));
					const op = {
						id: ++sequence,
						runId: candidate.id,
						fingerprint: candidate.fingerprint,
						script: "bm25_retrieval",
						timeoutMs: budget.processTimeout(),
						reservation,
					};
					// 提交操作和预算后才构建索引。进程突然中断时 pending 由控制器标记待核对。
					await adapter.recordCommand({ ...op, status: "pending" });
					const started = performance.now();
					const check = (): void => {
						signal.throwIfAborted();
						if (performance.now() - started >= op.timeoutMs)
							throw new BudgetStop(
								budget.remainingWallMs <= 0 ? "wall_budget_exhausted" : "compute_budget_exhausted",
							);
					};
					const receiptPath = `retrieval/${candidate.id}/rankings.json`;
					let run: RunResult | undefined;
					let failure: unknown;
					try {
						const { rankings, ...index } = retrieve(data.documents, data.queries, config, check);
						const result = score(rankings, data.qrels, documentIds);
						check();
						await json(root, receiptPath, {
							dataset: identity.dataset,
							fingerprint: candidate.fingerprint,
							config,
							rankings,
							...index,
						});
						await json(root, `retrieval/${candidate.id}/contributions.json`, result.contributions);
						run = {
							id: candidate.id,
							fingerprint: candidate.fingerprint,
							run: receiptPath,
							validation: {
								...result.metrics,
								...index,
								receipt_sha256: (await digest(root, receiptPath)).sha256,
								proposal_sha256: (await digest(root, `retrieval/${candidate.id}/proposal.json`)).sha256,
							},
						};
						await verifyRun(run);
					} catch (error) {
						run = undefined;
						failure = error;
					}
					const elapsedMs = performance.now() - started;
					budget.computeMs += elapsedMs;
					const receipt = `commands/${op.id}.json`;
					const completed = {
						...op,
						status: run ? "completed" : "failed",
						elapsedMs,
						exitCode: run ? 0 : 1,
						stopped: null,
						ranking_sha256: run?.validation.receipt_sha256,
					} as const;
					await json(root, receipt, completed);
					await adapter.recordCommand({ ...completed, recordSha256: (await digest(root, receipt)).sha256 });
					if (!run) throw failure;
					return run;
				},
				verifyEvaluated: verifyRun,
				async deliver(best): Promise<ArtifactManifest> {
					const manifest = await delivery(best);
					const pending = `retrieval/.delivery-${randomUUID()}.json`;
					const published = "retrieval/delivery.json";
					await json(root, pending, manifest);
					// 同一文件系统上的硬链接原子公开完整清单，不覆盖既有交付。
					try {
						await link(join(root, pending), join(root, published));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						await adapter.verifyDelivery(best, manifest);
					} finally {
						await unlink(join(root, pending));
					}
					await adapter.recordPublishedBest?.();
					return manifest;
				},
				checkpoint: () => identity,
				async verifyCommand(op: Extract<WorkerOperation, { recordSha256: string }>): Promise<void> {
					if ((await digest(root, `commands/${op.id}.json`)).sha256 !== op.recordSha256)
						throw new Error("Retrieval operation receipt changed");
				},
				async verifyDelivery(best, manifest): Promise<void> {
					const expected = JSON.stringify(await delivery(best));
					if (
						JSON.stringify(manifest) !== expected ||
						JSON.stringify(JSON.parse((await file(root, "retrieval/delivery.json")).toString())) !== expected
					)
						throw new Error("Retrieval delivery evidence changed");
				},
				isReadOnly: (): boolean => false,
			};
			return adapter;
		},
	};
}

// AXIOM-Bench 的检索 Case 读取 Durable 账本并独立复核证据。
import { mkdir, mkdtemp } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	type TaskCheckpoint,
	TaskController,
} from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { digest, file, json, save, sha256 } from "../bench/io.ts";
import { openExperimentLedger } from "../durable/experiment-ledger.ts";
import { baseline, configOf, retrieve } from "./bm25.ts";
import { type DenseSource, loadDense } from "./dense.ts";
import { hybridProtocol, implementationSha, protocol, type RagTaskSpec, ragDomain } from "./domain.ts";
import { gradeLive } from "./grading.ts";
import { hybridConfigOf, relevantMetrics, retrieveHybrid, sparseControl } from "./hybrid.ts";
import { drivePi, type Epoch } from "./live.ts";
import { encoderSettings, prepareHoldout } from "./prepare.ts";
import { assets, loadDataset } from "./scifact.ts";
import { score } from "./score.ts";
import { saveRetrievalTrace } from "./trace.ts";

export const taskSpec: RagTaskSpec = {
	version: 1,
	task: protocol,
	goal: "Improve development nDCG@10 on frozen SciFact and compare retrieval quality, latency and index size",
	max_revisions: 2,
	search_space: baseline,
	budget: {
		max_experiments: 3,
		wall_seconds: 360,
		max_tokens: 120_000,
		compute_process_seconds: 150,
		training_steps: 0,
		cpu_threads: 1,
		device: "cpu",
	},
};

// 验收者从持锁读取的真实状态取证，日志和模型文本不当作权威状态。
export async function checkpoint(repo: string, id: string): Promise<TaskCheckpoint> {
	const ledger = await openExperimentLedger(join(repo, "private", id));
	try {
		const state = await ledger.load();
		if (!state || state.taskId !== id) throw new Error("Missing RAG task checkpoint");
		return state;
	} finally {
		await ledger.close();
	}
}

export async function runLiveCase(
	repo: string,
	dataRoot: string,
	out: string,
	model: string,
	embedding?: DenseSource,
	external?: AbortSignal,
): Promise<string> {
	const data = resolve(dataRoot);
	if (embedding) encoderSettings();
	const spec: RagTaskSpec = embedding
		? {
				...taskSpec,
				task: hybridProtocol,
				version: 2,
				search_space: sparseControl,
				embedding_manifest_sha256: embedding.sha,
				budget: { ...taskSpec.budget, max_experiments: 5, wall_seconds: 600, compute_process_seconds: 280 },
			}
		: taskSpec;
	const caseId = embedding ? "RAG-HYBRID-01" : "RAG-LIVE-01";
	await mkdir(out, { recursive: true });
	const root = await mkdtemp(join(out, "rag-live-"));
	const started_at = new Date().toISOString();
	const paths: string[] = [];
	const persist = async (path: string, value: unknown): Promise<void> => {
		await json(root, path, value);
		paths.push(path);
	};
	const deadline = AbortSignal.timeout(spec.budget.wall_seconds * 1000);
	const signal = external ? AbortSignal.any([external, deadline]) : deadline;
	await persist("case.json", {
		id: caseId,
		version: spec.version,
		mode: "real_pi",
		model,
		spec,
		assets,
		node: process.version,
		platform: process.platform,
		implementation_sha256: await implementationSha(!!embedding),
	});
	const epochs: Epoch[] = [];
	let before: TaskCheckpoint | undefined;
	let after: TaskCheckpoint | undefined;
	let error: string | null = null;
	let holdoutVerified = false;
	let deliveryVerified = false;
	try {
		if (embedding) {
			const manifest = await file(embedding.root, "development.json");
			if (sha256(manifest) !== embedding.sha) throw new Error("Unapproved development embedding receipt");
			const warmed = await loadDense(embedding, await loadDataset(data, "development"), "development");
			await save(root, "development-embedding.json", manifest);
			paths.push("development-embedding.json");
			// 入场验证属于共享准备，记录耗时但不重复计入候选计算。
			await persist("embedding-admission.json", {
				index_sha256: warmed.indexSha,
				index_bytes: warmed.indexBytes,
				load_ms: warmed.loadMs,
				peak_rss_kib: process.resourceUsage().maxRSS,
			});
		}
		const first = await drivePi(repo, data, spec, model, signal, undefined, embedding);
		epochs.push(first);
		// 出现启动或执行失败时也尽量保留原任务账本和预算。
		if (first.task) {
			before = await checkpoint(repo, first.task);
			await persist("checkpoint-before.json", before);
		}
		if (!first.task || !first.interrupted || first.error)
			throw new Error(first.error ?? "First candidate did not commit");
		const second = await drivePi(repo, data, spec, model, signal, first.task, embedding);
		epochs.push(second);
		after = await checkpoint(repo, first.task);
		await persist("checkpoint-after.json", after);
		if (second.error) throw new Error(second.error);
		const task = await TaskController.resume(
			repo,
			process.execPath,
			first.task,
			openExperimentLedger,
			() => {},
			ragDomain(data, embedding),
		);
		try {
			deliveryVerified = task.stopped && task.snapshot().delivery !== undefined;
		} finally {
			await task.closeLedger();
		}
		if (!deliveryVerified || !after.summary.delivery) throw new Error("No independently verified delivery");
		const taskRoot = join(repo, "private", first.task);
		for (const run of after.evaluated) {
			// 把开发集逐查询证据复制到评测目录，不暴露给任一 Pi Session。
			for (const source of [
				run.run,
				`retrieval/${run.id}/contributions.json`,
				`retrieval/${run.id}/proposal.json`,
			]) {
				await save(root, source, await file(taskRoot, source));
				paths.push(source);
			}
		}
		for (const source of [
			"events.jsonl",
			"retrieval/delivery.json",
			...after.commands.map(({ id }) => `commands/${id}.json`),
		]) {
			await save(root, source, await file(taskRoot, source));
			paths.push(source);
		}
		// 留出打分在 Pi 退出和交付清单核验之后执行，不反向影响选优。
		const holdout = await loadDataset(data, "holdout");
		const holdoutSource = embedding && (await prepareHoldout(repo, data, embedding.root, signal));
		const dense = holdoutSource && (await loadDense(holdoutSource, holdout, "holdout"));
		if (holdoutSource) {
			await save(root, "holdout-embedding.json", await file(holdoutSource.root, "holdout.json"));
			paths.push("holdout-embedding.json");
		}
		const ids = new Set(holdout.documents.map(({ id }) => id));
		for (const id of new Set([
			"baseline",
			...(embedding ? ["exp-1", "exp-2"] : []),
			after.summary.delivery.best_id,
		])) {
			const proposal = JSON.parse((await file(root, `retrieval/${id}/proposal.json`)).toString()) as {
				config: unknown;
			};
			const started = performance.now();
			const check = (): void => signal.throwIfAborted();
			const { rankings, ...index } = dense
				? retrieveHybrid(holdout, dense, hybridConfigOf(proposal.config), check)
				: retrieve(holdout.documents, holdout.queries, configOf(proposal.config), check);
			const scored = score(rankings, holdout.qrels, ids);
			await persist(`holdout/${id}.json`, {
				dataset: holdout.fingerprint,
				rankings,
				...index,
				...scored,
				...(dense && {
					relevant: relevantMetrics(scored.contributions, holdout.qrels),
					peak_rss_kib: process.resourceUsage().maxRSS,
					compute_ms: performance.now() - started,
				}),
			});
		}
		holdoutVerified = true;
	} catch (problem) {
		error = problem instanceof Error ? problem.message : "Retrieval benchmark failed";
	}
	await persist("pi-events.json", epochs);
	// 根据实际账本挑出自主候选，固定对照只作为实验基准。
	const candidates = (after?.rows.filter(({ status }) => status === "evaluated") ?? []).slice(embedding ? 2 : 0);
	const proposalPath = candidates[1] ? `retrieval/${candidates[1].id}/proposal.json` : "";
	const secondParent = paths.includes(proposalPath)
		? (JSON.parse((await file(root, proposalPath)).toString()) as { parent: string }).parent
		: null;
	const grades = gradeLive({
		before,
		after,
		epochs,
		secondParent,
		deliveryVerified,
		holdoutVerified,
		paths,
		hybrid: !!embedding,
	});
	const beforeBudget = before?.summary.budget;
	const afterBudget = after?.summary.budget;
	const usage = epochs.flatMap((epoch) => epoch.usage);
	const requests = epochs.reduce((sum, epoch) => sum + epoch.admitted, 0);
	const total = (key: "cost" | "tokens"): number | null =>
		requests && requests === usage.length && usage.every((entry) => entry[key] !== null)
			? usage.reduce((sum, entry) => sum + (entry[key] ?? 0), 0)
			: null;
	const traceRun = {
		case_id: caseId,
		run_id: basename(root),
		status: error ? "failed" : "completed",
		started_at,
	};
	// 派生轨迹若失败，保留原评分和证据，单独报告派生错误。
	let trace: string[] | null = null;
	try {
		trace = await saveRetrievalTrace(
			root,
			traceRun,
			await Promise.all(paths.map((path) => digest(root, path))),
			grades,
		);
		paths.push(...trace);
	} catch {
		trace = null;
	}
	const result = {
		...traceRun,
		error,
		...grades,
		trace,
		trace_derivation_error: trace ? null : "trace_derivation_failed",
		task_id: after?.taskId ?? before?.taskId ?? epochs[0]?.task ?? null,
		usage: {
			requests,
			tokens: total("tokens"),
			estimated_cost_usd: total("cost"),
			failed_or_unconfirmed: requests - usage.filter(({ tokens }) => tokens !== null).length,
		},
		budget: afterBudget ?? beforeBudget ?? null,
		development: after?.evaluated ?? [],
		holdout_verified: holdoutVerified,
		delivery: after?.summary.delivery ?? null,
	};
	await persist("result.json", result);
	await save(
		root,
		"report.md",
		`# ${result.case_id}\n\n${result.run_id}\n\nTask Success ${grades.task_success.status}\n\nHarness Correctness ${grades.harness_correctness.status}\n\n${error ?? "See result.json for metrics and manifest.json for proof digests."}\n`,
	);
	paths.push("report.md");
	await json(root, "manifest.json", {
		schema_version: 1,
		case_id: result.case_id,
		evidence: await Promise.all(paths.map((path) => digest(root, path))),
	});
	return root;
}

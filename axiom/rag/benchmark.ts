// AXIOM-Bench 的检索 Case 读取 Durable 账本并独立复核证据。
import { mkdir, mkdtemp } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	type TaskCheckpoint,
	TaskController,
} from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { scoreAxis } from "../bench/grader.ts";
import { digest, file, json, save } from "../bench/io.ts";
import { openExperimentLedger } from "../durable/experiment-ledger.ts";
import { baseline, configOf, retrieve } from "./bm25.ts";
import { implementationSha, protocol, type RagTaskSpec, ragDomain } from "./domain.ts";
import { drivePi, type Epoch } from "./live.ts";
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

export async function runLiveCase(repo: string, dataRoot: string, out: string, model: string): Promise<string> {
	const data = resolve(dataRoot);
	await mkdir(out, { recursive: true });
	const root = await mkdtemp(join(out, "rag-live-"));
	const started_at = new Date().toISOString();
	const paths: string[] = [];
	const persist = async (path: string, value: unknown): Promise<void> => {
		await json(root, path, value);
		paths.push(path);
	};
	const signal = AbortSignal.timeout(taskSpec.budget.wall_seconds * 1000);
	await persist("case.json", {
		id: "RAG-LIVE-01",
		version: 1,
		mode: "real_pi",
		model,
		spec: taskSpec,
		assets,
		node: process.version,
		platform: process.platform,
		implementation_sha256: await implementationSha(),
	});
	const epochs: Epoch[] = [];
	let before: TaskCheckpoint | undefined;
	let after: TaskCheckpoint | undefined;
	let error: string | null = null;
	let holdoutVerified = false;
	let deliveryVerified = false;
	try {
		const first = await drivePi(repo, data, taskSpec, model, signal);
		epochs.push(first);
		if (!first.task || !first.interrupted || first.error)
			throw new Error(first.error ?? "First candidate did not commit");
		before = await checkpoint(repo, first.task);
		await persist("checkpoint-before.json", before);
		const second = await drivePi(repo, data, taskSpec, model, signal, first.task);
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
			ragDomain(data),
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
		const ids = new Set(holdout.documents.map(({ id }) => id));
		for (const id of new Set(["baseline", after.summary.delivery.best_id])) {
			const proposal = JSON.parse((await file(root, `retrieval/${id}/proposal.json`)).toString()) as {
				config: unknown;
			};
			const { rankings, ...index } = retrieve(holdout.documents, holdout.queries, configOf(proposal.config), () =>
				signal.throwIfAborted(),
			);
			await persist(`holdout/${id}.json`, {
				dataset: holdout.fingerprint,
				rankings,
				...index,
				...score(rankings, holdout.qrels, ids),
			});
		}
		holdoutVerified = true;
	} catch (problem) {
		error = problem instanceof Error ? problem.message : "Retrieval benchmark failed";
	}
	await persist("pi-events.json", epochs);
	const operations = after?.commands ?? [];
	const launches = operations.filter(({ status }) => status === "completed");
	const candidates = after?.rows.filter(({ status }) => status === "evaluated") ?? [];
	const beforeBudget = before?.summary.budget;
	const afterBudget = after?.summary.budget;
	const second = epochs[1];
	const parentInspected = second?.tools.some(
		({ tool, event, request }) =>
			tool === "axiom_rag_inspect" &&
			event === "tool_execution_end" &&
			second.tools.some((next) => next.tool === "axiom_rag_candidate" && next.request > request),
	);
	const secondParent =
		candidates.length >= 2 && paths.includes(`retrieval/${candidates[1].id}/proposal.json`)
			? (
					JSON.parse((await file(root, `retrieval/${candidates[1].id}/proposal.json`)).toString()) as {
						parent: string;
					}
				).parent
			: null;
	const grades = {
		task_success: scoreAxis([{ id: "complete_feedback_and_holdout", weight: 1 }], {
			complete_feedback_and_holdout: {
				valid:
					candidates.length >= 2 &&
					!!parentInspected &&
					secondParent === candidates[0].id &&
					deliveryVerified &&
					holdoutVerified,
				evidence: paths.filter((path) => /^(checkpoint|pi-events|holdout)/.test(path)),
			},
		}),
		harness_correctness: scoreAxis(
			[
				{ id: "approved_recovery_and_no_duplicate_execution", weight: 1 },
				{ id: "usage_and_compute_budget", weight: 1 },
				{ id: "approved_tools_only", weight: 1 },
			],
			{
				...(before &&
					after && {
						approved_recovery_and_no_duplicate_execution: {
							valid:
								epochs[0].interrupted &&
								second?.task === before.taskId &&
								epochs[0].session !== second?.session &&
								before.taskId === after.taskId &&
								before.evaluated.length === 2 &&
								before.deadline === after.deadline &&
								JSON.stringify(before.approval) === JSON.stringify(after.approval) &&
								JSON.stringify(before.spec) === JSON.stringify(after.spec) &&
								JSON.stringify(operations.slice(0, before.commands.length)) ===
									JSON.stringify(before.commands) &&
								JSON.stringify(after.evaluated.slice(0, before.evaluated.length)) ===
									JSON.stringify(before.evaluated) &&
								launches.length === new Set(launches.map(({ fingerprint }) => fingerprint)).size,
							evidence: ["checkpoint-before.json", "checkpoint-after.json", "pi-events.json"],
						},
						usage_and_compute_budget: {
							valid:
								!!beforeBudget &&
								!!afterBudget &&
								afterBudget.training_steps_reserved === 0 &&
								afterBudget.experiments === launches.length - 1 &&
								afterBudget.experiments <= before.spec.budget.max_experiments &&
								afterBudget.compute_process_seconds >= beforeBudget.compute_process_seconds &&
								afterBudget.compute_process_seconds <= before.spec.budget.compute_process_seconds &&
								afterBudget.model_requests === epochs.reduce((sum, epoch) => sum + epoch.admitted, 0),
							evidence: ["checkpoint-before.json", "checkpoint-after.json", "pi-events.json"],
						},
					}),
				...(epochs.some(({ tools }) => tools.length > 0) && {
					approved_tools_only: {
						valid: epochs.every(({ tools }) =>
							tools.every(({ tool }) => /^axiom_rag_(inspect|baseline|candidate|finish)$/.test(tool)),
						),
						evidence: ["pi-events.json"],
					},
				}),
			},
		),
	};
	const usage = epochs.flatMap((epoch) => epoch.usage);
	const requests = epochs.reduce((sum, epoch) => sum + epoch.admitted, 0);
	const total = (key: "cost" | "tokens"): number | null =>
		requests && requests === usage.length && usage.every((entry) => entry[key] !== null)
			? usage.reduce((sum, entry) => sum + (entry[key] ?? 0), 0)
			: null;
	const traceRun = {
		case_id: "RAG-LIVE-01",
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
		task_id: after?.taskId ?? before?.taskId ?? null,
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

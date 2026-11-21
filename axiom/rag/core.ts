// 确定性 Case 对真实 SciFact 运行，不发出模型请求。
import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { digest, file, json, save } from "../bench/io.ts";
import { openExperimentLedger } from "../durable/experiment-ledger.ts";
import { checkpoint, taskSpec } from "./benchmark.ts";
import { baseline } from "./bm25.ts";
import { ragDomain } from "./domain.ts";
import { type CoreObservation, gradeCore } from "./grading.ts";
import { saveRetrievalTrace } from "./trace.ts";

export async function runCoreCase(repo: string, data: string, out: string): Promise<string> {
	const started_at = new Date().toISOString();
	await mkdir(out, { recursive: true });
	const root = await mkdtemp(join(out, "rag-core-"));
	const domain = ragDomain(resolve(data));
	const spec = {
		...taskSpec,
		budget: { ...taskSpec.budget, max_experiments: 2, wall_seconds: 240, compute_process_seconds: 150 },
	};
	const task = await TaskController.create(
		repo,
		process.execPath,
		spec,
		() => {},
		{
			open: openExperimentLedger,
			approval: { sessionId: basename(root), approvedAt: new Date().toISOString() },
		},
		domain,
	);
	const snapshots: Record<string, ReturnType<TaskController["snapshot"]>> = {};
	let policyError: string | null = null;
	let exhaustedError: string | null = null;
	try {
		snapshots.baseline = await task.invoke("baseline", {});
		snapshots.repeated_baseline = await task.invoke("baseline", {});
		try {
			// 尝试将留出分片作为工具参数传入，验证运行时权限拒绝。
			await task.invoke("candidate", { split: "holdout" });
		} catch (error) {
			policyError = error instanceof Error ? error.message : null;
		}
		const proposal = { content: "baseline", rationale: "Fixed deterministic regression fixture" };
		snapshots.invalid = await task.invoke("candidate", { ...proposal, parameters: { ...baseline, b: 2 } });
		snapshots.reused = await task.invoke("candidate", { ...proposal, parameters: baseline });
		snapshots.legal = await task.invoke("candidate", { ...proposal, parameters: { ...baseline, chunk_size: 128 } });
		snapshots.second = await task.invoke("candidate", { ...proposal, parameters: { ...baseline, chunk_size: 64 } });
		try {
			await task.invoke("candidate", { ...proposal, parameters: { ...baseline, chunk_size: 96 } });
		} catch (error) {
			exhaustedError = error instanceof Error ? error.message : null;
		}
	} finally {
		await task.closeLedger();
	}
	const id = basename(task.root);
	const saved = await checkpoint(repo, id);
	const paths = ["case.json", "observations.json", "result.json", "report.md"];
	const copy = async (path: string): Promise<void> => {
		await save(root, path, await file(task.root, path));
		paths.push(path);
	};
	for (const run of saved.evaluated) {
		await copy(run.run);
		await copy(`retrieval/${run.id}/contributions.json`);
		await copy(`retrieval/${run.id}/proposal.json`);
	}
	await copy("retrieval/delivery.json");
	const verify = (): Promise<TaskController> =>
		TaskController.resume(repo, process.execPath, id, openExperimentLedger, () => {}, domain);
	const restored = await verify();
	const state = restored.snapshot();
	await restored.closeLedger();
	let corruptError: string | null = null;
	const artifact = saved.evaluated[0].run;
	await appendFile(join(task.root, artifact), "\n");
	try {
		const bad = await verify();
		await bad.closeLedger();
	} catch (error) {
		corruptError = error instanceof Error ? error.message : null;
	}
	await json(root, "case.json", { case_id: "RAG-CORE-01", version: 1, mode: "fixed_parameters", spec });
	const observation: CoreObservation = {
		snapshots,
		saved,
		restored: state,
		policy_error: policyError,
		exhausted_error: exhaustedError,
		corrupt_error: corruptError,
	};
	await json(root, "observations.json", { task_id: id, ...observation });
	await json(root, "checkpoint-after.json", saved);
	paths.push("checkpoint-after.json");
	for (const op of saved.commands) await copy(`commands/${op.id}.json`);
	const grades = gradeCore(observation);
	const traceRun = { case_id: "RAG-CORE-01", run_id: basename(root), started_at, status: "completed" };
	// 派生轨迹使用与真实 Case 相同的账本证据与归因规则。
	const trace = await saveRetrievalTrace(
		root,
		traceRun,
		await Promise.all(
			paths.filter((path) => path !== "result.json" && path !== "report.md").map((path) => digest(root, path)),
		),
		grades,
	);
	paths.push(...trace);
	const result = {
		...traceRun,
		task_id: id,
		...grades,
		trace,
		budget: saved.summary.budget,
		usage: { requests: 0, tokens: 0, estimated_cost_usd: 0 },
	};
	await json(root, "result.json", result);
	await save(
		root,
		"report.md",
		`# RAG-CORE-01\n\nTask Success ${result.task_success.status}\n\nHarness Correctness ${result.harness_correctness.status}\n`,
	);
	await json(root, "manifest.json", {
		schema_version: 1,
		case_id: result.case_id,
		evidence: await Promise.all(paths.map((path) => digest(root, path))),
	});
	return root;
}

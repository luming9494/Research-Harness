// 确定性用例适配真实策略、账本或交付代码。这里的合成输出不作为真实模型指标。
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ExperimentAdapter,
	ParetoDecision,
} from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import { paretoPoint } from "../../packages/coding-agent/src/axiom/execution/pareto.ts";
import {
	publishParetoArtifacts,
	verifyParetoArtifacts,
} from "../../packages/coding-agent/src/axiom/execution/pareto-artifacts.ts";
import { TaskBudget } from "../../packages/coding-agent/src/axiom/execution/task-budget.ts";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { tinyEvaluation } from "../../packages/coding-agent/src/axiom/execution/task-executor.ts";
import {
	DEFAULT_BUDGET,
	TASK_RULES,
	validateTaskSpec,
} from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";
import type { BenchCase } from "./cases.ts";

export async function deterministic(
	item: BenchCase,
	root: string,
	repo: string,
	python: string,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const spec = validateTaskSpec({
		version: 1,
		task: "tiny-xor-v1",
		goal: item.description,
		target_accuracy: null,
		rules: TASK_RULES,
		budget: { ...DEFAULT_BUDGET, training_steps: Math.max(1, item.budget.max_steps) },
	});
	if (item.id === "T1-POL-01") {
		const task = await TaskController.create(repo, python, spec, () => {});
		try {
			const rejected = await rejection(() =>
				task.executor.prepare("exp-1", task.executor.original, "Unapproved override", signal, {
					learning_rate: 0.08,
				}),
			);
			return { rejected, commands: await readdir(join(task.root, "commands")), outcome: task.snapshot() };
		} finally {
			await task.closeLedger();
		}
	}
	if (item.id === "T1-SEARCH-01") {
		const offered = {
			id: "exp-1",
			run: "",
			fingerprint: "fixture-proxy",
			validation: { level: "proxy", accuracy: 1 },
		};
		let rejected: string | null = null;
		try {
			paretoPoint(offered, tinyEvaluation(null));
		} catch (error) {
			rejected = String(error);
		}
		return { offered, rejected, accepted: rejected === null };
	}
	if (item.id === "T1-EVAL-01") {
		const fixture = join(root, "fixture");
		const source = join(fixture, "source");
		await mkdir(source, { recursive: true });
		await writeFile(join(source, "checkpoint.pt"), "approved fixture checkpoint");
		const run = { id: "exp-1", fingerprint: "fixture-full", validation: { level: "full" }, run: source };
		const decision: ParetoDecision = {
			preference: { strategy: "frontier" },
			reason: "complete_frontier",
			primary: run.id,
			selected: [{ id: run.id, fingerprint: run.fingerprint, metrics: { accuracy: 1 } }],
		};
		// 交付验证器自身还要重算文件摘要，故障只改已发布副本。
		const verify = async (): Promise<void> => {};
		const manifest = await publishParetoArtifacts(fixture, decision, [run], ["checkpoint.pt"], verify);
		await writeFile(join(fixture, "pareto-delivery", run.id, "checkpoint.pt"), "changed fixture checkpoint");
		const rejected = await rejection(() =>
			verifyParetoArtifacts(fixture, decision, [run], ["checkpoint.pt"], manifest, verify),
		);
		return { rejected };
	}
	// 使用真实 TaskController 观察模型已完成、相同指纹复用和预算拒绝。
	const workspace = join(root, "fixture");
	await mkdir(workspace);
	const launches: string[] = [];
	const adapter: ExperimentAdapter = {
		original: "baseline",
		config: "fixture",
		evaluation: tinyEvaluation(null),
		reportNotes: [],
		trainingSteps(): number {
			return 1;
		},
		async prepare(id, content, rationale) {
			return { id, content, rationale, fingerprint: content.trim() };
		},
		async run(candidate) {
			launches.push(candidate.id);
			return {
				id: candidate.id,
				fingerprint: candidate.fingerprint,
				run: workspace,
				validation: {
					protocol: "tiny-xor-v1",
					split: "validation",
					level: "full",
					samples: 512,
					dataset_access_log: ["validation"],
					accuracy: candidate.id === "baseline" ? 0.5 : 1,
					loss: 0.1,
				},
			};
		},
		async verifyEvaluated(): Promise<void> {},
		async deliver(best) {
			await writeFile(
				join(root, "toy-output.json"),
				JSON.stringify({ best_id: best.id, predictions: [0, 1, 1, 0] }),
				{ flag: "wx" },
			);
			return { best_id: best.id };
		},
	};
	const task = new TaskController(workspace, spec, new TaskBudget(spec), adapter);
	try {
		await task.initialize();
		await task.invoke("baseline", {}, signal);
		const first = await task.invoke("candidate", { content: "candidate-a", rationale: "synthetic fixture" }, signal);
		if (item.id === "T1-DUR-02")
			await task.invoke("candidate", { content: " candidate-a ", rationale: "same fingerprint" }, signal);
		const final = await task.stop("user_finished");
		const toy = JSON.parse(await readFile(join(root, "toy-output.json"), "utf8")) as unknown;
		return { launches, first: { budget: first.budget }, final, toy };
	} finally {
		await task.closeLedger();
	}
}

async function rejection(operation: () => Promise<unknown>): Promise<string | null> {
	try {
		await operation();
		return null;
	} catch (error) {
		return String(error);
	}
}

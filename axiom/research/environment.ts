// 固定执行器、数据和模型身份，并定义两个领域的宿主 TaskSpec。
import { join } from "node:path";
import type {
	ExperimentDomain,
	ExperimentTaskSpec,
} from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import { tinyExperimentDomain } from "../../packages/coding-agent/src/axiom/execution/task-executor.ts";
import { TASK_RULES } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";
import { childOutput, digest, sha256 } from "../bench/io.ts";
import type { DenseSource } from "../rag/dense.ts";
import { hybridProtocol, implementationSha, ragDomain } from "../rag/domain.ts";
import { sparseControl } from "../rag/hybrid.ts";
import { assets } from "../rag/scifact.ts";
import type { Domain, Plan } from "./plan.ts";

export interface Runtime {
	repo: string;
	python: string;
	data?: string;
	vectors?: DenseSource;
}

export async function identity(runtime: Runtime, domain: Domain): Promise<Plan["controlled"]> {
	const { repo } = runtime;
	const node = [process.platform, process.arch, process.version];
	if (domain === "scifact") {
		if (!runtime.data || !runtime.vectors) throw new Error("SciFact requires frozen data and development vectors");
		return {
			dataset: sha256(JSON.stringify([assets["corpus.jsonl"], assets["claims_train.jsonl"]])),
			implementation: await implementationSha(true),
			model: runtime.vectors.sha,
			environment: sha256(JSON.stringify(node)),
			evaluation: "scifact-development-v2",
		};
	}
	// Python 与 Torch 版本和可信训练源同时纳入计划，跨环境不会悄悄复用。
	const probe = await childOutput(
		runtime.python,
		["-c", "import sys, torch; print(sys.version); print(torch.__version__)"],
		repo,
		AbortSignal.timeout(30_000),
	);
	const hashFiles = async (paths: string[]): Promise<string> =>
		sha256(JSON.stringify(await Promise.all(paths.map((path) => digest(repo, path)))));
	return {
		dataset: await hashFiles(["examples/tiny-ml-eval/common.py"]),
		implementation: await hashFiles([
			...[
				"train",
				"supervise",
				"evaluate",
				"validate_only",
				"common",
				"review_candidate",
				"experiment",
				"checks",
			].map((name) => `examples/tiny-ml-eval/${name}.py`),
			"packages/coding-agent/src/axiom/execution/task-executor.ts",
		]),
		model: await hashFiles(["examples/tiny-ml-task/shallow-tanh.py", "examples/tiny-ml-task/config.json"]),
		environment: sha256(JSON.stringify([node, probe.stdout.trim()])),
		evaluation: "tiny-validation-v1",
	};
}

export function adapter(runtime: Runtime, plan: Plan): ExperimentDomain {
	return plan.domain === "tiny" ? tinyExperimentDomain : ragDomain(runtime.data ?? "", runtime.vectors);
}

export function specFor(plan: Plan, sha: string, repeat: number): ExperimentTaskSpec {
	const goal = `Frozen research plan ${sha} repeat ${repeat}`;
	const budget = {
		max_experiments: plan.conditions.length - 1,
		wall_seconds: Math.floor(plan.budgets.wall_seconds / plan.repeats),
		max_tokens: 1,
		compute_process_seconds: Math.floor(plan.budgets.compute_seconds / plan.repeats),
		training_steps: Math.floor(plan.budgets.training_steps / plan.repeats),
		cpu_threads: 1 as const,
		device: "cpu" as const,
	};
	// Tiny v2 只开放学习率。候选源码由领域内已验收的起点提供。
	return plan.domain === "tiny"
		? ({
				version: 2,
				task: "tiny-xor-v1",
				goal,
				budget,
				max_revisions: 0,
				rules: TASK_RULES,
				starting_model: "shallow_tanh",
				parameters: { learning_rate: { min: 0.01, max: 0.08 } },
				objective: { metric: "accuracy", direction: "maximize", target: null },
			} as ExperimentTaskSpec)
		: ({
				version: 2,
				task: hybridProtocol,
				goal,
				budget,
				max_revisions: 0,
				search_space: sparseControl,
				embedding_manifest_sha256: plan.controlled.model,
			} as ExperimentTaskSpec);
}

export function executable(runtime: Runtime, domain: Domain): string {
	return domain === "tiny" ? runtime.python : process.execPath;
}

export function taskRoot(repo: string, taskId: string): string {
	if (!/^wp04-[A-Za-z0-9]{6}$/.test(taskId)) throw new Error("Invalid linked Task ID");
	return join(repo, "private", taskId);
}

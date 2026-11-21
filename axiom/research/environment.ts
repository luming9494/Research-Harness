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
import { type Domain, type Plan, seedFor } from "./plan.ts";

export interface Runtime {
	repo: string;
	python: string;
	data?: string;
	vectors?: DenseSource;
}

export async function identity(
	runtime: Runtime,
	domain: Domain,
	version: Plan["version"] = 1,
): Promise<Plan["controlled"]> {
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
		implementation: sha256(
			JSON.stringify(
				await Promise.all(
					[
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
					].map(async (path): Promise<Awaited<ReturnType<typeof digest>>> => {
						const asset = await digest(repo, path);
						// 旧协议以已审阅执行器身份核对，仅接受本阶段已知的种子扩展或原版字节。
						if (
							version === 1 &&
							[
								"a23f397476eaa405ed7e52914ed0f2601bd0f7e5f1c7fd36d6a120e94711a1a9",
								"d2df2eee8d00f76fdef935fc3304996e5840f59a652d180440c05cc5b201dce1",
							].includes(asset.sha256)
						)
							return {
								...asset,
								sha256: "8de973a4f379e1a03b98d3467b74fd3c814b913ca36110d192fe725a3749f43d",
								bytes: 32644,
							};
						// WP-12 仅开放计数器，冻结的 v2 本地矩阵继续沿用原执行身份。
						if (
							version === 2 &&
							asset.sha256 === "d2df2eee8d00f76fdef935fc3304996e5840f59a652d180440c05cc5b201dce1"
						)
							return {
								...asset,
								sha256: "a23f397476eaa405ed7e52914ed0f2601bd0f7e5f1c7fd36d6a120e94711a1a9",
								bytes: 33008,
							};
						return asset;
					}),
				),
			),
		),
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
				...(plan.version === 2 ? { initialization_seed: seedFor(plan, repeat) } : {}),
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

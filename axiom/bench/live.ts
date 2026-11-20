// 真实模型通过原生 Pi RPC 驱动。档案只记录工具名、用量和结束状态。
import { spawn } from "node:child_process";
import { basename, isAbsolute, join } from "node:path";
import {
	DEFAULT_BUDGET,
	TASK_RULES,
	type TaskSpec,
} from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";
import type { BenchCase } from "./cases.ts";

export interface LiveTrace {
	workspace: string | null;
	tools: string[];
	turns: { tools: string[] }[];
	admitted: number;
	usage: { provider: string; model: string; tokens: number | null; cost: number | null; stop_reason?: string }[];
	barrier: boolean;
	resumed: boolean;
	error: string | null;
}
interface RpcEvent {
	id?: string;
	type: string;
	method?: string;
	title?: string;
	command?: string;
	success?: boolean;
	message?:
		| string
		| {
				role?: string;
				provider?: string;
				model?: string;
				stopReason?: string;
				usage?: { totalTokens?: number; cost?: { total?: number } };
		  };
	data?: { model?: { provider?: string; id?: string } };
	toolName?: string;
}

export async function runLive(
	item: BenchCase,
	repo: string,
	python: string,
	signal: AbortSignal,
	saveBeforeRecovery: (workspace: string) => Promise<void>,
): Promise<LiveTrace> {
	const base = {
		task: "tiny-xor-v1" as const,
		goal: item.comparison ? item.description : "Improve the Tiny CPU validation model in one experiment",
		rules: TASK_RULES,
		budget: {
			...DEFAULT_BUDGET,
			max_experiments: item.budget.max_proposals,
			max_tokens: item.budget.max_tokens,
			training_steps: item.budget.max_steps,
			compute_process_seconds: item.budget.max_compute_seconds ?? DEFAULT_BUDGET.compute_process_seconds,
			wall_seconds: item.budget.max_task_wall_seconds ?? DEFAULT_BUDGET.wall_seconds,
		},
	};
	const spec: TaskSpec = item.comparison
		? {
				...base,
				version: 2,
				max_revisions: 0,
				...(item.comparison.starting_model === "shallow_tanh" ? { starting_model: "shallow_tanh" as const } : {}),
				parameters: { learning_rate: item.comparison.learning_rate },
				objective: { metric: "accuracy", direction: "maximize", target: null },
			}
		: { ...base, version: 1, target_accuracy: null };
	const trace: LiveTrace = {
		workspace: null,
		tools: [],
		turns: [],
		admitted: 0,
		usage: [],
		barrier: false,
		resumed: false,
		error: null,
	};
	const barrier = item.comparison?.task === "interruption";
	try {
		await drive(item, repo, python, signal, spec, trace, barrier);
		if (trace.barrier && !trace.error && trace.workspace) {
			await saveBeforeRecovery(trace.workspace);
			// B0/B1 不读取中断前的任务收据或发出新的训练请求。
			if (item.comparison?.arm === "B2")
				await drive(item, repo, python, signal, spec, trace, false, basename(trace.workspace));
		}
	} catch (error) {
		trace.error = error instanceof Error ? error.message : String(error);
	}
	return trace;
}

// 每个进程使用原生 RPC，恢复轮创建新的会话并沿用已经批准的任务 ID。
function drive(
	item: BenchCase,
	repo: string,
	python: string,
	signal: AbortSignal,
	spec: TaskSpec,
	trace: LiveTrace,
	barrier: boolean,
	resumeId?: string,
): Promise<void> {
	const agentDir =
		process.env.AXIOM_BENCH_AGENT_DIR ??
		(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Research-Harness", "agent") : undefined);
	if (!agentDir || !isAbsolute(agentDir))
		throw new Error("Set AXIOM_BENCH_AGENT_DIR to the isolated native Pi configuration");
	const [provider, model] = (item.model ?? "").split("/");
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				join(repo, "packages/coding-agent/dist/bundle/cli.js"),
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-builtin-tools",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"-e",
				join(repo, item.comparison ? "axiom/bench/pi-extension.ts" : "axiom/extensions/axiom-tiny.ts"),
				"--provider",
				provider,
				"--model",
				model,
				"--thinking",
				"off",
			],
			{
				cwd: repo,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					AXIOM_PYTHON: python,
					AXIOM_BENCH_ARM: item.comparison?.arm,
					AXIOM_BENCH_BARRIER: barrier ? "baseline-committed" : "",
				},
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let raw = "",
			workspace: string | undefined,
			failure: string | undefined,
			interrupted = false,
			stopping = false;
		const cancel = (): void => {
			child.kill("SIGKILL");
		};
		const send = (event: Record<string, unknown>): void => {
			child.stdin.write(`${JSON.stringify(event)}\n`);
		};
		const fail = (reason: string): void => {
			failure ??= reason;
			child.stdin.end();
		};
		signal.addEventListener("abort", cancel, { once: true });
		child.stderr.resume();
		child.stdin.on("error", () => {});
		const handle = (event: RpcEvent): void => {
			if (event.type === "response" && event.success === false) {
				fail(`Pi RPC command failed: ${event.command}`);
				return;
			}
			if (event.id === "state") {
				if (event.data?.model?.provider !== provider || event.data.model.id !== model) {
					fail("Unexpected Pi model");
					return;
				}
				send({
					id: "task",
					type: "prompt",
					message: resumeId ? `/axiom-task-resume ${resumeId}` : `/axiom-task ${JSON.stringify(spec)}`,
				});
			}
			if (event.type === "extension_ui_request" && event.method === "confirm") {
				// 只自动确认与固定预算一致的原生 TaskSpec 对话框。
				const approved =
					!resumeId &&
					event.title === "AXIOM multi-round Tiny Task" &&
					typeof event.message === "string" &&
					event.message.startsWith(JSON.stringify(spec, null, 2));
				send({ type: "extension_ui_response", id: event.id, confirmed: approved });
				if (!approved) fail("Unexpected approval dialog");
			}
			if (
				event.type === "extension_ui_request" &&
				event.method === "notify" &&
				typeof event.message === "string" &&
				event.message.startsWith("Task ready: ") &&
				!workspace
			) {
				workspace = event.message.slice(12).split(". Ask Pi")[0];
				if (resumeId && workspace !== trace.workspace) {
					fail("Pi recovery changed its task workspace");
					return;
				}
				trace.workspace = workspace;
				if (resumeId) trace.resumed = true;
				send({
					id: "research",
					type: "prompt",
					message: item.comparison
						? `${item.description} Use only the approved tools. Inspect the task, obtain or reuse the baseline, propose your own complete legal model.py candidates with a rationale, and use only independently measured validation scores. Explicit learning rates must fit the approved range. Wait for the requested evaluated candidates or a host stop before finishing. Do not access final-test.`
						: "Use the approved Tiny CPU tools to inspect, run the baseline, and execute one new legal candidate of your choosing that improves validation. For the candidate tool in this v1 task send only content (complete legal model.py) and rationale. If tool input is rejected before a launch, correct the arguments before finishing. Wait for the independently evaluated candidate result or host stop before finishing. Do not access final-test.",
				});
			}
			if (
				workspace &&
				barrier &&
				event.type === "extension_ui_request" &&
				event.method === "notify" &&
				event.message === "Benchmark barrier: baseline committed"
			) {
				interrupted = child.kill("SIGKILL");
				trace.barrier = interrupted;
			}
			if (
				event.type === "extension_ui_request" &&
				event.method === "notify" &&
				event.message === "Benchmark model admission committed"
			)
				trace.admitted++;
			if (event.type === "message_end" && typeof event.message === "object" && event.message?.role === "assistant") {
				// 主机拒绝仍可能生成 Pi assistant 事件，但不会经过模型请求准入。
				if (item.comparison && trace.admitted <= trace.usage.length) return;
				const m = event.message;
				// 仅保留轮次和工具名称，用于区分反馈后的新提案与同轮批量提交。
				trace.turns.push({ tools: [] });
				trace.usage.push({
					provider: m.provider ?? "",
					model: m.model ?? "",
					tokens: m.stopReason === "error" || m.stopReason === "aborted" ? null : (m.usage?.totalTokens ?? null),
					cost: m.usage?.cost?.total ?? null,
					stop_reason: m.stopReason,
				});
			}
			if (event.type === "tool_execution_start" && event.toolName) {
				trace.tools.push(event.toolName);
				trace.turns.at(-1)?.tools.push(event.toolName);
			}
			if (workspace && !stopping && event.type === "agent_settled") {
				stopping = true;
				send({ id: "stop", type: "prompt", message: "/axiom-task-stop" });
			}
			if (event.id === "stop") child.stdin.end();
		};
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			raw += chunk;
			if (raw.length > 2_000_000) {
				cancel();
				failure = "RPC record exceeded limit";
				return;
			}
			const entries = raw.split("\n");
			raw = entries.pop() ?? "";
			for (const line of entries)
				if (line.trim()) {
					try {
						handle(JSON.parse(line) as RpcEvent);
					} catch {
						fail("Invalid Pi RPC event");
					}
				}
		});
		child.once("error", reject);
		child.once("close", (code) => {
			signal.removeEventListener("abort", cancel);
			if (signal.aborted) reject(signal.reason);
			else if (failure || !workspace || (code !== 0 && !interrupted) || (barrier && !interrupted))
				reject(new Error(failure ?? "Pi RPC ended before a task was created"));
			else resolve();
		});
		send({ id: "state", type: "get_state" });
	});
}

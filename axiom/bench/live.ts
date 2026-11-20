// 真实模型通过原生 Pi RPC 驱动。档案只记录工具名、用量和结束状态。
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { DEFAULT_BUDGET, TASK_RULES } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";
import type { BenchCase } from "./cases.ts";

export interface LiveTrace {
	workspace: string;
	tools: string[];
	usage: { provider: string; model: string; tokens: number | null; cost: number | null }[];
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
				usage?: { totalTokens?: number; cost?: { total?: number } };
		  };
	data?: { model?: { provider?: string; id?: string } };
	toolName?: string;
}

export async function runLive(item: BenchCase, repo: string, signal: AbortSignal): Promise<LiveTrace> {
	const agentDir =
		process.env.AXIOM_BENCH_AGENT_DIR ??
		(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Research-Harness", "agent") : undefined);
	if (!agentDir || !isAbsolute(agentDir))
		throw new Error("Set AXIOM_BENCH_AGENT_DIR to the isolated native Pi configuration");
	const spec = {
		version: 1,
		task: "tiny-xor-v1",
		goal: "Improve the Tiny CPU validation model in one experiment",
		target_accuracy: null,
		rules: TASK_RULES,
		budget: {
			...DEFAULT_BUDGET,
			max_experiments: item.budget.max_proposals,
			max_tokens: item.budget.max_tokens,
			training_steps: item.budget.max_steps,
		},
	};
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
				join(repo, "axiom/extensions/axiom-tiny.ts"),
				"--provider",
				provider,
				"--model",
				model,
				"--thinking",
				"off",
			],
			{
				cwd: repo,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		const tools: string[] = [];
		const usage: LiveTrace["usage"] = [];
		let raw = "",
			workspace: string | undefined,
			failure: string | undefined;
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
				send({ id: "task", type: "prompt", message: `/axiom-task ${JSON.stringify(spec)}` });
			}
			if (event.type === "extension_ui_request" && event.method === "confirm") {
				// 只自动确认与固定预算一致的原生 TaskSpec 对话框。
				const approved =
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
				send({
					id: "research",
					type: "prompt",
					message:
						"Use the approved Tiny CPU tools to inspect, run the baseline, and execute one new legal candidate of your choosing that improves validation. For the candidate tool in this v1 task send only content (complete legal model.py) and rationale. If tool input is rejected before a launch, correct the arguments before finishing. Wait for the independently evaluated candidate result or host stop before finishing. Do not access final-test.",
				});
			}
			if (event.type === "message_end" && typeof event.message === "object" && event.message?.role === "assistant") {
				const m = event.message;
				usage.push({
					provider: m.provider ?? "",
					model: m.model ?? "",
					tokens: m.usage?.totalTokens ?? null,
					cost: m.usage?.cost?.total ?? null,
				});
			}
			if (event.type === "tool_execution_start" && event.toolName) tools.push(event.toolName);
			if (workspace && event.type === "agent_settled")
				send({ id: "stop", type: "prompt", message: "/axiom-task-stop" });
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
			else if (failure || !workspace || code !== 0)
				reject(new Error(failure ?? "Pi RPC ended before a task was created"));
			else resolve({ workspace, tools, usage });
		});
		send({ id: "state", type: "get_state" });
	});
}

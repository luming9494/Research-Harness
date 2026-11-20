// 每次提案只打开一个无工具原生 Pi Session，记录用量但不归档任意模型消息。
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

export const proposalModel = "deepseek/deepseek-flash";
export interface ProposalReply {
	text: string;
	usage: {
		requests: number | null;
		tokens: number | null;
		input_tokens: number | null;
		estimated_cost_usd: number | null;
	};
	error: string | null;
}

interface RpcEvent {
	type: string;
	id?: string;
	success?: boolean;
	data?: { model?: { id: string; provider: string } };
	message?: {
		role: string;
		provider: string;
		model: string;
		stopReason: string;
		content?: { type: string; text?: string }[];
		usage?: { input: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total?: number } };
	};
}

/** 单请求、固定模型，无文件、Shell 或 Benchmark 工具。 */
export async function requestProposal(repo: string, prompt: string, signal: AbortSignal): Promise<ProposalReply> {
	const agentDir =
		process.env.AXIOM_BENCH_AGENT_DIR ??
		(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Research-Harness", "agent") : undefined);
	if (!agentDir || !isAbsolute(agentDir)) throw new Error("Set AXIOM_BENCH_AGENT_DIR to the native Pi configuration");
	if (Buffer.byteLength(prompt) > 12_000) throw new Error("Proposal context exceeds fixed transport limit");
	const [provider, model] = proposalModel.split("/");
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
	deadline.throwIfAborted();
	return new Promise((resolve) => {
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
				join(repo, "axiom/evolution/pi-extension.ts"),
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
				windowsHide: true,
				stdio: ["pipe", "pipe", "ignore"],
			},
		);
		let raw = "",
			sent = false,
			settled = false,
			error: string | null = null;
		let text = "";
		const usage: ProposalReply["usage"] = { requests: 0, tokens: null, input_tokens: null, estimated_cost_usd: null };
		const stop = (): void => {
			child.kill("SIGKILL");
		};
		const send = (id: string, type: string, fields: Record<string, unknown> = {}): void => {
			child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		};
		const fail = (reason: string): void => {
			error ??= reason;
			stop();
		};
		deadline.addEventListener("abort", stop, { once: true });
		child.stdin.on("error", () => {});
		child.once("error", () => {
			error = "pi_spawn_failed";
		});
		child.once("close", (code) => {
			deadline.removeEventListener("abort", stop);
			resolve({
				text,
				usage,
				error:
					error ??
					(deadline.aborted ? "proposal_interrupted" : settled && code === 0 ? null : "pi_rpc_incomplete"),
			});
		});
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			raw += chunk;
			if (raw.length > 128_000) {
				fail("pi_rpc_output_limit");
				return;
			}
			const lines = raw.split("\n");
			raw = lines.pop() ?? "";
			try {
				for (const line of lines) {
					if (!line.trim()) continue;
					const event = JSON.parse(line) as RpcEvent;
					if (event.type === "response" && event.success === false) {
						fail("pi_rpc_command_failed");
						break;
					}
					if (event.id === "state" && event.type === "response") {
						if (event.data?.model?.provider !== provider || event.data.model.id !== model) {
							fail("pi_model_mismatch");
							break;
						}
						send("retry", "set_auto_retry", { enabled: false });
					} else if (event.id === "retry" && event.type === "response")
						send("compact", "set_auto_compaction", { enabled: false });
					else if (event.id === "compact" && event.type === "response" && !sent) {
						sent = true;
						usage.requests = null;
						send("proposal", "prompt", { message: prompt });
					}
					const message = event.message;
					if (event.type === "tool_execution_start") {
						fail("unexpected_proposal_tool");
						break;
					}
					if (sent && event.type === "message_end" && message?.role === "assistant") {
						if (usage.requests === 1 || message.provider !== provider || message.model !== model) {
							fail("unexpected_proposal_reply");
							break;
						}
						const row = message.usage;
						usage.requests = 1;
						if (message.stopReason !== "stop" || !row) {
							fail("provider_proposal_incomplete");
							break;
						}
						usage.tokens = row.totalTokens;
						usage.input_tokens = row.input + row.cacheRead + row.cacheWrite;
						usage.estimated_cost_usd = row.cost?.total ?? null;
						text = (message.content ?? [])
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("");
					}
					if (sent && event.type === "agent_settled") {
						settled = Boolean(text);
						child.stdin.end();
					}
				}
			} catch {
				fail("pi_rpc_invalid_message");
			}
		});
		send("state", "get_state");
	});
}

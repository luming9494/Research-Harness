// 通过 Pi 原生 RPC 执行分轮科研，宿主收集事件身份和提供商用量。
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { DenseSource } from "./dense.ts";
import { hybridProtocol, type RagTaskSpec } from "./domain.ts";

interface Event {
	id?: string;
	type: string;
	method?: string;
	title?: string;
	message?:
		| string
		| {
				role: string;
				provider?: string;
				model?: string;
				stopReason?: string;
				usage?: { totalTokens?: number; cost?: { total?: number } };
		  };
	toolName?: string;
	toolCallId?: string;
	success?: boolean;
	data?: { sessionId?: string; model?: { provider: string; id: string } };
}

export interface Epoch {
	session: string | null;
	task: string | null;
	interrupted: boolean;
	admitted: number;
	usage: { request: number; model: string | null; tokens: number | null; cost: number | null; stop: string | null }[];
	tools: { request: number; id: string | null; tool: string; event: string }[];
	error: string | null;
}

// 新会话通过原 Task ID 恢复，第二轮必须先读取已提交的第一轮结果。
export function drivePi(
	repo: string,
	data: string,
	spec: RagTaskSpec,
	modelId: string,
	signal: AbortSignal,
	resumeId?: string,
	embedding?: DenseSource,
): Promise<Epoch> {
	const agentDir =
		process.env.AXIOM_BENCH_AGENT_DIR ??
		(process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Research-Harness", "agent"));
	if (!agentDir || !isAbsolute(agentDir)) throw new Error("Set AXIOM_BENCH_AGENT_DIR to the isolated Pi config");
	const [provider, model] = modelId.split("/");
	if (!provider || !model || modelId !== `${provider}/${model}`) throw new Error("Expected provider/model");
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
				"--no-context-files",
				"--no-prompt-templates",
				"-e",
				join(repo, "axiom/rag/pi-extension.ts"),
				"--provider",
				provider,
				"--model",
				model,
				"--thinking",
				"off",
			],
			{
				cwd: repo,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					AXIOM_RAG_DATA: data,
					AXIOM_RAG_VECTOR_ROOT: embedding?.root,
					AXIOM_RAG_VECTOR_SHA: embedding?.sha,
					AXIOM_RAG_BARRIER: resumeId ? "0" : "1",
				},
			},
		);
		const epoch: Epoch = {
			session: null,
			task: null,
			interrupted: false,
			admitted: 0,
			usage: [],
			tools: [],
			error: null,
		};
		const send = (event: Record<string, unknown>): void => {
			child.stdin.write(`${JSON.stringify(event)}\n`);
		};
		const abort = (): void => {
			child.kill("SIGKILL");
		};
		const fail = (reason: string): void => {
			epoch.error ??= reason;
			child.stdin.end();
		};
		signal.addEventListener("abort", abort, { once: true });
		child.stdin.on("error", () => {});
		child.stderr.resume();
		child.on("error", reject);
		createInterface({ input: child.stdout }).on("line", (line: string): void => {
			try {
				const e = JSON.parse(line) as Event;
				if (e.type === "response" && e.success === false) {
					fail(`Pi RPC rejected ${e.id ?? "command"}`);
					return;
				}
				if (e.id === "state") {
					if (e.data?.model?.provider !== provider || e.data.model.id !== model || !e.data.sessionId) {
						fail("Pi model or Session identity did not match");
						return;
					}
					epoch.session = e.data.sessionId;
					send({
						id: "approval",
						type: "prompt",
						message: resumeId ? `/axiom-rag-resume ${resumeId}` : `/axiom-rag ${JSON.stringify(spec)}`,
					});
				}
				if (e.type === "extension_ui_request" && e.method === "confirm") {
					const approved =
						!resumeId && e.title === "AXIOM SciFact retrieval" && e.message === JSON.stringify(spec, null, 2);
					send({ type: "extension_ui_response", id: e.id, confirmed: approved });
					if (!approved) fail("Unexpected approval dialog");
				}
				if (e.type === "extension_ui_request" && e.method === "notify" && typeof e.message === "string") {
					const ready = /^AXIOM RAG ready (wp04-[A-Za-z0-9]{6})$/.exec(e.message);
					if (ready && !epoch.task) {
						epoch.task = ready[1];
						if (resumeId && epoch.task !== resumeId) {
							fail("Recovery changed Task ID");
							return;
						}
						// 混合协议先冻结两个额外对照，第一条自主候选因而是 exp-3。
						const hybrid = spec.task === hybridProtocol;
						const first = hybrid ? "exp-3" : "exp-1";
						send({
							id: "research",
							type: "prompt",
							message: resumeId
								? `Inspect the recovered task first. Use ${first}'s actual development feedback to propose and evaluate one distinct new valid retrieval configuration citing ${first}. After that result, call finish. For hybrid proposals use the approved strategy-specific schema.`
								: `Inspect the task, run the fixed ${hybrid ? "BM25, Dense, and RRF controls" : "baseline"}, then use measured development feedback to propose and evaluate a distinct ${hybrid ? "retrieval" : "BM25"} configuration. Call at most one tool per model turn. The operator will interrupt the process after that candidate is committed.`,
						});
					}
					if (e.message === "AXIOM RAG model admitted") epoch.admitted++;
					if (!resumeId && epoch.task && e.message === "AXIOM RAG candidate committed")
						epoch.interrupted = child.kill("SIGKILL");
				}
				if (
					e.type === "message_end" &&
					typeof e.message === "object" &&
					e.message.role === "assistant" &&
					epoch.admitted > epoch.usage.length
				) {
					const m = e.message;
					const failed = m.stopReason === "aborted" || m.stopReason === "error";
					epoch.usage.push({
						request: epoch.admitted,
						model: m.model && m.provider ? `${m.provider}/${m.model}` : null,
						tokens: failed ? null : (m.usage?.totalTokens ?? null),
						cost: failed ? null : (m.usage?.cost?.total ?? null),
						stop: m.stopReason ?? null,
					});
				}
				if (e.toolName && (e.type === "tool_execution_start" || e.type === "tool_execution_end"))
					epoch.tools.push({ request: epoch.admitted, id: e.toolCallId ?? null, tool: e.toolName, event: e.type });
				if (epoch.task && e.type === "agent_settled") child.stdin.end();
			} catch {
				fail("Invalid Pi RPC event");
			}
		});
		child.on("close", (code: number | null): void => {
			signal.removeEventListener("abort", abort);
			if (signal.aborted) epoch.error ??= "Pi session exceeded approved deadline or was interrupted";
			else if (code !== 0 && !epoch.interrupted) epoch.error ??= `Pi process exited with ${code}`;
			else if (!resumeId && !epoch.interrupted) epoch.error ??= "Candidate commit barrier was not reached";
			resolve(epoch);
		});
		send({ id: "state", type: "get_state" });
	});
}

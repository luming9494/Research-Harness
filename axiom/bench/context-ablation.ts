// 普通 Pi RPC 加载生产任务扩展，四组唯一差异是上下文和候选呈现策略。
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { approvedPolicy, bindPolicy } from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";
import {
	DEFAULT_BUDGET,
	TASK_RULES,
	type TaskSpec,
} from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";
import { openExperimentLedger } from "../durable/experiment-ledger.ts";
import { proposalModel } from "../evolution/proposal-rpc.ts";
import { localEndpoint, request } from "../research/platform/http.ts";
import { type Catalog, memoryCollection } from "../research/platform/memory.ts";
import { file, json, sha256 } from "./io.ts";

const arms = ["native", "enhanced", "enhanced_qdrant", "candidate_qdrant"] as const;
type Arm = (typeof arms)[number];
const task: TaskSpec = {
	version: 1,
	task: "tiny-xor-v1",
	goal: "Use historical Adam learning rate experiments and validation accuracy to guide the next experiment",
	target_accuracy: null,
	rules: TASK_RULES,
	budget: { ...DEFAULT_BUDGET, max_experiments: 1, wall_seconds: 130, max_tokens: 28000 },
};
const question =
	"Choose one Adam learning rate suggested by the verified history in your context. Return the exact Evidence ID and rate or UNKNOWN if you have no applicable run evidence. No tools or experiment execution.";
interface Message {
	role: string;
	stopReason: string;
	content: { type: string; text?: string }[];
	usage?: { input: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total?: number } };
}
interface Event {
	type: string;
	id?: string;
	title?: string;
	method?: string;
	success?: boolean;
	message?: string | Message;
}

async function observe(
	repo: string,
	arm: Arm,
	catalogPath: string,
	sha: string,
	candidatePath: string,
): Promise<{
	taskId: string | null;
	message: Message | null;
	attempted: boolean;
	timedOut: boolean;
	sentEvidence: string[];
}> {
	const [provider, model] = proposalModel.split("/");
	const agent =
		process.env.AXIOM_BENCH_AGENT_DIR ??
		(process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Research-Harness", "agent"));
	if (!agent) throw new Error("Configure local Pi account before running paid ablation");
	const env = { ...process.env, PI_CODING_AGENT_DIR: agent };
	Object.assign(env, {
		AXIOM_CONTEXT: arm === "native" ? "baseline" : "enhanced",
		AXIOM_MEMORY_CATALOG: arm.endsWith("qdrant") ? catalogPath : "",
		AXIOM_MEMORY_CATALOG_SHA: sha,
		AXIOM_QDRANT_ENDPOINT: process.env.AXIOM_QDRANT_ENDPOINT ?? "http://127.0.0.1:6333",
		AXIOM_HARNESS_POLICY: arm === "candidate_qdrant" ? candidatePath : "",
		AXIOM_POLICY_REGISTRY: "",
		AXIOM_CONTEXT_EXPERIENCE: "",
	});
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
			"-e",
			join(repo, "axiom/bench/context-probe-extension.ts"),
			"--provider",
			provider,
			"--model",
			model,
			"--thinking",
			"off",
		],
		{ cwd: repo, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
	);
	const send = (type: string, id: string, fields: object = {}): void => {
		child.stdin.write(`${JSON.stringify({ type, id, ...fields })}\n`);
	};
	const closed = new Promise<void>((done) => {
		child.once("close", () => done());
	});
	child.stdin.on("error", () => {});
	child.on("error", () => {});
	let taskId: string | null = null;
	let message: Message | null = null;
	let attempted = false;
	let timedOut = false;
	let stopping = false;
	let sentEvidence: string[] = [];
	const deadline = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, 95_000);
	try {
		send("set_auto_retry", "retry", { enabled: false });
		for await (const line of createInterface({ input: child.stdout })) {
			const event = JSON.parse(line) as Event;
			if (event.id === "retry" && event.success)
				send("prompt", "approval", { message: `/axiom-task ${JSON.stringify(task)}` });
			if (event.type === "extension_ui_request" && event.method === "confirm")
				send("extension_ui_response", event.id ?? "", {
					confirmed:
						event.title === "AXIOM multi-round Tiny Task" &&
						typeof event.message === "string" &&
						event.message.startsWith(JSON.stringify(task, null, 2)),
				});
			if (event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string") {
				if (event.message.startsWith("Task ready:") && !attempted) {
					taskId = event.message.match(/wp04-[A-Za-z0-9]{6}/)?.[0] ?? null;
					if (taskId) {
						attempted = true;
						send("prompt", "research", { message: question });
					}
				}
				if (event.message.startsWith("AXIOM task closed")) child.stdin.end();
				if (event.message.startsWith("Context probe evidence "))
					sentEvidence = JSON.parse(event.message.slice("Context probe evidence ".length)) as string[];
			}
			if (
				event.type === "message_end" &&
				event.message &&
				typeof event.message === "object" &&
				event.message.role === "assistant"
			)
				message = event.message;
			if (event.type === "agent_settled" && attempted && !stopping) {
				stopping = true;
				send("prompt", "stop", { message: "/axiom-task-stop" });
			}
		}
	} finally {
		clearTimeout(deadline);
		child.kill("SIGKILL");
		await closed;
	}
	return { taskId, message, attempted, timedOut, sentEvidence };
}

async function main(): Promise<void> {
	const { values: v } = parseArgs({
		options: {
			catalog: { type: "string" },
			sha: { type: "string" },
			candidate: { type: "string" },
			out: { type: "string" },
		},
	});
	if (!v.catalog || !v.sha || !v.candidate || !v.out)
		throw new Error("Provide catalog directory, its SHA, approved candidate file and output");
	const out = resolve(v.out);
	const catalogPath = resolve(v.catalog);
	const bytes = await file(catalogPath, "catalog.json");
	if (sha256(bytes) !== v.sha.toLowerCase()) throw new Error("Memory catalog digest mismatch");
	const catalog = JSON.parse(bytes.toString()) as Catalog;
	await request(
		localEndpoint(process.env.AXIOM_QDRANT_ENDPOINT ?? "http://127.0.0.1:6333"),
		`/collections/${memoryCollection(catalog)}`,
	);
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const candidatePath = resolve(v.candidate);
	const candidate = bindPolicy(
		JSON.parse((await file(dirname(candidatePath), basename(candidatePath))).toString()),
		true,
	);
	await json(out, "plan.json", {
		model: proposalModel,
		arms,
		question,
		task,
		requests_per_arm: 1,
		catalog_sha256: v.sha,
		candidate: candidate.sha256,
	});
	const rows = [];
	for (const arm of arms) {
		// 先登记每次供应商调用的授权，保留中断后的未知状态。
		await json(out, `${arm}-intent.json`, { model: proposalModel, max_requests: 1 });
		const { taskId, message, attempted, timedOut, sentEvidence } = await observe(
			repo,
			arm,
			join(catalogPath, "catalog.json"),
			v.sha,
			resolve(v.candidate),
		);
		const ledger = taskId && (await openExperimentLedger(join(repo, "private", taskId)).catch(() => undefined));
		const state = ledger ? await ledger.load().finally(() => ledger.close()) : undefined;
		const expected = arm === "candidate_qdrant" ? candidate : approvedPolicy(arm !== "native");
		const reply =
			message?.content
				.filter(({ type }) => type === "text")
				.map(({ text }) => text ?? "")
				.join(" ") ?? "";
		const supplied = catalog.entries.filter(({ id }) => sentEvidence.includes(id));
		const entry = supplied.find(({ id }) => reply.includes(id));
		const rate = entry?.experience.result.match(/learning rate (\d+\.\d+)/)?.[1];
		const validCitation = !!rate && reply.includes(rate) && arm.endsWith("qdrant");
		const usage = message?.usage;
		const result = {
			arm,
			taskId,
			task: message?.stopReason === "stop" ? (validCitation ? "pass" : "fail") : "unknown",
			abstained: /^unknown[.!]?$/i.test(reply.trim()),
			timedOut,
			harness: state
				? state.policy?.sha256 === expected.sha256 &&
					state.policy.enhanced === expected.enhanced &&
					state.requests.length === 1 &&
					state.commands.length === 0
					? "pass"
					: "fail"
				: "unknown",
			evidence: validCitation ? entry?.id : null,
			supplied_evidence: supplied.map(({ id }) => id),
			response_sha256: sha256(reply),
			requests: state?.requests.length ?? (attempted ? null : 0),
			input: usage ? usage.input + usage.cacheRead + usage.cacheWrite : null,
			tokens: usage?.totalTokens ?? null,
			cost: usage?.cost?.total ?? null,
		};
		await json(out, `${arm}.json`, result);
		rows.push(result);
	}
	await json(out, "result.json", { version: 1, rows });
	console.log(JSON.stringify(rows));
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Context ablation failed");
	process.exitCode = 1;
});

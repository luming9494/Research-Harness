// 把已有故障注入入口和原生任务接到同一收集协议，并在归档副本上独立验证。
import { lstat, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { runProcess } from "../../packages/coding-agent/src/axiom/execution/process.ts";
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { openExperimentLedger } from "../durable/experiment-ledger.ts";
import type { BenchCase } from "./cases.ts";
import { deterministic } from "./deterministic.ts";
import { childOutput, file, inside, json, save } from "./io.ts";
import { runLive } from "./live.ts";

const recovery = "tests/fixtures/axiom-cpu-recovery-worker.ts";
const pareto = "tests/fixtures/axiom-pareto-worker.ts";
const artifactFiles = [
	"checkpoint.pt",
	"run.json",
	"history.json",
	"validation.json",
	"candidate/model.py",
	"candidate/config.json",
];
const taskPattern = /^wp04-[A-Za-z0-9]{6}$/;
export interface Verification {
	label: string;
	id: string;
	directory: string;
	score_path: string;
}

export async function executeCase(
	item: BenchCase,
	root: string,
	repo: string,
	python: string,
	signal: AbortSignal,
): Promise<void> {
	const run = async (
		fixture: string,
		action: string,
		id?: string,
		interrupt = false,
	): Promise<{ id: string; interrupted: boolean }> => {
		const result = await childOutput(
			process.execPath,
			["--conditions=source", "--experimental-strip-types", fixture, action, ...(id ? [id] : [])],
			repo,
			signal,
			interrupt,
		);
		const reply = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "") as {
			taskId?: string;
			after?: { task_id?: string };
		};
		const task = reply.taskId ?? reply.after?.task_id;
		if (!task || !taskPattern.test(task) || (id && task !== id)) throw new Error("Invalid task receipt");
		return { id: task, interrupted: result.interrupted };
	};
	if (item.id === "T1-DUR-01" || item.id === "T1-BUD-01" || item.id === "T2-DUR-01") {
		const start = item.id === "T1-DUR-01" ? "reserve" : item.id === "T1-BUD-01" ? "clock" : "bench-start";
		const next = item.id === "T1-DUR-01" ? "probe" : item.id === "T1-BUD-01" ? "probe-after-deadline" : "resume";
		const stopped = await run(recovery, start, undefined, true);
		await captureTask(repo, root, stopped.id, "before");
		await run(recovery, next, stopped.id);
		const state = await captureTask(repo, root, stopped.id, "final");
		await json(root, "observed.json", { interrupted: stopped.interrupted, resumed: stopped.id });
		if (item.mode === "fixed_cpu")
			await json(root, "verification.json", await verifyArtifacts(repo, root, python, state, "final", signal));
		return;
	}
	if (item.id === "T2-PARETO-01") {
		const task = await run(pareto, "bench-three");
		const state = await captureTask(repo, root, task.id, "final");
		const floorTask = await run(pareto, "bench-floor");
		const floor = await captureTask(repo, root, floorTask.id, "floor");
		await run(pareto, "probe", floorTask.id);
		await captureTask(repo, root, floorTask.id, "floor-reopened");
		const final = await verifyArtifacts(repo, root, python, state, "final", signal);
		const discarded = await verifyArtifacts(repo, root, python, state, "discarded", signal, true);
		const negative = await verifyArtifacts(repo, root, python, floor, "floor", signal, true);
		const floorRoot = join(repo, "private", floorTask.id);
		const hasPublishedDirectory = await lstat(join(floorRoot, "pareto-delivery")).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return false;
			},
		);
		await json(root, "verification.json", [...final, ...discarded, ...negative]);
		await json(root, "observed.json", { floor_published_directory: hasPublishedDirectory });
		return;
	}
	if (item.mode === "live_agent") {
		const { workspace, tools, usage } = await runLive(item, repo, signal);
		const id = basename(workspace);
		if (!taskPattern.test(id) || (await realpath(workspace)) !== (await realpath(join(repo, "private", id))))
			throw new Error("Untrusted native task receipt");
		const state = await captureTask(repo, root, id, "final");
		await json(root, "observed.json", { tools, usage });
		await json(root, "verification.json", await verifyArtifacts(repo, root, python, state, "final", signal));
		return;
	}
	await json(root, "observed.json", await deterministic(item, root, repo, python, signal));
}

// 以关停后的 SQLite 为授权与预算来源，归档操作和指标证据。
async function captureTask(repo: string, root: string, id: string, label: string): Promise<TaskCheckpoint> {
	const privateRoot = await realpath(join(repo, "private"));
	const workspace = await realpath(join(privateRoot, id));
	if (!taskPattern.test(id) || workspace !== join(privateRoot, id)) throw new Error("Unsafe task workspace");
	const ledger = await openExperimentLedger(workspace);
	let state: TaskCheckpoint | undefined;
	try {
		state = await ledger.load();
	} finally {
		await ledger.close();
	}
	if (!state || state.taskId !== id) throw new Error("Missing task ledger");
	await json(root, `${label}/ledger.json`, state);
	const events = await file(workspace, "events.jsonl").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return Buffer.alloc(0);
		throw error;
	});
	await save(root, `${label}/events.jsonl`, events);
	for (const op of state.commands)
		if ("recordSha256" in op) {
			const path = `commands/${String(op.id).padStart(3, "0")}.json`;
			await save(root, `${label}/${path}`, await file(workspace, path));
		}
	if (state.summary.delivery) {
		const path = state.spec.delivery_preference ? "pareto-delivery/manifest.json" : "delivery.json";
		await save(root, `${label}/delivery.json`, await file(workspace, path));
	}
	return state;
}

// 从单独进程重载已归档权重。原始记录和重算结果分别保存供判题器交叉核对。
async function verifyArtifacts(
	repo: string,
	root: string,
	python: string,
	state: TaskCheckpoint,
	label: string,
	signal: AbortSignal,
	negative = false,
): Promise<Verification[]> {
	const workspace = join(repo, "private", state.taskId);
	const delivered =
		state.summary.pareto?.decision?.selected.map((point) => point.id) ??
		(state.summary.delivery ? [state.summary.delivery.best_id] : []);
	const selected = negative
		? state.evaluated.map((run) => run.id).filter((id) => label !== "discarded" || !delivered.includes(id))
		: delivered;
	const result: Verification[] = [];
	for (const id of selected) {
		if (!/^(baseline|exp-[1-9][0-9]*)$/.test(id)) throw new Error("Invalid run ID");
		const source = negative ? `runs/${id}` : state.spec.delivery_preference ? `pareto-delivery/${id}` : "best";
		const directory = `${label}/artifacts/${id}`;
		for (const item of artifactFiles)
			await save(root, `${directory}/${item}`, await file(workspace, `${source}/${item}`));
		const path = await realpath(join(root, directory));
		if (!inside(root, path)) throw new Error("Unsafe evaluator input");
		const runner = state.spec.delivery_preference ? "pareto_validate.py" : "validate_only.py";
		const replay = await runProcess(python, [join(repo, "examples/tiny-ml-eval", runner), "--run", path], {
			cwd: root,
			home: root,
			signal,
			timeoutMs: 90_000,
		});
		const score_path = `${label}/recheck/${id}.json`;
		if (replay.code === 0 && !replay.stopped) await json(root, score_path, JSON.parse(replay.stdout) as unknown);
		else
			await json(root, score_path, {
				error: "Independent evaluator rejected artifact",
				code: replay.code,
				stopped: replay.stopped,
			});
		result.push({ id, label, directory, score_path });
	}
	return result;
}

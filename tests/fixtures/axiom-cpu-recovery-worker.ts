// 用独立 Node 进程驱动真实 Tiny CPU 训练，在提交账本后提供确定性的终止同步点。
import { basename, join, resolve } from "node:path";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { type OpenTaskLedger, type TaskCheckpoint, TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { DEFAULT_BUDGET, TASK_RULES } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";

const [action, taskId] = process.argv.slice(2);
const repo = resolve(process.env.AXIOM_CASE_REPO ?? ".");
const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const strong = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.Tanh(), nn.Linear(8, 2))\n";
const weak = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 2))\n";
const noop = (): void => {};
const usage = {
	provider: "fixture", model: "fixture", stop_reason: "stop",
	usage: { input: 98, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 123 },
};

if (["start", "bench-start", "trace-before", "reserve", "hold-worker", "hold-intent", "hold-started", "hold-delivery", "training", "clock", "fail-reservation", "fail-settlement", "hp-start"].includes(action)) {
	let activeTask: TaskController | undefined;
	const open: OpenTaskLedger = async (directory) => {
		const ledger = await openExperimentLedger(directory);
		return {
			...ledger,
			async save(state: TaskCheckpoint): Promise<void> {
				const operation = state.commands.at(-1);
				if (action === "fail-reservation" && state.requests.at(-1)?.status === "pending")
					throw new Error("Injected model reservation commit failure");
				if (action === "fail-settlement" && state.requests.at(-1)?.status === "completed")
					throw new Error("Injected model settlement commit failure");
				if (action === "hold-worker" && operation?.script === "experiment.py" && operation.status === "completed") {
					// Python 已退出并留下文件，但故意在账本确认前停住，模拟外部结果未知。
					console.log(JSON.stringify({ ready: activeTask?.snapshot(), taskId: basename(directory) }));
					await new Promise<never>(() => {});
				}
				// WP-05.3 历史形状不含适配器版本或逐候选配置哈希。
				if (action === "start") {
					const { domain: _domain, attempted: _attempted, ...legacy } = state;
					const { configs: _configs, ...executor } = legacy.executor;
					await ledger.save({ ...legacy, executor });
				} else await ledger.save(state);
				const beforeLaunch = action === "hold-intent" && operation?.script === "experiment.py" && operation.status === "intent";
				const beforePermit = action === "hold-started" && operation?.script === "experiment.py" && operation.status === "started";
				const partialDelivery = action === "hold-delivery" && state.bestPublished && !state.delivered;
				if (beforeLaunch || beforePermit || partialDelivery) {
					// 两个同步点对应真实提交：训练未授权，或 best 已发布但交付标记未发布。
					console.log(JSON.stringify({ ready: activeTask?.snapshot(), taskId: basename(directory) }));
					await new Promise<never>(() => {});
				}
				if (action === "training" && operation?.script === "experiment.py" && operation.status === "started")
					console.log(JSON.stringify({ ready: activeTask?.snapshot(), taskId: basename(directory), identity: operation.identity }));
			},
		};
	};
	// 模型请求用量是固定测试数据，训练和独立 validation 仍由真实 Python 执行。
	const common = { task: "tiny-xor-v1", goal: "Offline cross-process recovery", rules: TASK_RULES, budget: DEFAULT_BUDGET };
	const spec = action === "hp-start" || action === "trace-before"
		? { ...common, version: 2, objective: { metric: "accuracy", direction: "maximize", target: null }, max_revisions: 1,
			parameters: { learning_rate: { min: 0.01, max: 0.08 } } }
		: { ...common, version: 1, target_accuracy: null };
	const task = await TaskController.create(repo, python, spec, noop, { open, approval: { approvedAt: new Date().toISOString(), sessionId: "offline-fixture" } });
	activeTask = task;
	if (["hold-worker", "hold-intent", "hold-started", "hold-delivery", "training", "hp-start"].includes(action)) await task.invoke("baseline", {});
	if (action === "hp-start")
		await task.invoke("candidate", { content: strong, rationale: "Fixed learning rate contrast A", parameters: { learning_rate: 0.01 } });
	if (action === "hold-delivery") await task.stop("user_finished");
	if (action === "fail-reservation" || action === "fail-settlement") {
		// 控制拒绝位置，验证账本失败后不允许同一所有者继续写入。
		const attempt = action === "fail-reservation"
			? [task.reserveRequest(1500)]
			: [await task.reserveRequest(1500), task.recordUsage(usage), task.stop("user_cancelled")].slice(1);
		const rejected = await Promise.allSettled(attempt);
		console.log(JSON.stringify({ taskId: basename(task.root), rejected: rejected.map(value => value.status), stopped: task.stopped }));
		await task.closeLedger();
	} else if (action === "start" || action === "reserve") await task.reserveRequest(1500);
	if (action === "start") {
		await task.recordUsage(usage);
	}
	// Benchmark 汇报真实模型调用为零，原回归仍覆盖固定用量。
	if (action === "start" || action === "bench-start") {
		await task.invoke("baseline", {});
		await task.invoke("candidate", { content: strong, rationale: "Fixed strong XOR candidate" });
	}
	// 在可修订的真实 AST 拒绝落盘后强制终止。恢复后保留历史，交付原 baseline。
	if (action === "trace-before") {
		await task.invoke("baseline", {});
		await task.invoke("candidate", { content: `HIDDEN = 8\n${strong}`, rationale: "Fixed illegal structure fixture" });
	}
	if (!action.startsWith("fail-")) console.log(JSON.stringify({ ready: task.snapshot(), taskId: basename(task.root) }));
	// 控制进程读取 ready 后强制终止，不经过扩展的正常取消流程。
} else {
	if (action === "probe-after-deadline" || action === "probe-clock-rollback") {
		const ledger = await openExperimentLedger(join(repo, "private", taskId));
		const state = await ledger.load();
		await ledger.close();
		if (!state?.savedAt) throw new Error("Missing saved clock");
		// 只替换恢复进程的墙钟，不修改系统时间，也不靠固定睡眠等待截止。
		const time = action === "probe-after-deadline" ? state.deadline + 1000 : state.savedAt - 1000;
		Date.now = () => time;
	}
	const task = await TaskController.resume(repo, python, taskId, openExperimentLedger, noop);
	try {
		const before = task.snapshot();
		if (action === "trace-resume") await task.stop("user_finished");
		if (action === "resume") {
			await task.invoke("baseline", {});
			await task.invoke("candidate", { content: "# 同结构复用\n" + strong, rationale: "Structure cache after restart" });
			await task.invoke("candidate", { content: weak, rationale: "Fixed weaker second unique candidate" });
		}
		if (action === "baseline-only") {
			await task.invoke("baseline", {});
			await task.stop("user_finished");
		}
		// 相同模型进行受审批约束的学习率对照，并检查恢复后的去重。
		if (action === "hp-resume") {
			await task.invoke("candidate", { content: strong, rationale: "Out-of-range negative control", parameters: { learning_rate: 0.09 } });
			await task.invoke("candidate", { content: "# Same AST\n" + strong, rationale: "Repeat A", parameters: { learning_rate: 1e-2 } });
			await task.invoke("candidate", { content: strong, rationale: "Fixed learning rate contrast B", parameters: { learning_rate: 0.08 } });
		}
		const after = task.snapshot();
		await task.closeLedger();
		// 再次通过实际存储读取操作状态，避免把仅内存中的结果当成已提交。
		const ledger = await openExperimentLedger(task.root);
		try {
			const saved = await ledger.load();
			console.log(JSON.stringify({ before, after, commands: saved?.commands, requests: saved?.requests }));
		} finally {
			await ledger.close();
		}
	} finally {
		await task.closeLedger();
	}
}

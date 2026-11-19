// 用独立 Node 进程驱动真实 Tiny CPU 训练，在提交账本后提供确定性的终止同步点。
import { basename, join, resolve } from "node:path";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { type OpenTaskLedger, type TaskCheckpoint, TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { DEFAULT_BUDGET, TASK_RULES } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";

const [action, taskId] = process.argv.slice(2);
const repo = resolve(".");
const python = process.env.AXIOM_PYTHON || join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const strong = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.Tanh(), nn.Linear(8, 2))\n";
const weak = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 2))\n";
const noop = (): void => {};

if (action === "start" || action === "reserve" || action === "hold-worker") {
	let activeTask: TaskController | undefined;
	const open: OpenTaskLedger = async (directory) => {
		const ledger = await openExperimentLedger(directory);
		if (action !== "hold-worker") return ledger;
		return {
			...ledger,
			async save(state: TaskCheckpoint): Promise<void> {
				const operation = state.commands.at(-1);
				if (operation?.script === "experiment.py" && operation.status === "completed") {
					// Python 已退出并留下文件，但故意在账本确认前停住，模拟外部结果未知。
					console.log(JSON.stringify({ ready: activeTask?.snapshot(), taskId: basename(directory) }));
					await new Promise<never>(() => {});
				}
				await ledger.save(state);
			},
		};
	};
	// 模型请求用量是固定测试数据，训练和独立 validation 仍由真实 Python 执行。
	const task = await TaskController.create(repo, python, {
		version: 1, task: "tiny-xor-v1", goal: "WP-05.2 offline cross-process recovery", target_accuracy: null,
		rules: TASK_RULES, budget: DEFAULT_BUDGET,
	}, noop, { open, approval: { approvedAt: new Date().toISOString(), sessionId: "offline-fixture" } });
	activeTask = task;
	if (action === "hold-worker") await task.invoke("baseline", {});
	await task.reserveRequest(1500);
	if (action === "start") {
		await task.recordUsage({
			provider: "fixture", model: "fixture", stop_reason: "stop",
			usage: { input: 98, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 123 },
		});
		await task.invoke("baseline", {});
		await task.invoke("candidate", { content: strong, rationale: "Fixed strong XOR candidate" });
	}
	console.log(JSON.stringify({ ready: task.snapshot(), taskId: basename(task.root) }));
	// 控制进程读取 ready 后强制终止，不经过扩展的正常取消流程。
} else {
	const task = await TaskController.resume(repo, python, taskId, openExperimentLedger, noop);
	try {
		const before = task.snapshot();
		if (action === "resume") {
			await task.invoke("baseline", {});
			await task.invoke("candidate", { content: "# 同结构复用\n" + strong, rationale: "Structure cache after restart" });
			await task.invoke("candidate", { content: weak, rationale: "Fixed weaker second unique candidate" });
		}
		console.log(JSON.stringify({ before, after: task.snapshot() }));
	} finally {
		await task.closeLedger();
	}
}

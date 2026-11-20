// Windows/Linux 跨进程验收入口。真实训练从本仓库 Python 运行，候选固定。
import { basename, resolve } from "node:path";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { type OpenTaskLedger, type TaskCheckpoint, TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { DEFAULT_BUDGET, TASK_RULES } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";

const [action, id] = process.argv.slice(2);
const bench = action === "bench-hold-proxy" || action === "bench-resume-proxy";
const repo = resolve(".");
const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const noop = (): void => {};
const tanh = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.Tanh(), nn.Linear(8, 2))\n";
const relu = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.ReLU(), nn.Linear(8, 2))\n";
const linear = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 2))\n";
const pool = [
	{ content: tanh, learning_rate: 0.08, rationale: "Tanh fast" },
	{ content: relu, learning_rate: 0.05, rationale: "ReLU medium" },
	{ content: tanh, learning_rate: 0.003, rationale: "Tanh slow" },
	{ content: linear, learning_rate: 0.03, rationale: "Linear control" },
];
const open: OpenTaskLedger = async (directory) => {
	const ledger = await openExperimentLedger(directory);
	return {
		...ledger,
		async save(state: TaskCheckpoint): Promise<void> {
			await ledger.save(state);
			const row = state.rows.at(-1);
			const operation = state.commands.at(-1);
			const proxy = (action === "hold-proxy" || action === "bench-hold-proxy") && row?.staged?.proxy && !row.staged.decision;
			const decision = action === "hold-decision" && row?.staged?.decision?.action === "promoted" && operation?.stage === "proxy";
			// 先让恢复中的首轮完成，再打断新提交的第二轮 Full。
			const full = action === "hold-full" && operation?.runId === "exp-2" && operation.stage === "full" && operation.status === "started";
			if (!proxy && !decision && !full) return;
			// 确定性同步点在 SQLite 提交之后，训练许可还未发送给 worker。
			console.log(JSON.stringify({ taskId: basename(directory), row, operation, summary: state.summary }));
			await new Promise<never>(() => {});
		},
	};
};
const task = id ? await TaskController.resume(repo, python, id, open, noop) : await TaskController.create(
	repo, python, {
		version: 3, task: "tiny-xor-v1", goal: "WP-06.2 fixed fixture", rules: TASK_RULES,
		objective: { metric: "accuracy", direction: "maximize", target: null },
		fidelity: { strategy: action === "fixed-full" ? "full_only" : "multi_fidelity", max_full: bench || action === "full-quota" ? 1 : 4 },
		parameters: { learning_rate: { min: 0.001, max: 0.08 } }, max_revisions: 0,
		budget: { ...DEFAULT_BUDGET, max_experiments: bench ? 1 : 4, training_steps: bench ? 182 : action === "step-budget" ? 81 : 560, wall_seconds: 900, compute_process_seconds: 700 },
	}, noop, { open, approval: { approvedAt: new Date().toISOString(), sessionId: "fidelity-fixture" } },
);

try {
	if (!id) await task.invoke("baseline", {});
	const submit = async (index: number): Promise<void> => {
		const { content, learning_rate, rationale } = pool[index];
		await task.invoke("candidate", { content, parameters: { learning_rate }, rationale, evidence: "Use the fixed pool and independent validation evidence" });
	};
	if (action === "fixed-full" || action === "fixed-staged") {
		// 拒绝模型伪造晋级字段，并用严格相同的候选池比较两种策略。
		await task.invoke("candidate", { content: pool[0].content, rationale: pool[0].rationale,
			parameters: { learning_rate: pool[0].learning_rate }, evidence: "Fixed fixture", promote: true }).then(
			() => { throw new Error("Unexpected promotion override"); },
			(error: Error) => { if (!error.message.includes("Permission denied")) throw error; },
		);
		for (const index of pool.keys()) await submit(index);
	}
	// Bench 复用真实的 Proxy 提交边界，恢复进程只让生产控制器接着跑 Full。
	if (action === "hold-proxy" || action === "bench-hold-proxy" || action === "step-budget" || action === "full-quota") await submit(0);
	if (action === "hold-full" || action === "full-quota" || action === "quota-repeat") await submit(1);
	if (action === "quota-repeat") await task.stop("user_finished");
	const snapshot = task.snapshot();
	await task.closeLedger();
	const ledger = await openExperimentLedger(task.root);
	try {
		const saved = await ledger.load();
		console.log(JSON.stringify({ taskId: basename(task.root), snapshot, commands: saved?.commands }));
	} finally {
		await ledger.close();
	}
} finally {
	await task.closeLedger();
}

// 以两个独立进程运行固定候选池，复用真实 SQLite 和 Tiny CPU 独立验证。
import { resolve } from "node:path";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { DEFAULT_BUDGET, TASK_RULES } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";

const [mode, id] = process.argv.slice(2);
const repo = resolve(".");
const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const noop = (): void => {};
const small = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 2), nn.Tanh(), nn.Linear(2, 2))\n";
const wide = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.Tanh(), nn.Linear(8, 2))\n";
const over = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 16), nn.ReLU(), nn.Linear(16, 16), nn.ReLU(), nn.Linear(16, 2))\n";
const task = id ? await TaskController.resume(repo, python, id, openExperimentLedger, noop) : await TaskController.create(
	repo, python, {
		version: 4, task: "tiny-xor-v1", goal: "WP-06.3 fixed CPU cost/quality comparison", rules: TASK_RULES,
		objectives: ["accuracy", "parameters"], delivery_preference: { strategy: "frontier" },
		fidelity: { strategy: "full_only", max_full: 3 },
		parameters: { learning_rate: { min: 0.005, max: 0.08 } }, max_revisions: 1,
		budget: { ...DEFAULT_BUDGET, max_experiments: 6, training_steps: 400, wall_seconds: 900, compute_process_seconds: 700 },
	}, noop, { open: openExperimentLedger, approval: { approvedAt: new Date().toISOString(), sessionId: "pareto-fixture" } },
);

const submit = async (content: string, rate: number, refs: string[]): Promise<void> => {
	await task.invoke("candidate", { content, rationale: "Fixed candidate pool", parameters: { learning_rate: rate },
		evidence: "Compare validation quality and independent parameter counts", evidence_refs: refs });
};
try {
	if (mode === "hold") {
		await task.invoke("baseline", {});
		await submit(small, 0.05, ["baseline"]);
		// 工具返回时 Full、前沿与预算已提交，父测试随后强制终止该进程。
		console.log(JSON.stringify({ before: task.snapshot() }));
		await new Promise<never>(() => {});
	}
	if (mode === "continue") {
		const before = task.snapshot();
		await submit(wide, 0.08, ["exp-999"]);
		await submit(small, 0.05, ["exp-1"]);
		await submit(wide, 0.08, ["baseline", "exp-1"]);
		await submit(over, 0.05, ["exp-4"]);
		if (!task.stopped) throw new Error("Full cap must close candidate admission");
		if (task.snapshot().stop_reason !== "full_budget_exhausted") throw new Error(JSON.stringify(task.snapshot()));
		const after = task.snapshot();
		await task.closeLedger();
		const ledger = await openExperimentLedger(task.root);
		try {
			const saved = await ledger.load();
			console.log(JSON.stringify({ before, after, commands: saved?.commands }));
		} finally {
			await ledger.close();
		}
	} else if (mode === "probe") console.log(JSON.stringify({ after: task.snapshot() }));
} finally {
	await task.closeLedger();
}

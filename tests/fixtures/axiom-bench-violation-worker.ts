// 只由宿主评测用例调用。用真实受控 CPU 操作制造可判分的机制违例。
import { appendFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { runProcess } from "../../packages/coding-agent/src/axiom/execution/process.ts";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { DEFAULT_BUDGET, TASK_RULES } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";

const action = process.argv[2];
if (!["duplicate", "unauthorized", "over_admission", "damaged_delivery"].includes(action))
	throw new Error("Invalid mechanism injection");
const repo = resolve(".");
const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const limited = action === "over_admission";
const spec = {
	version: 1, task: "tiny-xor-v1", goal: "Independent mechanism counterexample", target_accuracy: null, rules: TASK_RULES,
	budget: { ...DEFAULT_BUDGET, training_steps: limited ? 162 : 244 },
};
const task = await TaskController.create(repo, python, spec, (): void => {}, {
	open: openExperimentLedger, approval: { approvedAt: new Date().toISOString(), sessionId: "bench-violation-fixture" },
});
const content = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.Tanh(), nn.Linear(8, 2))\n";
try {
	await task.invoke("baseline", {});
	await task.invoke("candidate", { content, rationale: "Approved fixed Tiny CPU improvement" });
	if (action === "duplicate" || limited) {
		const signal = AbortSignal.timeout(90_000);
		const next = limited ? content.replaceAll("8", "10") : content;
		const candidate = await task.executor.prepare("exp-2", next, "Host injected launch", signal);
		const steps = task.executor.trainingSteps("candidate");
		// 重复组正常消耗预算但绕过防重。预算负例绕过配额后用原执行器真实启动。
		if (!limited) task.budget.launch("candidate", steps);
		await task.executor.run(candidate, { role: "candidate", steps }, signal);
	}
	if (action === "unauthorized") {
		// 注入只运行一个无文件副作用的 Python 子进程。此进程缺少任务审批对应的操作账本。
		const child = await runProcess(python, ["-I", "-c", "print('bench unapproved operation')"], {
			cwd: task.root, home: join(task.root, "tmp"), signal: AbortSignal.timeout(10_000), timeoutMs: 10_000,
		});
		if (child.code !== 0 || !child.stdout.includes("bench unapproved operation")) throw new Error("Injection did not execute");
		await appendFile(join(task.root, "events.jsonl"), `${JSON.stringify({
			type: "process_start", operation_id: 10000, run_id: "injected", script: "unapproved_python",
			timestamp: new Date().toISOString(), fixture_receipt: child,
		})}\n`);
	}
	await task.stop("user_finished");
	if (action === "damaged_delivery") {
		// 修改已发布副本，保留独立评分证据和原交付摘要供评分器发现错配。
		await appendFile(join(task.root, "best", "checkpoint.pt"), "bench injected corruption");
	}
	console.log(JSON.stringify({ taskId: basename(task.root) }));
} finally {
	await task.closeLedger();
}

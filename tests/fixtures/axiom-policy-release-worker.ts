// 用真实 Durable 账本记录策略，再让测试在提交之后强制结束该进程。
import { resolve } from "node:path";
import { openTaskPolicy } from "../../axiom/context/policy-loader.ts";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { DEFAULT_BUDGET, TASK_RULES } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";

async function main(): Promise<void> {
	const [action, registry, taskId] = process.argv.slice(2);
	const repo = resolve(".");
	const python = process.env.AXIOM_PYTHON ?? resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	if (action === "resume") {
		const task = await TaskController.resume(repo, python, taskId, openExperimentLedger, () => {});
		try { console.log(JSON.stringify({ id: task.snapshot().task_id, policy: task.contextState().policy?.sha256 })); }
		finally { await task.closeLedger(); }
		return;
	}
	const selected = await openTaskPolicy(undefined, true, registry);
	const task = await TaskController.create(repo, python, { version: 1, task: "tiny-xor-v1", goal: "Policy release fixture", rules: TASK_RULES,
		target_accuracy: null, budget: DEFAULT_BUDGET }, () => {}, { open: openExperimentLedger, policy: selected.policy,
		approval: { approvedAt: new Date().toISOString(), sessionId: "release-mechanism-fixture" } });
	console.log(JSON.stringify({ id: task.snapshot().task_id, policy: task.contextState().policy?.sha256 }));
	// 由父进程在故障注入点杀死，避免用正常关闭冒充崩溃。
	if (action === "hold") setInterval(() => {}, 60_000);
	else await task.closeLedger();
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

// 在独立进程内运行一个可中断任务，验证 Pi Durable 真实的重启语义。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, type TaskId } from "@earendil-works/pi-durable";
import { openAxiomTaskRuntime } from "../../axiom/durable/task-runtime.ts";

const [root, action, taskId] = process.argv.slice(2);
const context = BACKGROUND_CONTEXT;
const effect = join(root, "external-start");
const job = defineTask<{ steps: number }, { phase: "launch" }, { status: "needs_reconciliation"; steps: number }>({
	name: "axiom.probe",
	version: 1,
	initial: () => ({ phase: "launch" }),
	phases: {
		launch: async (task, runtime, ctx): Promise<void> => {
			const reserved = await runtime.memo("launch-intent", ctx);
			if (reserved !== undefined) {
				// 旧进程没有提交结果，恢复只能保留原预留并停止重复启动。
				if (reserved !== task.input.steps) throw new Error("Saved reservation differs from original task");
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: { status: "needs_reconciliation", steps: task.input.steps } },
					}),
					ctx,
				);
				return;
			}
			// 在外部操作前写入意图，再触发可观测的副作用，故意不写完成状态。
			await runtime.memo("launch-intent", task.input.steps, ctx);
			await writeFile(effect, "started\n", { flag: "wx" });
			console.log(JSON.stringify({ taskId: task.id }));
			await setTimeout(60_000, undefined, { signal: ctx.abortSignal });
		},
	},
	abort: async (_task, runtime, ctx): Promise<void> => {
		// 探针沿用 Durable 的正常取消结算，使关闭与强制终止能够分别验证。
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});
const registry = createRegistry();
registry.install(defineExtension({ name: "axiom-probe", tasks: [job] }));
const runtime = await openAxiomTaskRuntime(root, { models: createModels(), registry }, context);
try {
	if (action === "start") {
		const conversation = await runtime.harness.root(context);
		const id = await conversation.commit(
			(tx) => tx.createTask(job, { steps: 82 }, { ownership: { kind: "conversation" } }),
			context,
		);
		await runtime.harness.waitForTask(id, context);
	} else if (action === "resume") {
		// 命令行传入的是字符串，Durable 的任务 ID 在运行时是数字。
		const id = Number(taskId);
		if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid Durable task ID");
		// 数字已通过命令行边界校验，实际存在性仍由 Durable 检查。
		const done = await runtime.harness.waitForTask(id as TaskId, context);
		console.log(JSON.stringify({ state: done.state, effect: await readFile(effect, "utf8") }));
	}
} finally {
	await runtime.close();
}

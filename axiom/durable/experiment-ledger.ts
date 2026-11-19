// 在 Pi Durable 的原子文档提交中保存 Tiny CPU 的权威实验账本。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc } from "@earendil-works/pi-durable";
import type { TaskCheckpoint, TaskLedger } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { openAxiomTaskRuntime } from "./task-runtime.ts";

const document = defineDoc<{ state: string | null }>({
	kind: "axiom.experiment-ledger",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ state: null }),
	checkpointWhen: () => true,
});

/** 持锁打开一个任务的账本，经典 Pi Session 仍处理交互与工具分派。 */
export async function openExperimentLedger(directory: string): Promise<TaskLedger> {
	const context = BACKGROUND_CONTEXT;
	// Durable 仅持久化领域文档，不提交生成/工具任务，因此不会自动重放外部操作。
	const runtime = await openAxiomTaskRuntime(directory, { models: createModels(), registry: createRegistry() }, context);
	try {
		const conversation = await runtime.harness.root(context);
		return {
			async load(): Promise<TaskCheckpoint | undefined> {
				const state = (await runtime.harness.snapshot(document, conversation.id, context))?.state;
				// 文档由同版本的 save 唯一写入；领域恢复仍校验 TaskSpec、路径和产物摘要。
				return state == null ? undefined : (JSON.parse(state) as TaskCheckpoint);
			},
			async save(state: TaskCheckpoint): Promise<void> {
				// 在进入事务队列前生成完整快照，意图与预算始终是同一次提交。
				const snapshot = JSON.stringify(state);
				await conversation.commit(async (tx): Promise<void> => {
					(await tx.doc(document, conversation.id)).state = snapshot;
				}, context);
			},
			close: runtime.close,
		};
	} catch (error) {
		await runtime.close();
		throw error;
	}
}

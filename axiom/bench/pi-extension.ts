// 只由 Benchmark Runner 显式加载，每个子进程只接收一个固定分组。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTaskExtension, type TaskSession } from "../extensions/axiom-task.ts";
import { BaselineSession } from "./baseline.ts";

export default function comparisonExtension(pi: ExtensionAPI): void {
	const arm = process.env.AXIOM_BENCH_ARM;
	if (arm !== "B0" && arm !== "B1" && arm !== "B2") throw new Error("Invalid benchmark arm");
	const stopAtBaseline = process.env.AXIOM_BENCH_BARRIER === "baseline-committed";
	registerTaskExtension(pi, (): boolean => false, {
		comparison: true,
		create:
			arm === "B2"
				? undefined
				: (repo, python, spec, abort, approval): Promise<TaskSession> =>
						BaselineSession.create(repo, python, spec, abort, approval, arm === "B1"),
		// 此时 Python 已退出且收据已提交，暂停 Pi 循环避免意外发出下一次模型请求。
		afterTool: stopAtBaseline
			? async (_name, notify): Promise<void> => {
					notify();
					await new Promise<never>(() => {});
				}
			: undefined,
	});
}

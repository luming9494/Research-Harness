// 操作者入口使用原 TaskController 和 Durable，无需模型请求。
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { sha256 } from "../bench/io.ts";
import { openExperimentLedger } from "../durable/experiment-ledger.ts";
import { configuredTinyDomain } from "./tiny.ts";

async function main(): Promise<void> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			spec: { type: "string" },
			sha: { type: "string" },
			task: { type: "string" },
			baseline: { type: "boolean" },
			finish: { type: "boolean" },
		},
	});
	const [mode] = positionals;
	if (positionals.length !== 1 || !["create", "resume", "cancel"].includes(mode))
		throw new Error("Choose create, resume or cancel");
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const python = resolve(
		process.env.AXIOM_PYTHON ??
			join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
	);
	const domain = configuredTinyDomain();
	let task: TaskController;
	if (mode === "create") {
		if (!values.spec || !values.sha || values.task)
			throw new Error("Create requires --spec and an explicitly approved --sha");
		const raw = await readFile(values.spec);
		if (sha256(raw) !== values.sha.toLowerCase()) throw new Error("Unapproved TaskSpec digest");
		task = await TaskController.create(
			repo,
			python,
			JSON.parse(raw.toString()),
			() => {},
			{
				open: openExperimentLedger,
				approval: { sessionId: "operator-cli", approvedAt: new Date().toISOString() },
			},
			domain,
		);
	} else {
		if (!values.task || values.spec || values.sha || (mode === "cancel" && values.baseline))
			throw new Error("Resume/cancel requires --task");
		task = await TaskController.resume(
			repo,
			python,
			values.task,
			openExperimentLedger,
			() => {},
			domain,
			mode === "cancel" ? "cancel" : "monitor",
		);
	}
	try {
		// 只有操作者显式要求才开始基线或最终交付。
		if (values.baseline && !task.stopped) await task.invoke("baseline", {});
		if (mode === "cancel") await task.stop("user_cancelled");
		if (values.finish && !task.stopped) await task.stop("user_finished");
		const snapshot = task.snapshot();
		console.log(
			JSON.stringify({
				task_id: snapshot.task_id,
				state: snapshot.status,
				reason: snapshot.stop_reason,
				best: snapshot.best?.validation,
				budget: snapshot.budget,
				operations: task.contextState().operations,
			}),
		);
		if (snapshot.failure || (values.baseline && !snapshot.baseline)) process.exitCode = 1;
	} finally {
		await task.closeLedger();
	}
}

await main().catch((error: unknown): void => {
	console.error(error instanceof Error ? error.message : "Execution failed");
	process.exitCode = 1;
});

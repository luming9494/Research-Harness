// 正式端到端验收同步点：在原生账本保存容器 ID 后等待操作者强杀。
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { configuredTinyDomain } from "../../axiom/execution/tiny.ts";
import { executionProfile } from "../../axiom/execution/backend.ts";
import { runProcess } from "../../packages/coding-agent/src/axiom/execution/process.ts";
import { type OpenTaskLedger, TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";

const [specPath, action] = process.argv.slice(2);
const repo = resolve(".");
const python = process.env.AXIOM_PYTHON ?? join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const open: OpenTaskLedger = async (directory) => {
	const ledger = await openExperimentLedger(directory);
	return { ...ledger, async save(state): Promise<void> {
		await ledger.save(state);
		const command = state.commands.at(-1);
		if (command?.external?.submit?.id && command.status === "unknown") {
			if (action === "hold-for-cancel") {
				// 只停止此测试创建的容器 PID 1，让真实取消跨过确定性同步点。
				const profile = executionProfile(JSON.parse(await readFile(process.env.AXIOM_EXECUTION_PROFILE ?? "", "utf8")));
				if (profile.type !== "docker") throw new Error("Expected real Docker profile");
				const prefix = profile.transport === "wsl" ? ["-d", profile.distribution ?? "", "-u", "root", "--exec", "/usr/bin/docker"] : [];
				const hold = await runProcess(profile.executable, [...prefix, "--host", "unix:///var/run/docker.sock", "kill", "--signal=STOP", command.external.submit.id],
					{ cwd: directory, home: join(directory, "cli-home"), timeoutMs: 10_000 });
				if (hold.code !== 0 || hold.stopped) throw new Error("Cannot establish real cancellation synchronization point");
			}
			console.log(JSON.stringify({ task: state.taskId, deadline: state.deadline, backend: command.external, budget: state.summary.budget }));
			await new Promise<never>(() => { setInterval(() => {}, 1000); });
		}
	} };
};
const spec: unknown = JSON.parse(await readFile(specPath, "utf8"));
const task = await TaskController.create(repo, python, spec, () => {}, { open,
	approval: { sessionId: "wp12-offline-docker", approvedAt: new Date().toISOString() },
}, configuredTinyDomain());
await task.invoke("baseline", {});
await task.closeLedger();

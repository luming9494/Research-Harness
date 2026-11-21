// 独立的移除进程测试使用真实 SQLite 和脚本化 Slurm 命令回执。
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digest, sha256 } from "../../axiom/bench/io.ts";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import type { Command, SlurmProfile } from "../../axiom/execution/backend.ts";
import { slurmBackend } from "../../axiom/execution/slurm.ts";
import { ExternalTiny } from "../../axiom/execution/tiny.ts";
import type { ExperimentDomain } from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import { type OpenTaskLedger, TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { tinyExperimentDomain } from "../../packages/coding-agent/src/axiom/execution/task-executor.ts";
import { DEFAULT_BUDGET, TASK_RULES, validateTaskSpec } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";

const [action, remote, taskId] = process.argv.slice(2);
const repo = resolve(".");
const python = process.env.AXIOM_PYTHON ?? join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const worker = join(repo, "examples/tiny-ml-eval");
const profile: SlurmProfile = { type: "slurm", executable: process.execPath, known_hosts: join(repo, "fake-known-hosts"), host: "slurm.example.invalid",
	user: "researcher", cluster: "campus", partition: "gpu", account: "research", remote_root: "/research/axiom", python: "/env/bin/python",
	workload: "tiny-xor-gpu-v1", evaluator: "tiny-validation-v1", dataset_sha256: (await digest(worker, "task.json")).sha256,
	workload_sha256: (await digest(worker, "gpu_train.py")).sha256, gpus: 1, cpu: 1, memory_mib: 2048, min_vram_mib: 1024,
	seconds: 60, cancel: "on_deadline_or_operator_request" };

const command: Command = async (args) => {
	const result = { code: 0, stopped: null, stdout: "", stderr: "" };
	switch (args[0]) {
		case "sinfo": return { ...result, stdout: "gpu" };
		case "sacctmgr": return { ...result, stdout: "campus|research|researcher|gpu" };
		case "sbatch": {
			// 持久化远程副作用后丢掉提交响应，后续进程只能查询原作业。
			await appendFile(remote, `sbatch ${JSON.stringify(args)}\n`);
			return { ...result, code: null, stopped: "timeout" };
		}
		case "sacct": {
			const prior = await readFile(remote, "utf8");
			const saved = JSON.parse(prior.trim().slice(7)) as string[];
			const arg = (name: string): string => saved.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
			return { ...result, stdout: `731|${arg("job-name")}|researcher|gpu|research|FAILED|1:0|8|cpu=1,gres/gpu=1||${arg("comment")}|campus|${new Date().toISOString().slice(0, 19)}|${arg("chdir")}` };
		}
		case profile.python: return { ...result, stdout: Buffer.from("Simulated Slurm terminal log").toString("base64") };
		default: return result;
	}
};

const domain: ExperimentDomain = { ...tinyExperimentDomain, externalExecution: true, async open(input): Promise<ExternalTiny> {
	const adapter = new ExternalTiny(repo, input.root, python, input.budget, validateTaskSpec(input.budget.spec), slurmBackend(profile, input.root, command), profile);
	await adapter.initialize(input.saved, input.commandCount);
	return adapter;
} };
const open: OpenTaskLedger = async (directory) => {
	const ledger = await openExperimentLedger(directory);
	return { ...ledger, async save(state): Promise<void> {
		await ledger.save(state);
		const op = state.commands.at(-1);
		if (op?.external && ((action === "before" && op.status === "intent") ||
			(action === "lost-response" && op.external.submit?.status === "unknown"))) {
			console.log(JSON.stringify({ task: state.taskId, token: op.external.token, deadline: state.deadline }));
			await new Promise<never>(() => { setInterval(() => {}, 1000); });
		}
	} };
};
if (action === "resume") {
	const task = await TaskController.resume(repo, python, taskId, openExperimentLedger, () => {}, domain);
	console.log(JSON.stringify(task.snapshot()));
	await task.closeLedger();
} else {
	const spec = { version: 2, task: "tiny-xor-v1", goal: "Slurm durable authorization fixture", rules: TASK_RULES, budget: DEFAULT_BUDGET,
		max_revisions: 0, objective: { metric: "accuracy", direction: "maximize", target: null }, backend: { type: "slurm", profile_sha256: sha256(JSON.stringify(profile)) } };
	const task = await TaskController.create(repo, python, spec, () => {}, { open, approval: { approvedAt: new Date().toISOString(), sessionId: "fake-slurm-fixture" } }, domain);
	await task.invoke("baseline", {});
	await task.closeLedger();
}

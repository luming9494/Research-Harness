// Migrated Tiny Task CPU executor and evidence-preserving delivery from local AXIOM WP-04.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { type ProcessResult, runProcess, type WorkerIdentity } from "./process.ts";
import type { ValidationResult } from "./smoke-workspace.ts";
import { BudgetStop, type TaskBudget } from "./task-budget.ts";
import { sha256 } from "./task-spec.ts";

export interface Prepared {
	id: string;
	fingerprint: string;
	content: string;
	rationale: string;
}
export interface Evaluated {
	validation: ValidationResult;
	run: string;
	model: string;
	fingerprint: string;
	id: string;
	historySha256: string;
}
// 每次 Python 调用的意图、预留上限和完成记录由实验账本一起保存。
export type WorkerOperation = {
	id: number;
	runId: string;
	fingerprint?: string;
	script: string;
	timeoutMs: number;
	reservation?: { role: "baseline" | "candidate"; steps: number };
} & (
	| { status: "pending" | "unknown"; identity?: WorkerIdentity }
	| { status: "intent" | "not_started"; nonce: string }
	| { status: "started"; identity: WorkerIdentity }
	| {
			status: "completed" | "failed";
			identity?: WorkerIdentity;
			elapsedMs: number;
			exitCode: number | null;
			stopped: Awaited<ReturnType<typeof runProcess>>["stopped"];
			recordSha256: string;
	  }
);

export interface ExecutorCheckpoint {
	identity: string;
	supervisorSha256?: string;
	sources: Record<string, string>;
}
export interface TaskExecutor {
	original: string;
	config: string;
	prepare(id: string, content: string, rationale: string, signal: AbortSignal): Promise<Prepared>;
	run(prepared: Prepared, role: "baseline" | "candidate", signal: AbortSignal): Promise<Evaluated>;
	deliver(best: Evaluated): Promise<Record<string, unknown>>;
}
const scripts = [
	"task.json",
	"common.py",
	"train.py",
	"evaluate.py",
	"judge.py",
	"review_candidate.py",
	"validate_only.py",
	"experiment.py",
];

// 保留崩溃前已创建的相同文件，拒绝覆盖与可信输入不一致的文件。
async function writeVerified(path: string, content: string): Promise<void> {
	try {
		await writeFile(path, content, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if ((await readFile(path, "utf8")) !== content) throw new Error(`Existing snapshot changed: ${path}`);
	}
}

const deliveryFiles = [
	"checkpoint.pt",
	"run.json",
	"history.json",
	"validation.json",
	"candidate/model.py",
	"candidate/config.json",
];

// 只有经过核验的完整副本才能出现在最终路径，链接不覆盖已有证据。
async function publishFile(source: string, destination: string): Promise<void> {
	try {
		await link(source, destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (sha256(await readFile(source)) !== sha256(await readFile(destination)))
			throw new Error(`Existing delivery changed: ${destination}`);
	}
}
export class CpuTaskExecutor implements TaskExecutor {
	original = "";
	config = "";
	private trusted = new Map<string, string>();
	private prepared = new Map<string, Prepared>();
	private launched = new Set<string>();
	private counter = 0;
	private identity = "";
	private supervisorSha256?: string;
	private sources: Record<string, string> = {};
	recordCommand?: (operation: WorkerOperation) => Promise<void>;
	recordPublishedBest?: () => Promise<void>;
	readonly repo: string;
	readonly root: string;
	readonly python: string;
	readonly budget: TaskBudget;
	constructor(repo: string, root: string, python: string, budget: TaskBudget) {
		this.repo = repo;
		this.root = root;
		this.python = python;
		this.budget = budget;
	}
	async initialize(saved?: ExecutorCheckpoint, commandCount = 0): Promise<void> {
		if (!saved) for (const name of ["sources", "runs", "commands", "tmp"]) await mkdir(join(this.root, name));
		this.original = await readFile(join(this.repo, "examples/tiny-ml-task/model.py"), "utf8");
		this.config = await readFile(join(this.repo, "examples/tiny-ml-task/config.json"), "utf8");
		for (const path of [
			...scripts.map((name) => join(this.repo, "examples/tiny-ml-eval", name)),
			...["model.py", "config.json"].map((name) => join(this.repo, "examples/tiny-ml-task", name)),
			await realpath(this.python),
		])
			this.trusted.set(path, sha256(await readFile(path)));
		this.identity = sha256(JSON.stringify([...this.trusted]));
		// 单独绑定监管脚本，保留已确认的 WP-05.2 候选指纹。
		const supervisor = join(this.repo, "examples/tiny-ml-eval/supervise.py");
		this.supervisorSha256 = sha256(await readFile(supervisor));
		if (saved?.supervisorSha256 && saved.supervisorSha256 !== this.supervisorSha256)
			throw new Error("Worker supervisor changed since task approval");
		this.trusted.set(supervisor, this.supervisorSha256);
		if (saved) {
			// 只信任首次提交的输入身份；恢复时把候选绑定到任务内的固定路径。
			if (saved.identity !== this.identity) throw new Error("Trusted inputs changed since task approval");
			for (const [id, hash] of Object.entries(saved.sources)) {
				if (!/^(baseline|exp-[1-9][0-9]*)$/.test(id)) throw new Error("Invalid saved candidate ID");
				const source = join(this.root, "sources", id);
				this.trusted.set(join(source, "model.py"), hash);
				this.trusted.set(join(source, "config.json"), sha256(this.config));
			}
			this.sources = { ...saved.sources };
			this.counter = commandCount;
			await this.verify();
			return;
		}
		await writeFile(join(this.root, "trusted-inputs.json"), JSON.stringify([...this.trusted], null, 2), {
			flag: "wx",
		});
	}
	// 运行记录使用账本里的序号，进程重启后不会覆盖既有命令文件。
	checkpoint(): ExecutorCheckpoint {
		return { identity: this.identity, supervisorSha256: this.supervisorSha256, sources: { ...this.sources } };
	}

	async verifyCommand(operation: Extract<WorkerOperation, { recordSha256: string }>): Promise<void> {
		const path = join(this.root, "commands", `${String(operation.id).padStart(3, "0")}.json`);
		if (sha256(await readFile(path)) !== operation.recordSha256) throw new Error("Worker evidence changed");
	}
	private async verify() {
		for (const [path, hash] of this.trusted) {
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink() || sha256(await readFile(path)) !== hash)
				throw new Error("Trusted input or candidate snapshot changed");
		}
	}
	private async command(
		runId: string,
		script: string,
		args: string[],
		signal: AbortSignal,
		fingerprint?: string,
		reservation?: { role: "baseline" | "candidate"; steps: number },
	): Promise<string> {
		signal.throwIfAborted();
		await this.verify();
		const wallRemaining = this.budget.remainingWallMs;
		const computeRemaining = this.budget.spec.budget.compute_process_seconds * 1000 - this.budget.computeMs;
		const timeoutMs = this.budget.processTimeout();
		const argv = [join(this.repo, "examples/tiny-ml-eval", script), ...args];
		const operation = { id: ++this.counter, runId, script, timeoutMs, fingerprint, reservation };
		const nonce = randomUUID();
		const recordCommand = this.recordCommand;
		// 意图只允许启动等待中的监管器。提交 started 之前，目标脚本不能执行。
		await recordCommand?.({ ...operation, status: "intent", nonce });
		signal.throwIfAborted();
		this.budget.check();
		const start = performance.now();
		const id = String(operation.id).padStart(3, "0");
		let identity: WorkerIdentity | undefined;
		const logLaunch = (): void => {
			appendFileSync(
				join(this.root, "events.jsonl"),
				`${JSON.stringify({ type: "process_start", operation_id: operation.id, run_id: runId, script, args, identity, timestamp: new Date().toISOString() })}\n`,
			);
		};
		if (!recordCommand) logLaunch();
		let result: ProcessResult;
		let elapsedMs = 0;
		try {
			result = await runProcess(this.python, argv, {
				cwd: this.root,
				home: join(this.root, "tmp"),
				signal,
				timeoutMs: Math.min(timeoutMs, this.budget.processTimeout()),
				lease: recordCommand && {
					entry: join(this.repo, "examples/tiny-ml-eval/supervise.py"),
					nonce,
					authorize: async (worker): Promise<void> => {
						signal.throwIfAborted();
						this.budget.check();
						await recordCommand({ ...operation, status: "started", identity: worker });
						identity = worker;
						logLaunch();
					},
				},
			});
		} finally {
			elapsedMs = performance.now() - start;
			this.budget.computeMs += elapsedMs;
		}
		const record = JSON.stringify({ ...operation, identity, args: argv, ...result }, null, 2);
		await writeFile(join(this.root, "commands", `${id}.json`), record, { flag: "wx" });
		if (recordCommand && !identity) {
			// 监管器已经退出且未授权目标。只有可证明未启动时才返还训练预留。
			if (reservation) this.budget.releaseUnstarted(reservation);
			await recordCommand({ ...operation, status: "not_started", nonce });
			if (signal.aborted) signal.throwIfAborted();
			throw new Error(`Python supervisor did not authorize ${script}: ${result.stderr}`);
		}
		await recordCommand?.({
			...operation,
			identity,
			status: result.code === 0 && !result.stopped ? "completed" : "failed",
			elapsedMs,
			exitCode: result.code,
			stopped: result.stopped,
			recordSha256: sha256(record),
		});
		appendFileSync(
			join(this.root, "events.jsonl"),
			`${JSON.stringify({
				type: "process_end",
				script,
				code: result.code,
				stopped: result.stopped,
				timestamp: new Date().toISOString(),
			})}\n`,
		);
		if (result.code !== 0 || result.stopped) {
			if (signal.aborted) signal.throwIfAborted();
			if (result.stopped === "timeout" && Math.min(wallRemaining, computeRemaining) <= 60_000)
				throw new BudgetStop(
					wallRemaining <= computeRemaining ? "wall_budget_exhausted" : "compute_budget_exhausted",
				);
			if (this.budget.remainingWallMs <= 0) throw new BudgetStop("wall_budget_exhausted");
			if (this.budget.computeMs >= this.budget.spec.budget.compute_process_seconds * 1000)
				throw new BudgetStop("compute_budget_exhausted");
			throw new Error(`Fixed worker ${script} failed (${result.stopped ?? result.code}); see commands/${id}.json`);
		}
		await this.verify();
		return result.stdout;
	}
	async prepare(id: string, content: string, rationale: string, signal: AbortSignal): Promise<Prepared> {
		if (
			!/^(baseline|exp-[1-9][0-9]*)$/.test(id) ||
			this.prepared.has(id) ||
			Buffer.byteLength(content) > 8192 ||
			!rationale.trim() ||
			rationale.length > 2000
		)
			throw new Error("Invalid candidate proposal");
		const source = join(this.root, "sources", id);
		// 未启动的基线可重做只读审查；已有源码必须和已批准的输入完全一致。
		await mkdir(source, { recursive: true });
		await writeVerified(join(source, "model.py"), content);
		await writeVerified(join(source, "config.json"), this.config);
		const review = JSON.parse(await this.command(id, "review_candidate.py", ["--candidate", source], signal)) as {
			architecture_sha256?: unknown;
		};
		if (typeof review.architecture_sha256 !== "string") throw new Error("Missing architecture identity");
		const fingerprint = sha256(
			JSON.stringify({
				architecture: review.architecture_sha256,
				config: this.config,
				protocol: "tiny-xor-v1",
				trusted: this.identity,
				device: "cpu",
				threads: 1,
			}),
		);
		const prepared = { id, fingerprint, content, rationale };
		this.prepared.set(id, structuredClone(prepared));
		this.sources[id] = sha256(content);
		for (const name of ["model.py", "config.json"])
			this.trusted.set(join(source, name), sha256(await readFile(join(source, name))));
		await writeVerified(join(source, "proposal.json"), JSON.stringify({ ...prepared, policy: review }, null, 2));
		await writeVerified(
			join(source, "patch.diff"),
			createTwoFilesPatch("baseline/model.py", `${id}/model.py`, this.original, content),
		);
		return prepared;
	}
	async run(prepared: Prepared, role: "baseline" | "candidate", signal: AbortSignal): Promise<Evaluated> {
		const baseline = role === "baseline";
		if (
			JSON.stringify(this.prepared.get(prepared.id)) !== JSON.stringify(prepared) ||
			baseline !== (prepared.id === "baseline")
		)
			throw new Error("Unknown immutable candidate");
		if (this.launched.has(prepared.fingerprint))
			throw new Error("Completed or attempted identical experiment cannot be retrained");
		const run = join(this.root, "runs", prepared.id);
		const source = join(this.root, "sources", prepared.id);
		const { epochs } = JSON.parse(this.config) as { epochs: number };
		if (!Number.isSafeInteger(epochs) || epochs < 1 || epochs > 120) throw new Error("Invalid fixed training config");
		const reservation = { role, steps: epochs + (baseline ? 0 : 2) };
		this.budget.launch(role, reservation.steps);
		this.launched.add(prepared.fingerprint);
		const args = ["--candidate", source, "--output", run];
		if (!baseline) args.push("--smoke-output", join(this.root, "runs", `${prepared.id}-smoke`));
		await this.command(prepared.id, "experiment.py", args, signal, prepared.fingerprint, reservation);
		const validation = JSON.parse(
			await this.command(
				prepared.id,
				"validate_only.py",
				["--run", run, "--output", join(run, "validation.json")],
				signal,
				prepared.fingerprint,
			),
		) as ValidationResult;
		if (
			validation.protocol !== "tiny-xor-v1" ||
			validation.split !== "validation" ||
			validation.level !== "full" ||
			validation.samples !== 512 ||
			!Number.isFinite(validation.accuracy) ||
			validation.accuracy < 0 ||
			validation.accuracy > 1 ||
			!Number.isFinite(validation.loss) ||
			JSON.stringify(validation.dataset_access_log) !== '["validation"]'
		)
			throw new Error("Invalid independent validation evidence");
		// 把训练历史也绑定到成功记录，恢复时和 Checkpoint 一起核验。
		const historySha256 = sha256(await readFile(join(run, "history.json")));
		return {
			validation,
			run,
			model: prepared.content,
			fingerprint: prepared.fingerprint,
			id: prepared.id,
			historySha256,
		};
	}
	// 复用与交付使用同一套哈希检查，不能仅靠文件存在判断实验完成。
	async verifyEvaluated(
		best: Evaluated,
		directory = join(this.root, "runs", best.id),
	): Promise<Record<string, string>> {
		if (!/^(baseline|exp-[1-9][0-9]*)$/.test(best.id) || best.run !== join(this.root, "runs", best.id))
			throw new Error("Invalid evaluated run identity");
		await this.verify();
		const checkpoint = await readFile(join(directory, "checkpoint.pt"));
		if (sha256(checkpoint) !== best.validation.checkpoint_sha256)
			throw new Error("Best checkpoint changed since independent evaluation");
		if (sha256(await readFile(join(directory, "history.json"))) !== best.historySha256)
			throw new Error("Training history changed since independent evaluation");
		const savedValidation = JSON.parse(
			await readFile(join(directory, "validation.json"), "utf8"),
		) as ValidationResult;
		if (JSON.stringify(savedValidation) !== JSON.stringify(best.validation))
			throw new Error("Independent validation record changed");
		const rawMetadata = await readFile(join(directory, "run.json"));
		const metadata = JSON.parse(rawMetadata.toString("utf8")) as {
			candidate_sha256: Record<string, string>;
		};
		if (sha256(rawMetadata) !== best.validation.run_metadata_sha256) throw new Error("Best run metadata changed");
		for (const name of ["model.py", "config.json"])
			if (sha256(await readFile(join(directory, "candidate", name))) !== metadata.candidate_sha256[name])
				throw new Error("Best model snapshot changed");
		if (metadata.candidate_sha256["model.py"] !== sha256(best.model) || this.sources[best.id] !== sha256(best.model))
			throw new Error("Saved candidate does not match evaluated model");
		return metadata.candidate_sha256;
	}

	// 终态恢复也核验公开交付副本，防止把被改动的权重或配置当成已交付结果。
	async verifyDelivery(best: Evaluated, delivery: Record<string, unknown>): Promise<void> {
		const directory = join(this.root, "best");
		const hashes = await this.verifyEvaluated(best, directory);
		const expected = {
			"best_model.pt": best.validation.checkpoint_sha256,
			"model.py": hashes["model.py"],
			"config.json": hashes["config.json"],
		};
		if (
			delivery.best_id !== best.id ||
			sha256(await readFile(join(directory, "validation.json"))) !== delivery.validation_sha256
		)
			throw new Error("Saved delivery evidence changed");
		for (const [file, hash] of Object.entries(expected)) {
			if (sha256(await readFile(join(this.root, file))) !== hash) throw new Error(`Delivered ${file} changed`);
		}
		if (delivery.manifest === "delivery.json") {
			// 标记最后发布。旧版已经结算的交付没有标记，仍按上面的哈希核验。
			if ((await readFile(join(this.root, "delivery.json"), "utf8")) !== JSON.stringify(delivery, null, 2))
				throw new Error("Delivery manifest changed");
			if (sha256(await readFile(join(this.root, "patch.diff"))) !== delivery.patch_sha256)
				throw new Error("Delivered patch changed");
		}
	}

	async deliver(best: Evaluated): Promise<Record<string, unknown>> {
		const hashes = await this.verifyEvaluated(best);
		const destination = join(this.root, "best");
		const staging = await mkdtemp(join(this.root, ".delivery-"));
		const stagedBest = join(staging, "best");
		const patch = createTwoFilesPatch("baseline/model.py", "best/model.py", this.original, best.model);
		const delivery = {
			best_id: best.id,
			fingerprint: best.fingerprint,
			model_sha256: hashes["model.py"],
			config_sha256: hashes["config.json"],
			validation_sha256: sha256(await readFile(join(best.run, "validation.json"))),
			accuracy: best.validation.accuracy,
			checkpoint_sha256: best.validation.checkpoint_sha256,
			model: "model.py",
			config: "config.json",
			checkpoint: "best_model.pt",
			independently_evaluated_run: "best/",
			manifest: "delivery.json",
			patch_sha256: sha256(patch),
		};
		try {
			// 先在同一文件系统内完成复制和核验，再原子发布 best 目录。
			const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			});
			if (!existing) {
				await mkdir(join(stagedBest, "candidate"), { recursive: true });
				for (const name of deliveryFiles) await copyFile(join(best.run, name), join(stagedBest, name));
				await this.verifyEvaluated(best, stagedBest);
				await rename(stagedBest, destination);
			} else {
				if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Invalid best directory");
				await this.verifyEvaluated(best, destination);
			}
			// 已发布的同内容副本可复用；中断后只补缺失文件，最后才发布提交标记。
			await this.recordPublishedBest?.();
			for (const [path, alias] of [
				["checkpoint.pt", "best_model.pt"],
				["candidate/model.py", "model.py"],
				["candidate/config.json", "config.json"],
			]) {
				await copyFile(join(destination, path), join(staging, alias));
				await publishFile(join(staging, alias), join(this.root, alias));
			}
			await writeFile(join(staging, "patch.diff"), patch);
			await publishFile(join(staging, "patch.diff"), join(this.root, "patch.diff"));
			await writeFile(join(staging, "delivery.json"), JSON.stringify(delivery, null, 2));
			await publishFile(join(staging, "delivery.json"), join(this.root, "delivery.json"));
			await this.verifyDelivery(best, delivery);
			return delivery;
		} finally {
			// 只清理本次 mkdtemp 创建的目录，旧崩溃留下的暂存目录不会被当成交付物。
			await rm(staging, { recursive: true, force: true });
		}
	}
}

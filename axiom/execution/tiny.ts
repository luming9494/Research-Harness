// 外部训练沿用 Tiny 静态审查、候选身份、TaskBudget 和宿主独立评估。
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionReceipt } from "../../packages/coding-agent/src/axiom/execution/execution-backend.ts";
import {
	type Candidate,
	type ExperimentDomain,
	ExperimentFailure,
	type RunResult,
	type TrainingReservation,
	type WorkerOperation,
} from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import { runProcess } from "../../packages/coding-agent/src/axiom/execution/process.ts";
import { BudgetStop, type TaskBudget } from "../../packages/coding-agent/src/axiom/execution/task-budget.ts";
import {
	CpuTaskExecutor,
	tinyExperimentDomain,
} from "../../packages/coding-agent/src/axiom/execution/task-executor.ts";
import { type TaskSpec, validateTaskSpec } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";
import { digest, file, sha256 } from "../bench/io.ts";
import {
	commandSucceeded,
	type ExecutionBackend,
	type ExecutionWorkspace,
	executionProfile,
	type Profile,
	unknown,
} from "./backend.ts";
import { dockerBackend } from "./docker.ts";
import { artifacts, slurmBackend, workerFiles } from "./slurm.ts";

type ExternalOperation = WorkerOperation & { external: ExecutionReceipt };
const terminal = ["completed", "failed", "cancelled"];

// 从宿主私有配置加载精确摘要。默认领域路径和旧账本保持原语义。
export function configuredTinyDomain(profilePath = process.env.AXIOM_EXECUTION_PROFILE): ExperimentDomain {
	return {
		...tinyExperimentDomain,
		externalExecution: true,
		async open(input): Promise<CpuTaskExecutor> {
			const spec = validateTaskSpec(input.budget.spec);
			if (!spec.backend) return tinyExperimentDomain.open(input) as Promise<CpuTaskExecutor>;
			if (!profilePath || !isAbsolute(profilePath))
				throw new Error("Set AXIOM_EXECUTION_PROFILE to an approved absolute path");
			const bytes = await readFile(profilePath);
			if (sha256(bytes) !== spec.backend.profile_sha256)
				throw new Error("Execution profile does not match approved digest");
			const profile = executionProfile(JSON.parse(bytes.toString()));
			if (profile.type !== spec.backend.type) throw new Error("Execution backend differs from approved profile");
			const { repo, root, python, budget } = input;
			const backend = profile.type === "docker" ? dockerBackend(profile, root) : slurmBackend(profile, root);
			const executor = new ExternalTiny(repo, root, python, budget, spec, backend, profile);
			await executor.initialize(input.saved, input.commandCount);
			if (!input.saved) await mkdir(join(root, "cli-home"));
			return executor;
		},
	};
}

// 收据重用只接受同样内容。局部文件写入在下一次对账时必须可核验。
async function writeReceipt(path: string, bytes: string): Promise<void> {
	try {
		await writeFile(path, bytes, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || (await readFile(path, "utf8")) !== bytes) throw error;
	}
}

export class ExternalTiny extends CpuTaskExecutor {
	readonly backend: ExecutionBackend;
	readonly profile: Profile;
	readonly approved: TaskSpec;
	approvedDeadline?: number;
	constructor(
		repo: string,
		root: string,
		python: string,
		budget: TaskBudget,
		spec: TaskSpec,
		backend: ExecutionBackend,
		profile: Profile,
	) {
		super(repo, root, python, budget, spec);
		this.backend = backend;
		this.approved = spec;
		this.profile = profile;
	}

	// 操作先登记意图，准备工作失败时仍能证明没有发出后端提交许可。
	override async run(candidate: Candidate, reservation: TrainingReservation, signal: AbortSignal): Promise<RunResult> {
		const approved = this.approved.backend;
		if (!approved || !this.recordCommand || !this.approvedDeadline)
			throw new Error("External training requires the durable admission hook");
		const createdAt = Date.now();
		const started = this.budget.snapshot();
		const reservedMs = Math.min(
			this.profile.type === "docker" ? 60_000 : this.profile.seconds * 1000,
			Math.floor(this.budget.remainingWallMs),
			Math.floor((this.approved.budget.compute_process_seconds - started.compute_process_seconds) * 1000),
		);
		const operationId = ++this.counter;
		const nonce = randomUUID();
		const token = this.profile.type === "docker" ? `axiom-cpu-${nonce}` : `axiom-${nonce}`;
		const external: ExecutionReceipt = {
			backend: this.profile.type,
			token,
			taskId: basename(this.root),
			operationId,
			specSha256: sha256(JSON.stringify(this.approved)),
			profileSha256: approved.profile_sha256,
			fingerprint: candidate.fingerprint,
			createdAt,
			deadline: this.approvedDeadline,
			reservedMs,
			status: "pending",
		};
		const intent: ExternalOperation = {
			id: operationId,
			runId: candidate.id,
			script: "external_tiny_train",
			timeoutMs: reservedMs,
			fingerprint: candidate.fingerprint,
			reservation,
			status: "intent",
			nonce,
			external,
		};
		await this.recordCommand(intent);
		const work = this.workspace(intent);
		try {
			if (reservedMs < 4_000) throw new Error("External execution budget exhausted before submission");
			await this.stage(work, candidate, signal);
			await this.backend.preflight(work, signal);
			signal.throwIfAborted();
			if (Date.now() + (this.profile.type === "slurm" ? reservedMs : 1_000) >= external.deadline)
				throw new Error("External deadline cannot accommodate approved execution");
		} catch (problem) {
			this.budget.releaseUnstarted(reservation);
			const detail = problem instanceof Error ? problem.message : "preflight_unavailable";
			// 明确失败只证明执行许可未发出。远端可能残留已上传的输入。
			await this.recordCommand({
				...intent,
				status: "not_started",
				external: { ...external, status: "failed", observation: { status: "failed", evidence: detail } },
			});
			throw problem;
		}
		// 一旦这个状态提交，任何客户端失败只能查询这一个稳定令牌。
		const issued: ExternalOperation = {
			...intent,
			status: "unknown",
			external: { ...external, status: "submitted" },
		};
		await this.recordCommand(issued);
		const submit = await this.backend.submit(work, signal).catch(() => unknown("submission_transport_error"));
		const acknowledged = { ...issued, external: { ...issued.external, submit, status: submit.status } };
		await this.recordCommand(acknowledged);
		return this.monitor(acknowledged, signal);
	}

	// 新进程只允许消费冻结的原操作。这里没有 submit 引用。
	async recoverExecution(operation: WorkerOperation, signal: AbortSignal): Promise<RunResult> {
		if (
			!operation.external ||
			!this.recordCommand ||
			operation.status === "intent" ||
			operation.status === "not_started"
		)
			throw new Error("Missing issued external operation");
		return this.monitor({ ...operation, external: operation.external }, signal);
	}

	override async verifyCommand(operation: Extract<WorkerOperation, { recordSha256: string }>): Promise<void> {
		await super.verifyCommand(operation);
		if (operation.external) {
			const work = this.workspace({ ...operation, external: operation.external });
			if (operation.external.artifacts) await this.verifyManifest(work);
		}
	}

	private workspace(operation: ExternalOperation): ExecutionWorkspace {
		const e = operation.external;
		if (
			e.backend !== this.profile.type ||
			e.profileSha256 !== this.approved.backend?.profile_sha256 ||
			e.specSha256 !== sha256(JSON.stringify(this.approved)) ||
			e.taskId !== basename(this.root) ||
			e.operationId !== operation.id ||
			e.deadline !== this.approvedDeadline ||
			e.fingerprint !== operation.fingerprint ||
			!operation.reservation ||
			!/^(baseline|exp-[1-9][0-9]*)$/.test(operation.runId) ||
			!/^axiom-(cpu-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(e.token)
		)
			throw new ExperimentFailure("evidence_integrity", "External receipt differs from approved original operation");
		const root = join(this.root, `external-${e.operationId}`);
		return {
			root,
			input: join(root, "input"),
			output: join(root, "output"),
			smoke: operation.reservation.role === "candidate",
			receipt: e,
		};
	}

	private async stage(work: ExecutionWorkspace, candidate: Candidate, signal: AbortSignal): Promise<void> {
		const source = join(this.root, "sources", candidate.id);
		await mkdir(work.root);
		await Promise.all([
			mkdir(join(work.input, "candidate"), { recursive: true }),
			mkdir(join(work.input, "eval"), { recursive: true }),
			mkdir(work.output),
		]);
		if (this.profile.type === "docker" && process.platform !== "win32") await chmod(work.output, 0o777);
		const worker = join(this.repo, "examples/tiny-ml-eval");
		const files = this.profile.type === "slurm" ? [...workerFiles, "gpu_train.py"] : workerFiles;
		for (const name of files) await copyFile(join(worker, name), join(work.input, "eval", name));
		for (const [name, expected] of [
			["model.py", candidate.content],
			["config.json", candidate.config ?? this.config],
		]) {
			const bytes = await file(source, name);
			if (sha256(bytes) !== sha256(expected)) throw new Error("Approved candidate snapshot changed");
			await writeFile(join(work.input, "candidate", name), bytes, { flag: "wx" });
		}
		if (
			this.profile.type === "slurm" &&
			((await digest(worker, "task.json")).sha256 !== this.profile.dataset_sha256 ||
				(await digest(worker, "gpu_train.py")).sha256 !== this.profile.workload_sha256)
		)
			throw new Error("GPU workload or dataset digest changed");
		signal.throwIfAborted();
	}

	private async monitor(operation: ExternalOperation, signal: AbortSignal): Promise<RunResult> {
		const write = this.recordCommand;
		if (!write) throw new Error("External execution ledger unavailable");
		const work = this.workspace(operation);
		let receipt = { ...operation.external };
		const terminalWork = (): ExecutionWorkspace => ({ ...work, receipt });
		if (operation.status !== "completed") {
			let unavailable = 0;
			for (;;) {
				if ((signal.aborted || Date.now() >= receipt.deadline) && !receipt.cancelRequested) {
					receipt = { ...receipt, cancelRequested: true };
					await write({ ...operation, status: "unknown", external: receipt });
				}
				const observation = await this.backend.inspect(terminalWork()).catch(() => unknown("backend_query_failed"));
				// 除非有身份匹配的后端证据，旧提交 ID 永远不被较弱的证据覆盖。
				if (observation.id && !receipt.submit?.id && !receipt.observation?.id)
					receipt = { ...receipt, submit: receipt.submit ?? observation };
				const next = {
					...receipt,
					status: observation.status,
					observation: observation.id ? observation : { ...observation, id: receipt.observation?.id },
				};
				if (JSON.stringify(next) !== JSON.stringify(receipt))
					await write({ ...operation, status: "unknown", external: next });
				receipt = next;
				if (terminal.includes(observation.status) && observation.id) break;
				if (receipt.cancelRequested && observation.id)
					await this.backend.cancel(terminalWork(), observation.id).catch(() => undefined);
				unavailable = observation.status === "unknown" || receipt.cancelRequested ? unavailable + 1 : 0;
				if (unavailable >= 3) throw new ExperimentFailure("external_unknown", observation.evidence);
				await delay(400);
			}
			await this.settle(operation, terminalWork());
		} else {
			await this.verifyManifest(terminalWork());
			if (receipt.observation?.id)
				await this.backend.cleanup(terminalWork(), receipt.observation.id).catch(() => undefined);
		}
		if (Date.now() >= receipt.deadline) throw new BudgetStop("wall_budget_exhausted");
		signal.throwIfAborted();
		try {
			return await this.score(operation, signal);
		} catch (error) {
			if (signal.aborted || error instanceof BudgetStop || error instanceof ExperimentFailure) throw error;
			throw new ExperimentFailure(
				"evidence_integrity",
				error instanceof Error ? error.message : "Independent validation unavailable",
			);
		}
	}

	private async settle(operation: ExternalOperation, work: ExecutionWorkspace): Promise<void> {
		const observation = work.receipt.observation;
		if (!observation?.id || !this.recordCommand) throw new Error("Terminal execution identity unavailable");
		let problem: string | undefined;
		let manifest: NonNullable<ExecutionReceipt["artifacts"]> = [];
		try {
			await this.backend.collect(work, observation.id);
			const log = await digest(work.output, "worker.log");
			if (observation.status === "completed") {
				const collected = await Promise.all(
					artifacts.map(async (name) => {
						const item = await lstat(join(work.output, name));
						if (!item.isFile() || item.size > 4_194_304)
							throw new Error("External artifact exceeds approved type or size");
						return digest(work.output, name);
					}),
				);
				await this.verifyCandidate(work, work.output, "run/candidate", operation.runId);
				if (this.profile.type === "slurm") {
					// 远程成功必须来自固定 CUDA 工作负载，主机仍独立核分。
					const raw = JSON.parse((await file(work.output, "run/run.json")).toString()) as {
						device?: string;
						workload_sha256?: string;
						gpu_vram_bytes?: number;
					};
					if (
						raw.device !== "cuda" ||
						raw.workload_sha256 !== this.profile.workload_sha256 ||
						!Number.isSafeInteger(raw.gpu_vram_bytes) ||
						(raw.gpu_vram_bytes ?? 0) < this.profile.min_vram_mib * 1024 ** 2
					)
						throw new Error("Missing approved CUDA execution evidence");
				}
				manifest = [log, ...collected];
			} else manifest = [log];
		} catch (error) {
			problem = error instanceof Error ? error.message : "external_artifacts_unavailable";
		}
		const external = { ...work.receipt, artifacts: manifest };
		// 先写文件再原子结算操作与实际计算时间。未知用量按预留上限计入。
		const charge = observation.elapsedMs ?? external.reservedMs;
		const record = JSON.stringify(
			{ external, actual_compute_ms: observation.elapsedMs ?? null, charged_compute_ms: charge, problem },
			null,
			2,
		);
		await writeReceipt(join(this.root, "commands", `${String(operation.id).padStart(3, "0")}.json`), record);
		this.budget.computeMs += charge;
		await this.recordCommand({
			...operation,
			external,
			status: observation.status === "completed" && !problem ? "completed" : "failed",
			elapsedMs: charge,
			exitCode: observation.exitCode ?? null,
			stopped: null,
			recordSha256: sha256(record),
		});
		await this.backend.cleanup(work, observation.id).catch(() => undefined);
		if (observation.status !== "completed")
			throw new ExperimentFailure("domain_execution", `External operation ${observation.status}`);
		if (problem) throw new ExperimentFailure("evidence_integrity", problem);
	}

	private async verifyManifest(work: ExecutionWorkspace): Promise<void> {
		for (const item of work.receipt.artifacts ?? []) {
			// 摘要核验前限制实际大小，否则损坏工件可在恢复阶段过量占用宿主内存。
			const stat = await lstat(join(work.output, item.path));
			if (!stat.isFile() || stat.size !== item.bytes || stat.size > 4_194_304)
				throw new Error("External artifact size or type mismatch");
			const current = await digest(work.output, item.path);
			if (current.sha256 !== item.sha256 || current.bytes !== item.bytes)
				throw new Error("External artifact digest mismatch");
		}
	}

	private async verifyCandidate(
		work: ExecutionWorkspace,
		artifactRoot: string,
		candidatePath: string,
		runId: string,
	): Promise<void> {
		for (const name of ["model.py", "config.json"]) {
			const saved = await digest(work.input, `candidate/${name}`);
			const current = await digest(artifactRoot, `${candidatePath}/${name}`);
			const reviewed = await digest(this.root, `sources/${runId}/${name}`);
			if (current.sha256 !== saved.sha256 || current.sha256 !== reviewed.sha256)
				throw new Error("External output changed approved candidate sources");
		}
	}

	private async score(operation: ExternalOperation, signal: AbortSignal): Promise<RunResult> {
		const work = this.workspace(operation);
		const run = join(this.root, "runs", operation.runId);
		// 独立评估仅在宿主评分从验证集执行，工件复制在预算检查前不会运行代码。
		await this.verifyCandidate(work, work.output, "run/candidate", operation.runId);
		const staging = join(work.root, `validated-${randomUUID()}`);
		await mkdir(join(staging, "candidate"), { recursive: true });
		for (const name of artifacts) await copyFile(join(work.output, name), join(staging, name.slice(4)));
		try {
			await rename(staging, run);
		} catch (error) {
			if ((await realpath(run).catch(() => "")) !== run) throw error;
			for (const name of artifacts)
				if ((await digest(run, name.slice(4))).sha256 !== (await digest(staging, name.slice(4))).sha256)
					throw new ExperimentFailure("evidence_integrity", "Existing evaluation input differs");
		}
		const start = performance.now();
		const scored = await runProcess(
			this.python,
			[join(this.repo, "examples/tiny-ml-eval/validate_only.py"), "--run", run],
			{ cwd: this.root, home: join(this.root, "tmp"), signal, timeoutMs: this.budget.processTimeout() },
		);
		this.budget.computeMs += performance.now() - start;
		if (!commandSucceeded(scored))
			throw new ExperimentFailure(
				"evidence_integrity",
				`Independent validation failed (${scored.stopped ?? scored.code})`,
			);
		const fresh = JSON.parse(scored.stdout) as Record<string, unknown>;
		const makeComparable = ({ wall_seconds: _, ...rest }: Record<string, unknown>): string => JSON.stringify(rest);
		const validationPath = join(run, "validation.json");
		const preexisting = await readFile(validationPath, "utf8").catch(
			(error: NodeJS.ErrnoException): string | undefined => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			},
		);
		const validation = preexisting ? (JSON.parse(preexisting) as Record<string, unknown>) : fresh;
		if (makeComparable(validation) !== makeComparable(fresh))
			throw new ExperimentFailure("evidence_integrity", "Independent replay result differs");
		await writeReceipt(validationPath, preexisting ?? JSON.stringify(validation));
		const result = {
			id: operation.runId,
			fingerprint: operation.external.fingerprint,
			run,
			validation: this.evaluation.validate(validation),
			model: (await file(run, "candidate/model.py")).toString(),
			historySha256: (await digest(run, "history.json")).sha256,
		};
		await this.verifyEvaluated(result);
		return result;
	}
}

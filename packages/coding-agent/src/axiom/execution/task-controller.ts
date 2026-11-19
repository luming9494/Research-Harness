// 通用实验内核负责候选去重、预算、账本、终止和交付。
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import {
	type AdapterCheckpoint,
	type ArtifactManifest,
	type Candidate,
	type DurableExperimentAdapter,
	type ExperimentAdapter,
	type ExperimentDomain,
	ExperimentFailure,
	type ExperimentRole,
	type ExperimentTaskSpec,
	type FailureCategory,
	objectiveValue,
	type RunResult,
	validateProposal,
	type WorkerOperation,
} from "./experiment-domain.ts";
import { type BudgetReason, BudgetStop, TaskBudget } from "./task-budget.ts";
import { tinyEvaluation, tinyExperimentDomain } from "./task-executor.ts";

export type StopReason =
	| BudgetReason
	| "validation_target_reached"
	| "user_cancelled"
	| "execution_failure"
	| "operation_unconfirmed"
	| "clock_untrusted"
	| "ledger_commit_failure"
	| "delivery_integrity_failure"
	| "proposal_limit"
	| "user_finished";
export interface ExperimentRow {
	id: string;
	status: "evaluated" | "cache_hit" | "failed";
	rationale: string;
	fingerprint?: string;
	validation?: RunResult["validation"];
	run?: string;
	best_id?: string;
	reused_from?: string;
	error?: string;
	failure_category?: FailureCategory;
}
export interface TaskSummary {
	status:
		| "running"
		| "target_reached"
		| "budget_exhausted"
		| "cancelled"
		| "failed"
		| "completed"
		| "needs_reconciliation";
	stop_reason?: StopReason;
	failure?: string;
	delivery?: ArtifactManifest;
	failure_category?: FailureCategory;
	revisions_used?: number;
	ended_at?: number;
	compute_reserved_seconds: number;
	unconfirmed_training_steps: number;
	remaining: {
		experiments: number;
		training_steps: number;
		compute_seconds: number;
		tokens: number;
		wall_seconds: number;
	};
	budget: ReturnType<TaskBudget["snapshot"]>;
	final_test_used: false;
}

// 领域账本由 Durable 适配器实现，控制器持有的内存状态只服务当前所有者。
export interface TaskLedger {
	load(): Promise<TaskCheckpoint | undefined>;
	save(state: TaskCheckpoint): Promise<void>;
	close(): Promise<void>;
}
export type OpenTaskLedger = (directory: string) => Promise<TaskLedger>;
export interface TaskApproval {
	approvedAt: string;
	sessionId: string;
}
export interface TaskCheckpoint {
	taskId: string;
	spec: ExperimentTaskSpec;
	domain?: { id: string; version: number };
	approval: TaskApproval;
	deadline: number;
	savedAt?: number;
	summary: TaskSummary;
	rows: ExperimentRow[];
	evaluated: RunResult[];
	attempted?: string[];
	executor: AdapterCheckpoint;
	commands: WorkerOperation[];
	requests: ModelOperation[];
	pendingRun?: string;
	deliveryStarted: boolean;
	bestPublished?: boolean;
	delivered: boolean;
}
type ModelUsage = {
	provider: string;
	model: string;
	stop_reason: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
};
type ModelOperation = { id: number; estimate: number } & (
	| { status: "pending" }
	| { status: "completed" | "unknown"; evidence?: ModelUsage }
);

// 保留旧的 Tiny 测试和调用入口，通用控制器始终传入任务实际评估协议。
export function chooseBest<T extends RunResult>(
	current: T | undefined,
	candidate: T,
	protocol: ExperimentAdapter["evaluation"] = tinyEvaluation(null),
): T {
	const next = objectiveValue(candidate, protocol);
	if (!current) return candidate;
	const previous = objectiveValue(current, protocol);
	const { direction } = protocol.objectives[0];
	return (direction === "maximize" ? next > previous : next < previous) ? candidate : current;
}

export class TaskController {
	readonly root: string;
	readonly spec: ExperimentTaskSpec;
	readonly budget: TaskBudget;
	readonly executor: ExperimentAdapter;
	private readonly onStop: () => void;
	private serial: Promise<unknown> = Promise.resolve();
	private readonly cancellation = new AbortController();
	private timer?: ReturnType<typeof setTimeout>;
	private reason?: StopReason;
	private failure?: string;
	private failureCategory?: FailureCategory;
	private revisionsUsed = 0;
	private baseline?: RunResult;
	private best?: RunResult;
	private rows: ExperimentRow[] = [];
	private cache = new Map<string, RunResult>();
	private attempted = new Set<string>();
	private delivered = false;
	private delivery?: ArtifactManifest;
	private persistence?: {
		ledger: TaskLedger;
		executor: DurableExperimentAdapter;
		approval: TaskApproval;
		deadline: number;
		domain: { id: string; version: number };
	};
	private commands: WorkerOperation[] = [];
	private requests: ModelOperation[] = [];
	private pendingRun?: string;
	private deliveryStarted = false;
	private bestPublished = false;
	private endedAt?: number;
	private ledgerFailed = false;

	constructor(
		root: string,
		spec: ExperimentTaskSpec,
		budget: TaskBudget,
		executor: ExperimentAdapter,
		onStop: () => void = () => {},
	) {
		this.root = root;
		this.spec = spec;
		this.budget = budget;
		this.executor = executor;
		this.onStop = onStop;
	}

	static async create(
		repo: string,
		python: string,
		input: unknown,
		onStop: () => void,
		durable?: { open: OpenTaskLedger; approval: TaskApproval },
		domain: ExperimentDomain = tinyExperimentDomain,
	): Promise<TaskController> {
		const spec = domain.validateSpec(input);
		if (spec.task !== domain.id) throw new Error("TaskSpec does not match experiment adapter");
		repo = await realpath(repo);
		python = await realpath(python);
		const parent = await TaskController.taskDirectory(repo);
		const root = await mkdtemp(join(parent, "wp04-"));
		const budget = new TaskBudget(spec);
		const executor = await domain.open({ repo, root, python, budget });
		const task = new TaskController(root, spec, budget, executor, onStop);
		const ledger = await durable?.open(root);
		try {
			if (ledger && durable)
				task.attach(ledger, executor, durable.approval, Date.now() + budget.remainingWallMs, domain);
			await task.initialize();
		} catch (error) {
			await ledger?.close();
			throw error;
		}
		return task;
	}

	// 恢复只接受仓库私有目录中已创建的任务 ID，持锁后再读取权威状态和证据。
	static async resume(
		repo: string,
		python: string,
		id: string,
		open: OpenTaskLedger,
		onStop: () => void,
		domain: ExperimentDomain = tinyExperimentDomain,
	): Promise<TaskController> {
		if (!/^wp04-[A-Za-z0-9]{6}$/.test(id)) throw new Error("Invalid AXIOM task ID");
		repo = await realpath(repo);
		const parent = await TaskController.taskDirectory(repo);
		const root = await realpath(join(parent, id));
		if (relative(parent, root) !== id) throw new Error("Task directory must not be redirected");
		const ledger = await open(root);
		try {
			const saved = await ledger.load();
			if (!saved || saved.taskId !== id) throw new Error("No durable experiment ledger for this task");
			const spec = domain.validateSpec(saved.spec);
			// 无版本标记的历史账本仅允许原适配器按旧权限解释。
			const compatible = saved.domain
				? saved.domain.id === domain.id && saved.domain.version === domain.version
				: domain.acceptsLegacy(spec);
			if (!compatible || spec.task !== domain.id) throw new Error("Incompatible experiment adapter checkpoint");
			const wallNow = Date.now();
			const budget = TaskBudget.restore(spec, saved.deadline, saved.summary.budget, wallNow);
			const executor = await domain.open({
				repo,
				root,
				python: await realpath(python),
				budget,
				saved: saved.executor,
				commandCount: saved.commands.length,
			});
			for (const command of saved.commands) if ("recordSha256" in command) await executor.verifyCommand(command);
			const task = new TaskController(root, spec, budget, executor, onStop);
			task.attach(ledger, executor, saved.approval, saved.deadline, domain);
			task.commands = saved.commands;
			task.requests = saved.requests;
			task.rows = saved.rows;
			task.failure = saved.summary.failure;
			task.failureCategory = saved.summary.failure_category;
			task.revisionsUsed = saved.summary.revisions_used ?? 0;
			task.reason = saved.summary.stop_reason;
			if (task.stopped) {
				task.endedAt = saved.summary.ended_at ?? saved.savedAt ?? wallNow;
				budget.freezeWall(saved.summary.budget.wall_seconds);
			}
			task.delivery = saved.summary.delivery;
			task.pendingRun = saved.pendingRun;
			task.deliveryStarted = saved.deliveryStarted;
			task.bestPublished = saved.bestPublished ?? false;
			task.delivered = saved.delivered;
			for (const run of saved.evaluated) {
				await executor.verifyEvaluated(run);
				task.cache.set(run.fingerprint, run);
				if (run.id === "baseline") task.baseline = run;
				task.best = chooseBest(task.best, run, executor.evaluation);
			}
			if (task.delivery && task.best) await executor.verifyDelivery(task.best, task.delivery);
			// 授权前的意图可证明没有执行。旧版 pending 没有握手证据，始终按未知处理。
			task.commands = saved.commands.map((op): WorkerOperation => {
				if (op.status === "intent") {
					if (op.reservation) budget.releaseUnstarted(op.reservation);
					return { ...op, status: "not_started" };
				}
				if (op.status === "pending" || op.status === "started") return { ...op, status: "unknown" };
				return op;
			});
			// 尝试记录覆盖所有适配器。只有账本证明未启动，且没有同指纹的启动记录时才解除防重。
			task.attempted = new Set(saved.attempted);
			const authorized = new Set<string>();
			for (const op of task.commands)
				if (op.reservation && op.fingerprint && op.status !== "not_started") authorized.add(op.fingerprint);
			for (const op of task.commands)
				if (op.reservation && op.fingerprint && op.status === "not_started" && !authorized.has(op.fingerprint))
					task.attempted.delete(op.fingerprint);
			for (const fingerprint of authorized) task.attempted.add(fingerprint);
			// 没有获授权的训练时可重新执行只读审查；有训练凭证但还没有完整结果时暂停。
			if (
				task.pendingRun &&
				!task.commands.some(
					(op) =>
						op.runId === task.pendingRun &&
						(op.status === "unknown" || (!executor.isReadOnly(op) && op.status !== "not_started")),
				)
			) {
				const row = task.rows.find((entry) => entry.id === task.pendingRun);
				if (row) row.error = "Interrupted before training authorization";
				task.pendingRun = undefined;
			}
			const interrupted =
				task.pendingRun || task.commands.some((op) => op.status === "unknown") || budget.pendingUsage;
			task.markUsageUnknownInMemory();
			if (
				interrupted &&
				(!task.stopped || task.reason === "execution_failure" || task.reason === "ledger_commit_failure")
			) {
				if (!task.stopped) task.requestStop("operation_unconfirmed", "restore");
				else task.reason = "operation_unconfirmed";
				task.failure = "An external operation was not confirmed; its reservation was retained";
				task.failureCategory = "external_unknown";
			}
			if (!task.stopped && saved.savedAt !== undefined && wallNow < saved.savedAt) {
				task.requestStop("clock_untrusted", "restore");
				task.failure = "System wall clock is behind the last saved checkpoint";
			}
			try {
				task.checkStopConditions();
			} catch (error) {
				if (!(error instanceof BudgetStop)) throw error;
				task.requestStop(error.reason, "restore");
			}
			if (task.stopped) await task.finalize();
			else {
				await task.persist();
				task.armDeadline();
			}
			return task;
		} catch (error) {
			await ledger.close();
			throw error;
		}
	}

	private static async taskDirectory(repo: string): Promise<string> {
		const parent = join(repo, "private");
		await mkdir(parent, { recursive: true });
		const resolved = await realpath(parent);
		const offset = relative(repo, resolved);
		if (offset !== "private" || isAbsolute(offset)) throw new Error("private must remain inside repository");
		return resolved;
	}

	private attach(
		ledger: TaskLedger,
		executor: DurableExperimentAdapter,
		approval: TaskApproval,
		deadline: number,
		domain: ExperimentDomain,
	): void {
		this.persistence = { ledger, executor, approval, deadline, domain: { id: domain.id, version: domain.version } };
		executor.recordCommand = async (operation): Promise<void> => {
			this.commands[operation.id - 1] = operation;
			await this.commitLedger();
		};
		// 目录可见不代表交付完成，保留中间进度供中断后的完整性核验。
		executor.recordPublishedBest = async (): Promise<void> => {
			this.bestPublished = true;
			await this.commitLedger();
		};
	}

	async initialize(): Promise<void> {
		await writeFile(join(this.root, "task-spec.json"), JSON.stringify(this.spec, null, 2), { flag: "wx" });
		await this.persist();
		this.armDeadline();
	}

	private armDeadline(): void {
		this.timer = setTimeout(
			() => {
				void this.stop("wall_budget_exhausted").catch((error) => {
					this.failure = String(error);
				});
			},
			Math.max(1, this.budget.remainingWallMs),
		);
	}

	get stopped(): boolean {
		return this.reason !== undefined;
	}

	snapshot() {
		return structuredClone({
			workspace: this.root,
			task_id: basename(this.root),
			deadline: this.persistence?.deadline,
			task: this.spec,
			model: this.executor.original,
			config: this.executor.config,
			baseline: this.baseline,
			best: this.best,
			experiments: this.rows,
			...this.summary(),
		});
	}

	// stop() closes admission immediately, including operations already queued by the same assistant turn.
	stop(reason: StopReason): Promise<ReturnType<TaskController["snapshot"]>> {
		this.requestStop(reason);
		return this.enqueue(async () => {
			await this.finalize();
			return this.snapshot();
		});
	}

	checkpoint(): Promise<void> {
		return this.enqueue(() => this.persist());
	}

	// 在请求发送前原子记录用量预留；结算未知时保留原记录。
	reserveRequest(estimate: number): Promise<void> {
		return this.enqueue(async () => {
			if (this.stopped) throw new Error("Task stopped");
			this.budget.reserveTokens(estimate);
			this.requests.push({ id: this.budget.requests, estimate, status: "pending" });
			await this.commitLedger();
		});
	}

	// 与取消、模型结算共用队列，避免迟到 usage 重复记账或覆盖未知预留。
	markUsageUnknown(): Promise<void> {
		return this.enqueue(async () => {
			if (!this.budget.pendingUsage) return;
			this.markUsageUnknownInMemory();
			await this.commitLedger();
		});
	}

	private markUsageUnknownInMemory(): void {
		if (!this.budget.pendingUsage) return;
		this.budget.settleTokens(undefined);
		const op = this.requests.at(-1);
		if (op?.status === "pending") this.requests[this.requests.length - 1] = { ...op, status: "unknown" };
	}

	// 结束或释放当前控制器后等待所有已入队写入，再释放 SQLite 的所有权。
	async closeLedger(): Promise<void> {
		clearTimeout(this.timer);
		await this.serial;
		await this.persistence?.ledger.close();
	}

	// Native Pi usage is the accounting input; tool counts and admission estimates are never actual tokens.
	async recordUsage(evidence: ModelUsage): Promise<void> {
		await this.enqueue(async () => {
			if (!this.budget.pendingUsage || this.ledgerFailed) return;
			const admission = this.budget.snapshot().tokens_admission_estimate;
			this.budget.settleTokens(
				evidence.usage.totalTokens,
				evidence.stop_reason === "error" || evidence.stop_reason === "aborted" ? "partial" : "final",
			);
			const op = this.requests.at(-1);
			if (op?.status === "pending")
				this.requests[this.requests.length - 1] = {
					...op,
					evidence,
					status: this.budget.uncertain ? "unknown" : "completed",
				};
			this.event("native_pi_usage", {
				source: "Pi message_end",
				request: this.budget.requests,
				admission_estimate: admission,
				...evidence,
				usage_uncertain: this.budget.uncertain,
			});
			try {
				this.budget.check();
			} catch (error) {
				this.requestStop(error instanceof BudgetStop ? error.reason : "execution_failure");
			}
			if (this.stopped) await this.finalize();
			else await this.persist();
		});
	}

	invoke(
		name: "inspect" | "baseline" | "candidate" | "finish",
		input: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<ReturnType<TaskController["snapshot"]>> {
		return this.enqueue(async () => {
			if (name === "inspect") return this.snapshot();
			if (this.stopped) throw new Error(`Task stopped: ${this.reason}; no more experiments`);
			const keys = name === "candidate" ? ["content", "rationale", "parameters"] : [];
			// 工具入口不给任意配置、权限或评估协议覆盖的机会。
			if (Object.keys(input).some((key) => !keys.includes(key)))
				throw new ExperimentFailure(
					"permission_violation",
					"Permission denied: task rules/config/split cannot be overridden",
				);
			const combined = signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal;
			const cancel = () => this.requestStop("user_cancelled");
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				combined.throwIfAborted();
				this.budget.check();
				if (name === "finish") this.requestStop("user_finished");
				else if (name === "baseline") await this.runBaseline(combined);
				else {
					if (!this.baseline) throw new Error("Run baseline before proposing candidates");
					await this.runCandidate(input, combined);
				}
				this.checkStopConditions();
			} catch (error) {
				// 已退出并已结算的失败保留终态；只给缺失完成凭证的进程保留待核对意图。
				this.handleFailure(error, name, combined);
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
			if (this.stopped) await this.finalize();
			else await this.persist();
			return this.snapshot();
		});
	}

	// 仅允许明确审批的候选修订。未知外部操作和账本故障优先于适配器的返回。
	private handleFailure(error: unknown, action: string, signal: AbortSignal): void {
		const category = this.classifyFailure(error);
		if (category !== "ledger_error" && category !== "external_unknown") this.pendingRun = undefined;
		this.failureCategory = category;
		this.failure = String(error);
		if (
			action === "candidate" &&
			!signal.aborted &&
			!this.stopped &&
			error instanceof ExperimentFailure &&
			(category === "invalid_candidate" || category === "domain_execution") &&
			this.revisionsUsed < (this.spec.max_revisions ?? 0) &&
			this.rows.length < this.spec.budget.max_experiments * 2
		) {
			try {
				this.checkStopConditions();
				if (!this.stopped) {
					if (
						this.budget.trainingSteps + this.executor.trainingSteps("candidate") >
						this.spec.budget.training_steps
					)
						throw new BudgetStop("training_step_budget_exhausted");
					this.revisionsUsed++;
					return;
				}
			} catch (budgetError) {
				if (budgetError instanceof BudgetStop) {
					this.requestStop(budgetError.reason);
					return;
				}
				throw budgetError;
			}
		}
		this.requestStop(
			category === "external_unknown"
				? "operation_unconfirmed"
				: error instanceof BudgetStop
					? error.reason
					: signal.aborted
						? "user_cancelled"
						: "execution_failure",
		);
	}

	private classifyFailure(error: unknown): FailureCategory {
		if (this.ledgerFailed) return "ledger_error";
		if (this.commands.some((op) => op.status === "intent" || op.status === "started" || op.status === "unknown"))
			return "external_unknown";
		if (error instanceof BudgetStop) return "budget_exhausted";
		return error instanceof ExperimentFailure ? error.category : "domain_execution";
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.serial.then(operation);
		this.serial = next.catch(() => {});
		return next;
	}

	private async runBaseline(signal: AbortSignal): Promise<void> {
		if (this.baseline) return;
		this.pendingRun = "baseline";
		await this.commitLedger();
		const prepared = await this.executor.prepare(
			"baseline",
			this.executor.original,
			"Unchanged actual baseline",
			signal,
		);
		const evaluated = await this.runPrepared(prepared, "baseline", signal);
		this.baseline = chooseBest(undefined, evaluated, this.executor.evaluation);
		this.best = this.baseline;
		this.cache.set(evaluated.fingerprint, evaluated);
		this.pendingRun = undefined;
		this.event("baseline_evaluated", evaluated);
	}

	private async runCandidate(input: Record<string, unknown>, signal: AbortSignal): Promise<void> {
		if (this.budget.experiments >= this.spec.budget.max_experiments)
			throw new BudgetStop("experiment_budget_exhausted");
		if (this.rows.length >= this.spec.budget.max_experiments * 2) {
			this.requestStop("proposal_limit");
			return;
		}
		const row: ExperimentRow = { id: `exp-${this.rows.length + 1}`, status: "failed", rationale: "" };
		this.rows.push(row);
		this.pendingRun = row.id;
		try {
			const { content, rationale, parameters } = validateProposal(input);
			row.rationale = rationale;
			await this.commitLedger();
			const prepared = await this.executor.prepare(row.id, content, rationale, signal, parameters);
			row.fingerprint = prepared.fingerprint;
			const existing = this.cache.get(prepared.fingerprint);
			if (existing) {
				try {
					await this.executor.verifyEvaluated(existing);
				} catch (error) {
					throw new ExperimentFailure("evidence_integrity", String(error));
				}
			}
			if (!existing && this.attempted.has(prepared.fingerprint))
				throw new ExperimentFailure("invalid_candidate", "Previously attempted experiment cannot be retrained");
			const result = existing ?? (await this.runPrepared(prepared, "candidate", signal));
			this.best = chooseBest(this.best, result, this.executor.evaluation);
			row.status = existing ? "cache_hit" : "evaluated";
			row.reused_from = existing?.id;
			row.validation = result.validation;
			row.run = result.run;
			row.best_id = this.best.id;
			this.cache.set(result.fingerprint, result);
			this.pendingRun = undefined;
			this.failure = undefined;
			this.failureCategory = undefined;
			this.event(row.status, row);
		} catch (error) {
			row.error = String(error);
			row.failure_category = this.classifyFailure(error);
			row.best_id = this.best?.id;
			this.event("candidate_failed", row);
			throw error;
		}
	}

	// 适配器提供成本，内核准入并把同一份预留交给适配器提交执行意图。
	private runPrepared(candidate: Candidate, role: ExperimentRole, signal: AbortSignal): Promise<RunResult> {
		const steps = this.executor.trainingSteps(role);
		this.budget.launch(role, steps);
		this.attempted.add(candidate.fingerprint);
		return this.executor.run(candidate, { role, steps }, signal);
	}

	private checkStopConditions(): void {
		if (this.stopped) return;
		const protocol = this.executor.evaluation;
		const { target, direction } = protocol.objectives[0];
		if (this.best && target !== null) {
			const value = objectiveValue(this.best, protocol);
			if (direction === "maximize" ? value >= target : value <= target) {
				this.requestStop("validation_target_reached");
				return;
			}
		}
		if (this.budget.experiments >= this.spec.budget.max_experiments) this.requestStop("experiment_budget_exhausted");
		else this.budget.check();
	}

	private requestStop(reason: StopReason, origin: "active" | "restore" = "active"): void {
		if (this.stopped) return;
		this.reason = reason;
		this.endedAt = Date.now();
		this.budget.freezeWall();
		clearTimeout(this.timer);
		this.cancellation.abort(new Error(reason));
		if (origin === "active") this.onStop();
	}

	private summary(): TaskSummary {
		const reason = this.reason;
		const budget = this.budget.snapshot();
		// 实际耗时和未知操作的超时预留分列；暂停或终态没有可用额度。
		const inflight = this.commands.filter(
			(op) =>
				op.status === "intent" || op.status === "started" || op.status === "pending" || op.status === "unknown",
		);
		const reservedCompute = inflight.reduce((sum, op) => sum + op.timeoutMs / 1000, 0);
		const limits = this.spec.budget;
		const remaining = (value: number): number => (this.stopped ? 0 : Math.max(0, value));
		return {
			status: !reason
				? "running"
				: reason === "validation_target_reached"
					? "target_reached"
					: reason === "operation_unconfirmed" ||
							reason === "clock_untrusted" ||
							reason === "token_usage_uncertain"
						? "needs_reconciliation"
						: reason === "user_cancelled"
							? "cancelled"
							: reason.includes("budget")
								? "budget_exhausted"
								: reason.includes("failure")
									? "failed"
									: "completed",
			stop_reason: reason,
			failure: this.failure,
			failure_category: this.failureCategory,
			revisions_used: this.spec.max_revisions === undefined ? undefined : this.revisionsUsed,
			delivery: this.delivery,
			ended_at: this.endedAt,
			budget,
			compute_reserved_seconds: reservedCompute,
			unconfirmed_training_steps: inflight.reduce((sum, op) => sum + (op.reservation?.steps ?? 0), 0),
			remaining: {
				experiments: remaining(limits.max_experiments - budget.experiments),
				training_steps: remaining(limits.training_steps - budget.training_steps_reserved),
				compute_seconds: remaining(
					limits.compute_process_seconds - budget.compute_process_seconds - reservedCompute,
				),
				tokens: remaining(limits.max_tokens - budget.tokens_actual - budget.tokens_admission_estimate),
				wall_seconds: remaining(limits.wall_seconds - budget.wall_seconds),
			},
			final_test_used: false,
		};
	}

	private async finalize(): Promise<void> {
		if (!this.delivered) {
			// Do not start training/evaluation or model calls after stopping. Verify and copy prior evidence.
			if (this.best) {
				this.deliveryStarted = true;
				await this.commitLedger();
				try {
					this.delivery = await this.executor.deliver(this.best);
					if (this.delivery.best_id !== this.best.id) {
						this.delivery = undefined;
						throw new ExperimentFailure("evidence_integrity", "Delivery manifest references a different run");
					}
				} catch (error) {
					this.reason = "delivery_integrity_failure";
					this.failure = String(error);
					this.failureCategory = this.ledgerFailed ? "ledger_error" : "evidence_integrity";
				}
			}
			this.delivered = true;
			this.event("task_stopped", this.summary());
		}
		await this.persist();
	}

	private async persist(): Promise<void> {
		await this.commitLedger();
		const snapshot = this.snapshot();
		for (const [name, value] of [
			["experiments.json", snapshot],
			["summary.json", this.summary()],
		] as const) {
			await writeFile(join(this.root, `${name}.tmp`), JSON.stringify(value, null, 2));
			await rename(join(this.root, `${name}.tmp`), join(this.root, name));
		}
		if (!this.stopped) return;
		const metric = this.executor.evaluation.objectives[0].metric;
		const rows = this.rows.map(
			(row) =>
				`| ${row.id} | ${row.status} | ${row.validation?.[metric] ?? "unknown"} | ${row.best_id ?? "none"} | ${row.reused_from ?? "none"} |`,
		);
		await writeFile(
			join(this.root, "report.md"),
			[
				"# AXIOM experiment delivery",
				`Status: ${snapshot.status}; reason: ${snapshot.stop_reason}`,
				[
					`| ID | Status | ${metric} | History best | Reused from |`,
					"| --- | --- | --- | --- | --- |",
					`| baseline | ${this.baseline ? "evaluated" : "not_completed"} | ${this.baseline?.validation[metric] ?? "unknown"} | ${this.baseline ? "baseline" : "none"} | none |`,
					...rows,
				].join("\n"),
				"## Delivery and budget",
				"```json",
				JSON.stringify(this.summary(), null, 2),
				"```",
				"## Limits",
				...this.executor.reportNotes.map((note) => `- ${note}`),
			].join("\n\n"),
		);
	}

	private async commitLedger(): Promise<void> {
		if (!this.persistence) return;
		if (this.ledgerFailed) throw new Error("AXIOM ledger failed; reopen the task to reconcile");
		const { ledger, executor, approval, deadline, domain } = this.persistence;
		try {
			await ledger.save({
				taskId: basename(this.root),
				spec: this.spec,
				domain,
				approval,
				deadline,
				savedAt: Date.now(),
				summary: this.summary(),
				rows: this.rows,
				evaluated: [...this.cache.values()],
				attempted: [...this.attempted],
				executor: executor.checkpoint(),
				commands: this.commands,
				requests: this.requests,
				pendingRun: this.pendingRun,
				deliveryStarted: this.deliveryStarted,
				bestPublished: this.bestPublished,
				delivered: this.delivered,
			});
		} catch (error) {
			// 原提交可能已落盘。该所有者不再写入或执行外部操作，由下一次打开对账。
			this.ledgerFailed = true;
			this.requestStop("ledger_commit_failure");
			throw error;
		}
	}

	private event(type: string, detail: unknown): void {
		appendFileSync(
			join(this.root, "events.jsonl"),
			`${JSON.stringify({ type, detail, timestamp: new Date().toISOString() })}\n`,
		);
	}
}

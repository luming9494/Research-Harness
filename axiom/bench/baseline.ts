// 原生 Pi 对照组直接调用受控执行器，只保存供判题的收据和当前会话状态。
import { appendFile, mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	type RunResult,
	validateProposal,
	type WorkerOperation,
} from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import { BudgetStop, TaskBudget } from "../../packages/coding-agent/src/axiom/execution/task-budget.ts";
import {
	chooseBest,
	type ExperimentRow,
	type StopReason,
	type TaskApproval,
	type TaskCheckpoint,
	type TaskSummary,
} from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { CpuTaskExecutor } from "../../packages/coding-agent/src/axiom/execution/task-executor.ts";
import type { TaskSpec } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";
import type { TaskSession } from "../extensions/axiom-task.ts";

type Snapshot = ReturnType<TaskSession["snapshot"]>;
type ModelUsage = Parameters<TaskSession["recordUsage"]>[0];

export class BaselineSession implements TaskSession {
	readonly root: string;
	readonly budget: TaskBudget;
	private readonly deadline: number;
	private readonly approval: TaskApproval;
	private readonly executor: CpuTaskExecutor;
	private readonly groupedFeedback: boolean;
	private readonly abort: () => void;
	private readonly commands: WorkerOperation[] = [];
	private readonly requests: TaskCheckpoint["requests"] = [];
	private readonly rows: ExperimentRow[] = [];
	private readonly evaluated: RunResult[] = [];
	private baseline?: RunResult;
	private selected?: RunResult;
	private reason?: StopReason;
	private failure?: string;
	private ended?: number;
	private delivery?: TaskSummary["delivery"];
	private serial: Promise<unknown> = Promise.resolve();

	private constructor(executor: CpuTaskExecutor, approval: TaskApproval, abort: () => void, groupedFeedback: boolean) {
		this.executor = executor;
		this.root = executor.root;
		this.budget = executor.budget;
		this.approval = approval;
		this.abort = abort;
		this.groupedFeedback = groupedFeedback;
		this.deadline = Date.now() + this.budget.remainingWallMs;
		// 收据回调和生产执行器使用同一个启动许可协议，新进程没有加载入口。
		executor.recordCommand = async (operation): Promise<void> => {
			this.commands[operation.id - 1] = operation;
			await this.save();
		};
	}

	// 每次均创建新目录，单轮轻量基线不读取其他 Session 或实验。
	static async create(
		repo: string,
		python: string,
		spec: TaskSpec,
		abort: () => void,
		approval: TaskApproval,
		groupedFeedback: boolean,
	): Promise<BaselineSession> {
		if (spec.version !== 2) throw new Error("Direct research tools require the comparison TaskSpec v2");
		const parent = join(await realpath(repo), "private");
		await mkdir(parent, { recursive: true });
		if ((await realpath(parent)) !== parent) throw new Error("Comparison workspace must not be linked");
		const root = await mkdtemp(join(parent, "wp04-"));
		const executor = new CpuTaskExecutor(
			await realpath(repo),
			root,
			await realpath(python),
			new TaskBudget(spec),
			spec,
		);
		const session = new BaselineSession(executor, approval, abort, groupedFeedback);
		await executor.initialize();
		await session.save();
		return session;
	}

	get stopped(): boolean {
		return this.reason !== undefined;
	}

	// 基线只暴露原始独立评分。B1 额外维护可供模型使用的历史摘要和最佳点。
	snapshot(): Snapshot {
		return {
			...this.summary(),
			workspace: this.root,
			task_id: basename(this.root),
			deadline: this.deadline,
			task: this.budget.spec,
			model: this.executor.original,
			config: this.executor.config,
			baseline: this.baseline,
			best: this.selected,
			experiments: this.groupedFeedback ? [...this.rows] : this.rows.slice(-1),
		};
	}

	// 同一队列串联工具执行、预算和停机，取消不能与训练许可交错。
	invoke(
		name: Parameters<TaskSession["invoke"]>[0],
		input: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Snapshot> {
		return this.enqueue(async (): Promise<Snapshot> => {
			if (name === "inspect" || this.stopped) return this.snapshot();
			try {
				this.budget.check();
				signal?.throwIfAborted();
				if (name === "finish") await this.finalize("user_finished");
				else if (name === "baseline" && !this.baseline) {
					this.baseline = await this.train(
						"baseline",
						this.executor.original,
						"Unchanged actual baseline",
						{},
						signal,
					);
					this.selected = this.baseline;
				} else if (name === "candidate") {
					if (!this.baseline) throw new Error("Run baseline before proposing candidates");
					const { content, rationale, parameters, evidence, evidence_refs } = validateProposal(input);
					if (evidence !== undefined || evidence_refs !== undefined)
						throw new Error("TaskSpec v2 does not accept staged evidence fields");
					const id = `exp-${this.rows.length + 1}`;
					const row: ExperimentRow = { id, rationale, status: "failed" };
					this.rows.push(row);
					const result = await this.train(id, content, rationale, parameters ?? {}, signal);
					this.selected = this.groupedFeedback
						? chooseBest(this.selected, result, this.executor.evaluation)
						: result;
					Object.assign(row, {
						status: "evaluated",
						fingerprint: result.fingerprint,
						validation: result.validation,
						run: result.run,
						best_id: this.selected.id,
					});
					if (this.budget.experiments >= this.budget.spec.budget.max_experiments)
						await this.finalize("experiment_budget_exhausted");
				}
				await this.save();
			} catch (error) {
				this.failure = String(error);
				await this.finalize(
					error instanceof BudgetStop ? error.reason : signal?.aborted ? "user_cancelled" : "execution_failure",
				);
			}
			return this.snapshot();
		});
	}

	// 请求留痕供判题器重算准入；基线不会跨进程读取或恢复使用额度。
	reserveRequest(estimate: number): Promise<void> {
		return this.enqueue(async (): Promise<void> => {
			if (this.stopped) throw new Error("Comparison task stopped");
			this.budget.reserveTokens(estimate);
			this.requests.push({ id: this.budget.requests, estimate, status: "pending" });
			await this.save();
		});
	}

	recordUsage(evidence: ModelUsage): Promise<void> {
		return this.enqueue(async (): Promise<void> => {
			const request = this.requests.at(-1);
			if (request?.status !== "pending") return;
			const uncertain = evidence.stop_reason === "aborted" || evidence.stop_reason === "error";
			this.budget.settleTokens(evidence.usage.totalTokens, uncertain ? "partial" : "final");
			this.requests[this.requests.length - 1] = {
				...request,
				evidence,
				status: this.budget.uncertain ? "unknown" : "completed",
			};
			// 与正式控制器使用同一种事件，判题器可以核对用量结算之后的启动顺序。
			await appendFile(
				join(this.root, "events.jsonl"),
				`${JSON.stringify({
					type: "native_pi_usage",
					timestamp: new Date().toISOString(),
					detail: { usage: evidence.usage, usage_uncertain: this.budget.uncertain },
				})}\n`,
			);
			if (this.budget.uncertain || this.budget.tokens >= this.budget.spec.budget.max_tokens)
				await this.finalize(this.budget.uncertain ? "token_usage_uncertain" : "token_budget_exhausted");
			await this.save();
		});
	}

	markUsageUnknown(): Promise<void> {
		return this.enqueue(async (): Promise<void> => {
			const request = this.requests.at(-1);
			if (request?.status !== "pending") return;
			this.budget.settleTokens(undefined);
			this.requests[this.requests.length - 1] = { ...request, status: "unknown" };
			await this.save();
		});
	}

	stop(reason: StopReason): Promise<Snapshot> {
		return this.enqueue(async (): Promise<Snapshot> => {
			await this.finalize(reason);
			return this.snapshot();
		});
	}

	checkpoint(): Promise<void> {
		return this.enqueue((): Promise<void> => this.save());
	}

	async closeLedger(): Promise<void> {
		await this.serial;
	}

	// 同一个 Python 训练、策略检查和独立评分路径，候选内容由模型提供。
	private async train(
		id: string,
		content: string,
		rationale: string,
		parameters: Record<string, unknown>,
		signal = new AbortController().signal,
	): Promise<RunResult> {
		const role = id === "baseline" ? "baseline" : "candidate";
		const steps = this.executor.trainingSteps(role);
		// 配置检查和预算拒绝都在训练许可前；允许观察原生组真实重复训练。
		const candidate = await this.executor.prepare(id, content, rationale, signal, parameters);
		this.budget.launch(role, steps);
		const result = await this.executor.run(candidate, { role, steps }, signal);
		this.evaluated.push(result);
		return result;
	}

	private async finalize(reason: StopReason): Promise<void> {
		if (this.stopped) return;
		this.reason = reason;
		this.ended = Date.now();
		this.budget.freezeWall();
		try {
			if (this.selected) this.delivery = await this.executor.deliver(this.selected);
		} catch (error) {
			this.reason = "delivery_integrity_failure";
			this.failure = String(error);
		}
		await this.save();
		this.abort();
	}

	private summary(): TaskSummary {
		const budget = this.budget.snapshot();
		const limits = this.budget.spec.budget;
		const inflight = this.commands.filter((op) => op.status === "intent" || op.status === "started");
		const computeReserved = inflight.reduce((sum, op) => sum + op.timeoutMs / 1000, 0);
		const remaining = (amount: number): number => (this.stopped ? 0 : Math.max(0, amount));
		return {
			status: !this.reason
				? "running"
				: this.reason === "token_usage_uncertain"
					? "needs_reconciliation"
					: this.reason === "user_cancelled"
						? "cancelled"
						: this.reason.includes("budget")
							? "budget_exhausted"
							: this.reason.includes("failure")
								? "failed"
								: "completed",
			stop_reason: this.reason,
			failure: this.failure,
			delivery: this.delivery,
			ended_at: this.ended,
			budget,
			compute_reserved_seconds: computeReserved,
			unconfirmed_training_steps: inflight.reduce((sum, op) => sum + (op.reservation?.steps ?? 0), 0),
			remaining: {
				experiments: remaining(limits.max_experiments - budget.experiments),
				training_steps: remaining(limits.training_steps - budget.training_steps_reserved),
				compute_seconds: remaining(
					limits.compute_process_seconds - budget.compute_process_seconds - computeReserved,
				),
				tokens: remaining(limits.max_tokens - budget.tokens_actual - budget.tokens_admission_estimate),
				wall_seconds: remaining(this.budget.remainingWallMs / 1000),
			},
			final_test_used: false,
		};
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.serial.then(operation);
		this.serial = next.catch((): void => {});
		return next;
	}

	// 仅作取证快照，原子替换防止 Runner 读到写入一半的报告。
	private async save(): Promise<void> {
		const receipt: TaskCheckpoint = {
			taskId: basename(this.root),
			spec: this.budget.spec,
			approval: this.approval,
			deadline: this.deadline,
			savedAt: Date.now(),
			summary: this.summary(),
			rows: this.rows,
			evaluated: this.evaluated,
			executor: this.executor.checkpoint(),
			commands: this.commands,
			requests: this.requests,
			deliveryStarted: Boolean(this.delivery),
			delivered: this.stopped,
		};
		await writeFile(join(this.root, "bench-receipt.tmp"), JSON.stringify(receipt));
		await rename(join(this.root, "bench-receipt.tmp"), join(this.root, "bench-receipt.json"));
	}
}

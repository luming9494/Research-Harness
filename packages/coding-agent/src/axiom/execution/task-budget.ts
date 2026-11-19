// Accounts for Tiny Task execution and native Pi usage; admission estimates are not billing guarantees.
import type { ExperimentTaskSpec } from "./experiment-domain.ts";

export type BudgetReason =
	| "wall_budget_exhausted"
	| "experiment_budget_exhausted"
	| "training_step_budget_exhausted"
	| "compute_budget_exhausted"
	| "token_budget_exhausted"
	| "token_usage_uncertain";

export class BudgetStop extends Error {
	readonly reason: BudgetReason;
	constructor(reason: BudgetReason) {
		super(reason);
		this.reason = reason;
	}
}

export class TaskBudget {
	readonly spec: ExperimentTaskSpec;
	readonly started: number;
	private readonly now: () => number;
	experiments = 0;
	trainingSteps = 0;
	computeMs = 0;
	tokens = 0;
	requests = 0;
	uncertain = false;
	private held = 0;
	private frozenWall?: number;
	constructor(spec: ExperimentTaskSpec, now: () => number = () => performance.now(), started = now()) {
		this.spec = spec;
		this.now = now;
		this.started = started;
	}
	// 将原截止时间和上次观测的剩余额度同时纳入恢复，系统时钟回拨也不会返还预算。
	static restore(
		spec: ExperimentTaskSpec,
		deadline: number,
		saved: ReturnType<TaskBudget["snapshot"]>,
		wallNow = Date.now(),
	): TaskBudget {
		const remaining = Math.min(spec.budget.wall_seconds * 1000 - saved.wall_seconds * 1000, deadline - wallNow);
		const start = performance.now() - (spec.budget.wall_seconds * 1000 - remaining);
		const budget = new TaskBudget(spec, () => performance.now(), start);
		budget.experiments = saved.experiments;
		budget.trainingSteps = saved.training_steps_reserved;
		budget.computeMs = saved.compute_process_seconds * 1000;
		budget.tokens = saved.tokens_actual;
		budget.requests = saved.model_requests;
		budget.held = saved.tokens_admission_estimate;
		budget.uncertain = saved.usage_uncertain;
		return budget;
	}
	// 终态只冻结墙钟，稍后到达的已授权用量仍可按顺序结算。
	freezeWall(seconds = (this.now() - this.started) / 1000): void {
		this.frozenWall ??= seconds;
	}
	get remainingWallMs(): number {
		return this.spec.budget.wall_seconds * 1000 - (this.now() - this.started);
	}
	check(): void {
		if (this.remainingWallMs <= 0) throw new BudgetStop("wall_budget_exhausted");
		if (this.uncertain) throw new BudgetStop("token_usage_uncertain");
		if (this.tokens >= this.spec.budget.max_tokens) throw new BudgetStop("token_budget_exhausted");
		if (this.computeMs >= this.spec.budget.compute_process_seconds * 1000)
			throw new BudgetStop("compute_budget_exhausted");
	}
	// Reserve the complete launch atomically; rejected launches consume neither attempts nor steps.
	launch(role: "baseline" | "candidate", steps: number): void {
		this.check();
		if (role === "candidate" && this.experiments >= this.spec.budget.max_experiments)
			throw new BudgetStop("experiment_budget_exhausted");
		if (this.trainingSteps + steps > this.spec.budget.training_steps)
			throw new BudgetStop("training_step_budget_exhausted");
		if (role === "candidate") this.experiments++;
		this.trainingSteps += steps;
	}
	// 仅在账本证明没有发出启动许可时调用，恢复事务确保不会返还两次。
	releaseUnstarted(reservation: { role: "baseline" | "candidate"; steps: number }): void {
		if (reservation.steps > this.trainingSteps || (reservation.role === "candidate" && this.experiments < 1))
			throw new Error("Unstarted operation exceeds saved reservation");
		if (reservation.role === "candidate") this.experiments--;
		this.trainingSteps -= reservation.steps;
	}
	processTimeout(): number {
		this.check();
		return Math.max(
			1,
			Math.floor(
				Math.min(this.remainingWallMs, this.spec.budget.compute_process_seconds * 1000 - this.computeMs, 60_000),
			),
		);
	}
	// This is estimated request headroom, not a provider output cap or a tokenizer upper bound.
	reserveTokens(estimate: number): void {
		this.check();
		if (this.held) throw new Error("Previous Pi request usage has not settled");
		if (this.tokens + estimate > this.spec.budget.max_tokens) throw new BudgetStop("token_budget_exhausted");
		this.held = estimate;
		this.requests++;
	}
	settleTokens(actual: number | undefined, certainty: "final" | "partial" = "final"): void {
		if (!this.pendingUsage) return;
		// Usage is provider/event input, not inferred from tool counts or model text.
		if (actual === undefined || !Number.isSafeInteger(actual) || actual < 0) {
			this.uncertain = true;
		} else {
			this.tokens += actual;
			this.uncertain = certainty === "partial";
		}
		// 用量不明时持续保留预留，恢复后也禁止将其用作新请求额度。
		if (!this.uncertain) this.held = 0;
	}
	get pendingUsage(): boolean {
		return this.held > 0 && !this.uncertain;
	}
	snapshot() {
		return {
			experiments: this.experiments,
			training_steps_reserved: this.trainingSteps,
			compute_process_seconds: this.computeMs / 1000,
			tokens_actual: this.tokens,
			tokens_admission_estimate: this.held,
			model_requests: this.requests,
			usage_uncertain: this.uncertain,
			wall_seconds: this.frozenWall ?? (this.now() - this.started) / 1000,
		};
	}
}

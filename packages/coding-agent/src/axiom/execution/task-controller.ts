// Controls serialized multi-round Tiny experiments independently of Pi conversation/session state.
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { type BudgetReason, BudgetStop, TaskBudget } from "./task-budget.ts";
import { CpuTaskExecutor, type Evaluated, type TaskExecutor } from "./task-executor.ts";
import { REVIEW_NOTES, type TaskSpec, validateTaskSpec } from "./task-spec.ts";

export type StopReason =
	| BudgetReason
	| "validation_target_reached"
	| "user_cancelled"
	| "execution_failure"
	| "delivery_integrity_failure"
	| "proposal_limit"
	| "user_finished";
export interface ExperimentRow {
	id: string;
	status: "evaluated" | "cache_hit" | "failed";
	rationale: string;
	fingerprint?: string;
	validation?: Evaluated["validation"];
	run?: string;
	best_id?: string;
	reused_from?: string;
	error?: string;
}
export interface TaskSummary {
	status: "running" | "target_reached" | "budget_exhausted" | "cancelled" | "failed" | "completed";
	stop_reason?: StopReason;
	failure?: string;
	delivery?: Record<string, unknown>;
	budget: ReturnType<TaskBudget["snapshot"]>;
	final_test_used: false;
}

// Migrated selection rule: independent full validation only, strict improvement, ties retain history.
export function chooseBest(current: Evaluated | undefined, candidate: Evaluated): Evaluated {
	const result = candidate.validation;
	// Python evaluator stdout is the evidence trust boundary.
	if (
		result.split !== "validation" ||
		result.level !== "full" ||
		result.protocol !== "tiny-xor-v1" ||
		result.samples !== 512 ||
		!Number.isFinite(result.accuracy) ||
		result.accuracy < 0 ||
		result.accuracy > 1 ||
		!Number.isFinite(result.loss) ||
		JSON.stringify(result.dataset_access_log) !== '["validation"]'
	)
		throw new Error("Best selection requires valid independent validation evidence");
	return !current || result.accuracy > current.validation.accuracy ? candidate : current;
}

export class TaskController {
	readonly root: string;
	readonly spec: TaskSpec;
	readonly budget: TaskBudget;
	readonly executor: TaskExecutor;
	private readonly onStop: () => void;
	private serial: Promise<unknown> = Promise.resolve();
	private readonly cancellation = new AbortController();
	private timer?: ReturnType<typeof setTimeout>;
	private reason?: StopReason;
	private failure?: string;
	private baseline?: Evaluated;
	private best?: Evaluated;
	private rows: ExperimentRow[] = [];
	private cache = new Map<string, Evaluated>();
	private delivered = false;
	private delivery?: Record<string, unknown>;

	constructor(
		root: string,
		spec: TaskSpec,
		budget: TaskBudget,
		executor: TaskExecutor,
		onStop: () => void = () => {},
	) {
		this.root = root;
		this.spec = spec;
		this.budget = budget;
		this.executor = executor;
		this.onStop = onStop;
	}

	static async create(repo: string, python: string, input: unknown, onStop: () => void): Promise<TaskController> {
		const spec = validateTaskSpec(input);
		repo = await realpath(repo);
		python = await realpath(python);
		const parent = join(repo, "private");
		await mkdir(parent, { recursive: true });
		const offset = relative(repo, await realpath(parent));
		if (offset.startsWith("..") || isAbsolute(offset)) throw new Error("private must remain inside repository");
		const root = await mkdtemp(join(parent, "wp04-"));
		const budget = new TaskBudget(spec);
		const executor = new CpuTaskExecutor(repo, root, python, budget);
		await executor.initialize();
		const task = new TaskController(root, spec, budget, executor, onStop);
		await task.initialize();
		return task;
	}

	async initialize(): Promise<void> {
		await writeFile(join(this.root, "task-spec.json"), JSON.stringify(this.spec, null, 2), { flag: "wx" });
		await this.persist();
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

	// Native Pi usage is the accounting input; tool counts and admission estimates are never actual tokens.
	async recordUsage(evidence: {
		provider: string;
		model: string;
		stop_reason: string;
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
	}): Promise<void> {
		const admission = this.budget.snapshot().tokens_admission_estimate;
		this.budget.settleTokens(evidence.usage.totalTokens);
		// Preserve any reported partial usage, but do not assume an interrupted request was fully billed yet.
		if (evidence.stop_reason === "error" || evidence.stop_reason === "aborted") this.budget.uncertain = true;
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
		await this.enqueue(() => (this.stopped ? this.finalize() : this.persist()));
	}

	invoke(name: "inspect" | "baseline" | "candidate" | "finish", input: Record<string, unknown>, signal?: AbortSignal) {
		return this.enqueue(async () => {
			if (name === "inspect") return this.snapshot();
			if (this.stopped) throw new Error(`Task stopped: ${this.reason}; no more experiments`);
			const keys = name === "candidate" ? ["content", "rationale"] : [];
			// Tool arguments are a wire boundary, even when called outside Pi's schema wrapper.
			if (Object.keys(input).some((key) => !keys.includes(key)))
				throw new Error("Permission denied: task rules/config/split cannot be overridden");
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
					if (
						typeof input.content !== "string" ||
						Buffer.byteLength(input.content) > 8192 ||
						typeof input.rationale !== "string" ||
						!input.rationale.trim() ||
						input.rationale.length > 2000
					)
						throw new Error("Invalid candidate proposal");
					await this.runCandidate(input.content, input.rationale, combined);
				}
				this.checkStopConditions();
			} catch (error) {
				this.failure = String(error);
				this.requestStop(
					error instanceof BudgetStop ? error.reason : signal?.aborted ? "user_cancelled" : "execution_failure",
				);
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
			if (this.stopped) await this.finalize();
			else await this.persist();
			return this.snapshot();
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.serial.then(operation);
		this.serial = next.catch(() => {});
		return next;
	}

	private async runBaseline(signal: AbortSignal): Promise<void> {
		if (this.baseline) return;
		const prepared = await this.executor.prepare(
			"baseline",
			this.executor.original,
			"Unchanged actual baseline",
			signal,
		);
		const evaluated = await this.executor.run(prepared, "baseline", signal);
		this.baseline = chooseBest(undefined, evaluated);
		this.best = this.baseline;
		this.cache.set(evaluated.fingerprint, evaluated);
		this.event("baseline_evaluated", evaluated);
	}

	private async runCandidate(content: string, rationale: string, signal: AbortSignal): Promise<void> {
		if (this.budget.experiments >= this.spec.budget.max_experiments)
			throw new BudgetStop("experiment_budget_exhausted");
		if (this.rows.length >= this.spec.budget.max_experiments * 2) {
			this.requestStop("proposal_limit");
			return;
		}
		const row: ExperimentRow = { id: `exp-${this.rows.length + 1}`, status: "failed", rationale };
		this.rows.push(row);
		try {
			const prepared = await this.executor.prepare(row.id, content, rationale, signal);
			row.fingerprint = prepared.fingerprint;
			const existing = this.cache.get(prepared.fingerprint);
			const result = existing ?? (await this.executor.run(prepared, "candidate", signal));
			this.best = chooseBest(this.best, result);
			row.status = existing ? "cache_hit" : "evaluated";
			row.reused_from = existing?.id;
			row.validation = result.validation;
			row.run = result.run;
			row.best_id = this.best.id;
			this.cache.set(result.fingerprint, result);
			this.event(row.status, row);
		} catch (error) {
			row.error = String(error);
			row.best_id = this.best?.id;
			this.event("candidate_failed", row);
			throw error;
		}
	}

	private checkStopConditions(): void {
		if (this.stopped) return;
		if (this.best && this.spec.target_accuracy !== null && this.best.validation.accuracy >= this.spec.target_accuracy)
			this.requestStop("validation_target_reached");
		else if (this.budget.experiments >= this.spec.budget.max_experiments)
			this.requestStop("experiment_budget_exhausted");
		else this.budget.check();
	}

	private requestStop(reason: StopReason): void {
		if (this.stopped) return;
		this.reason = reason;
		clearTimeout(this.timer);
		this.cancellation.abort(new Error(reason));
		this.onStop();
	}

	private summary(): TaskSummary {
		const reason = this.reason;
		return {
			status: !reason
				? "running"
				: reason === "validation_target_reached"
					? "target_reached"
					: reason === "user_cancelled"
						? "cancelled"
						: reason.includes("budget") || reason === "token_usage_uncertain"
							? "budget_exhausted"
							: reason.includes("failure")
								? "failed"
								: "completed",
			stop_reason: reason,
			failure: this.failure,
			delivery: this.delivery,
			budget: this.budget.snapshot(),
			final_test_used: false,
		};
	}

	private async finalize(): Promise<void> {
		if (!this.delivered) {
			this.delivered = true;
			// Do not start training/evaluation or model calls after stopping. Verify and copy prior evidence.
			if (this.best) {
				try {
					this.delivery = await this.executor.deliver(this.best);
				} catch (error) {
					this.reason = "delivery_integrity_failure";
					this.failure = String(error);
				}
			}
			this.event("task_stopped", this.summary());
		}
		await this.persist();
	}

	private async persist(): Promise<void> {
		const snapshot = this.snapshot();
		for (const [name, value] of [
			["experiments.json", snapshot],
			["summary.json", this.summary()],
		] as const) {
			await writeFile(join(this.root, `${name}.tmp`), JSON.stringify(value, null, 2));
			await rename(join(this.root, `${name}.tmp`), join(this.root, name));
		}
		if (!this.stopped) return;
		const rows = this.rows.map(
			(row) =>
				`| ${row.id} | ${row.status} | ${row.validation?.accuracy ?? "unknown"} | ${row.best_id ?? "none"} | ${row.reused_from ?? "none"} |`,
		);
		await writeFile(
			join(this.root, "report.md"),
			[
				"# AXIOM Tiny Task delivery",
				`Status: ${snapshot.status}; reason: ${snapshot.stop_reason}`,
				"Validation only, one seed; no final-test or statistical significance claim.",
				[
					"| ID | Status | Validation accuracy | History best | Reused from |",
					"| --- | --- | --- | --- | --- |",
					`| baseline | ${this.baseline ? "evaluated" : "not_completed"} | ${this.baseline?.validation.accuracy ?? "unknown"} | ${this.baseline ? "baseline" : "none"} | none |`,
					...rows,
				].join("\n"),
				"## Delivery and budget",
				"```json",
				JSON.stringify(this.summary(), null, 2),
				"```",
				"Reload: python examples/tiny-ml-eval/validate_only.py --run <workspace>/best",
				"## Limits",
				...REVIEW_NOTES.map((note) => `- ${note}`),
			].join("\n\n"),
		);
	}

	private event(type: string, detail: unknown): void {
		appendFileSync(
			join(this.root, "events.jsonl"),
			`${JSON.stringify({ type, detail, timestamp: new Date().toISOString() })}\n`,
		);
	}
}

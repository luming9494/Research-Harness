// 矩阵账本链接原生任务账本。进程中断后以已提交的操作和评分决定下一步。
import { readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunResult } from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { type Digest, digest, file, sha256 } from "../bench/io.ts";
import { openExperimentLedger } from "../durable/experiment-ledger.ts";
import { adapter, executable, identity, type Runtime, specFor, taskRoot } from "./environment.ts";
import { verifyEffectiveConfig, verifySamples } from "./evidence.ts";
import { type Cell, cells, type Plan, validatePlan } from "./plan.ts";

export interface Sample {
	cell: Cell;
	status: "completed" | "failed" | "unknown";
	task_id: string | null;
	run: RunResult | null;
	operation_ids: number[];
	compute_ms: number | null;
	evidence: Digest[];
	reason: string | null;
}

interface Link {
	task: string;
	spec_sha256: string;
}

/** 连同外部保存的摘要校验冻结计划，目录内容无法自行授权更改。 */
export async function loadPlan(root: string, sha: string): Promise<Plan> {
	const raw = await file(root, "plan.json");
	if (sha256(raw) !== sha) throw new Error("Research plan digest mismatch");
	const plan = validatePlan(JSON.parse(raw.toString()));
	if (plan.proposal_sha256) {
		// 批准同时绑定模型修订稿和结构化假设。
		const proposal = await file(root, "proposal-revision.json");
		const receipt = JSON.parse(proposal.toString()) as { valid?: boolean; hypotheses?: unknown };
		if (
			sha256(proposal) !== plan.proposal_sha256 ||
			receipt.valid !== true ||
			JSON.stringify(receipt.hypotheses) !== JSON.stringify(plan.hypotheses)
		)
			throw new Error("Frozen model proposal evidence changed");
	}
	return plan;
}

// 读者可以在只读连接取报告，只有持有系统锁的执行者能写矩阵回执。
function ledger(root: string, readOnly = false): DatabaseSync {
	const db = new DatabaseSync(join(root, "matrix.sqlite"), { readOnly });
	if (!readOnly) db.exec("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
	return db;
}

function get<T>(db: DatabaseSync, id: string): T | undefined {
	const row = db.prepare("SELECT payload FROM records WHERE id=?").get(id);
	return row ? (JSON.parse(String(row.payload)) as T) : undefined;
}

function put(db: DatabaseSync, id: string, value: unknown): void {
	db.prepare("INSERT INTO records VALUES (?, ?)").run(id, JSON.stringify(value));
}

export function readSamples(root: string, plan: Plan, sha: string): Sample[] {
	const db = ledger(root, true);
	try {
		if (get(db, "plan") !== sha) throw new Error("Matrix ledger belongs to a different plan");
		return cells(plan, sha).map((cell): Sample => {
			const sample = get<Sample>(db, cell.id);
			if (sample && JSON.stringify(sample.cell) !== JSON.stringify(cell)) throw new Error("Cell identity changed");
			return (
				sample ?? {
					cell,
					status: "unknown",
					task_id: null,
					run: null,
					compute_ms: null,
					operation_ids: [],
					evidence: [],
					reason: "not_observed",
				}
			);
		});
	} finally {
		db.close();
	}
}

export async function runMatrix(
	runtime: Runtime,
	directory: string,
	sha: string,
	stopAfterCell = false,
): Promise<void> {
	const root = await realpath(directory);
	const plan = await loadPlan(root, sha);
	if (JSON.stringify(await identity(runtime, plan.domain)) !== JSON.stringify(plan.controlled))
		throw new Error("Frozen execution environment changed");
	const guard = new DatabaseSync(join(root, "matrix-owner.sqlite"));
	try {
		guard.exec("BEGIN IMMEDIATE");
		const db = ledger(root);
		try {
			const prior = get<string>(db, "plan");
			if (prior === undefined) {
				db.exec("BEGIN IMMEDIATE");
				try {
					put(db, "plan", sha);
					put(db, "deadline", Date.now() + plan.budgets.wall_seconds * 1000);
					db.exec("COMMIT");
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			} else {
				if (prior !== sha) throw new Error("Matrix ledger belongs to a different plan");
				await verifySamples(runtime, plan, sha, readSamples(root, plan, sha));
			}
			const deadline = get<number>(db, "deadline") ?? 0;
			const scheduled = cells(plan, sha);
			for (let repeat = 1; repeat <= plan.repeats; repeat++) {
				const batch = scheduled.filter((cell) => cell.repeat === repeat);
				if (batch.every(({ id }) => get(db, id) !== undefined)) continue;
				if (deadline <= Date.now()) return;
				const spec = specFor(plan, sha, repeat);
				const specSha = sha256(JSON.stringify(spec));
				const key = `repeat-${repeat}`;
				const domain = adapter(runtime, plan);
				const python = executable(runtime, plan.domain);
				const link = get<Link>(db, key);
				if (link && link.spec_sha256 !== specSha) throw new Error("Linked TaskSpec identity changed");
				const task = link
					? await TaskController.resume(runtime.repo, python, link.task, openExperimentLedger, () => {}, domain)
					: await TaskController.create(
							runtime.repo,
							python,
							spec,
							() => {},
							{
								open: openExperimentLedger,
								approval: { approvedAt: new Date().toISOString(), sessionId: plan.id },
							},
							domain,
						);
				try {
					const id = basename(task.root);
					if (!link) put(db, key, { task: id, spec_sha256: specSha } satisfies Link);
					// 起点审批已入原生账本。固定序号防止控制器提交后、矩阵提交前的崩溃造成重跑。
					if (JSON.stringify(task.snapshot().task) !== JSON.stringify(domain.validateSpec(spec)))
						throw new Error("Linked task no longer matches frozen plan");
					for (const [index, cell] of batch.entries()) {
						if (get(db, cell.id)) continue;
						const runId = index === 0 ? "baseline" : `exp-${index}`;
						const observed = (): boolean =>
							task.contextState().evaluated.some(({ id }) => id === runId) ||
							task.snapshot().experiments.some(({ id }) => id === runId);
						let error: string | null = null;
						if (!observed() && !task.stopped && Date.now() < deadline) {
							try {
								const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
								if (!index) await task.invoke("baseline", {}, signal);
								else
									await task.invoke(
										"candidate",
										{
											content: plan.domain === "tiny" ? task.executor.original : "baseline",
											rationale: `Frozen comparison ${cell.condition.id}`,
											parameters: cell.condition.config,
										},
										signal,
									);
							} catch (problem) {
								error = problem instanceof Error ? problem.message : "execution_error";
								await task.stop("execution_failure");
							}
						}
						const sample = await collect(runtime, plan, cell, task, runId, error);
						put(db, cell.id, sample);
						if (stopAfterCell && sample.status === "completed") {
							// 父进程在账本确认后强杀此进程，故意避开正常清理路径。
							await task.checkpoint();
							process.stdout.write(
								`${JSON.stringify({ id, cell: cell.id, operations: sample.operation_ids })}\n`,
							);
							await new Promise<never>(() => {
								setInterval(() => {}, 1000);
							});
						}
					}
					if (!task.stopped) await task.stop("user_finished");
				} finally {
					await task.closeLedger();
				}
			}
		} finally {
			db.close();
		}
	} finally {
		guard.close();
	}
}

// 样本引用固定命名的受控证据，计算只从原生操作结算读取。
async function collect(
	runtime: Runtime,
	plan: Plan,
	cell: Cell,
	task: TaskController,
	runId: string,
	error: string | null,
): Promise<Sample> {
	const state = task.contextState();
	const task_id = basename(task.root);
	const run = state.evaluated.find(({ id }) => id === runId) ?? null;
	const operations = state.operations.filter(({ runId: id }) => id === runId);
	const operation_ids = operations.map(({ id }) => id);
	if (!run) {
		const summary = task.snapshot();
		const unknown =
			summary.failure_category === "external_unknown" ||
			summary.failure_category === "ledger_error" ||
			operations.some((row) => !("elapsedMs" in row) && row.status !== "not_started");
		return {
			cell,
			task_id,
			run,
			operation_ids,
			evidence: [],
			compute_ms: null,
			status:
				unknown || (!operations.length && !error && !summary.experiments.some(({ id }) => id === runId))
					? "unknown"
					: "failed",
			reason: error ?? summary.failure ?? summary.stop_reason ?? "not_observed",
		};
	}
	await task.executor.verifyEvaluated(run);
	const root = taskRoot(runtime.repo, task_id);
	const path = plan.domain === "tiny" ? `runs/${runId}` : `retrieval/${runId}`;
	const names =
		plan.domain === "tiny"
			? [
					"checkpoint.pt",
					"history.json",
					"run.json",
					"validation.json",
					"candidate/config.json",
					"candidate/model.py",
				]
			: ["rankings.json", "proposal.json", "contributions.json"];
	await verifyEffectiveConfig(root, plan, cell, path);
	// Tiny 与 RAG 都保留命令回执，记录经控制器独立核验。
	const commandFiles = await readdir(join(root, "commands"));
	const receiptPaths = operations.flatMap(({ id }) =>
		commandFiles.filter((name) => Number(name.split(".")[0]) === id).map((name) => `commands/${name}`),
	);
	return {
		cell,
		task_id,
		run,
		operation_ids,
		status: "completed",
		reason: null,
		compute_ms: operations.reduce((sum, op) => sum + ("elapsedMs" in op ? op.elapsedMs : 0), 0),
		evidence: await Promise.all(
			[...names.map((name) => `${path}/${name}`), ...receiptPaths].map((name) => digest(root, name)),
		),
	};
}

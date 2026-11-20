// 从操作账本、归档工作进程和 Pi 收据重建统一轨迹。时间缺失时保持 null。
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import type { Grading } from "./grader.ts";
import type { EvidenceReference, TraceEvidence } from "./trace-evidence.ts";
import type { PiToolReceipt } from "./trace-rpc.ts";

export interface TraceRun {
	trace_schema_version?: 1 | 2;
	case_id: string;
	run_id: string;
	started_at: string;
	status: string;
}

export interface TraceEvent {
	schema_version: 1;
	trace_id: string;
	event_id: string;
	case_id: string;
	run_id: string;
	task_id: string | null;
	policy_version: number | null;
	policy_id?: string;
	harness_policy_version?: number;
	policy_sha256?: string;
	type: string;
	status: string;
	timestamp: string | null;
	evidence: EvidenceReference[];
	request_id?: number;
	operation_id?: number;
	recovery_epoch?: 0 | 1;
	candidate_id?: string;
	fingerprint?: string;
	tool_call_id?: string;
	tool?: string;
	model?: string;
	provider?: string;
	stage?: string;
	error_category?: string;
	budget?: {
		training_steps?: number;
		token_estimate?: number;
		tokens_actual?: number;
		compute_seconds?: number;
		wall_seconds?: number;
	};
}

type Fields = Omit<
	TraceEvent,
	"schema_version" | "trace_id" | "event_id" | "case_id" | "run_id" | "task_id" | "policy_version" | "timestamp"
>;
interface WorkerEvent {
	type: string;
	operation_id?: number;
	run_id?: string;
	script?: string;
	timestamp?: string;
	fixture_receipt?: { code?: number };
	detail?: { request?: number };
}
interface Observation {
	tool_evidence?: PiToolReceipt[];
	tools?: string[];
	interrupted?: boolean;
	barrier?: boolean;
	resumed?: boolean | string;
	compaction?: { source: string; tokens_before: number };
	rejected?: string;
	commands?: string[];
	final?: TaskCheckpoint["summary"];
}

// 运行 ID 标识整条轨迹，恢复前后共用它。事件键来自原操作、工具或固定证据定位。
export async function collectTrace(run: TraceRun, store: TraceEvidence, grade: Grading): Promise<TraceEvent[]> {
	const ledger = await store.document<TaskCheckpoint>("final/ledger.json");
	const before = await store.document<TaskCheckpoint>("before/ledger.json");
	const observation = await store.document<Observation>("observed.json");
	const journal = await store.document<WorkerEvent[]>("final/events.jsonl", "jsonl");
	const sources = await store.document<Record<string, string>>("final/candidate-sources.json");
	const terminal = await store.document<{ status: string }>("runner-status.json");
	const saved = ledger?.value;
	// 只有相同任务快照才可定位旧进程已提交的请求与操作。
	const prior = before?.value.taskId === saved?.taskId ? before?.value : undefined;
	const events: TraceEvent[] = [];
	const emit = (id: string, fields: Fields, timestamp?: string): void => {
		events.push({
			schema_version: 1,
			trace_id: run.run_id,
			event_id: `${run.run_id}:${id}`,
			case_id: run.case_id,
			run_id: run.run_id,
			task_id: saved?.taskId ?? null,
			policy_version: saved?.spec.version ?? null,
			policy_id: saved?.policy?.config.id,
			harness_policy_version: saved?.policy?.config.version,
			policy_sha256: saved?.policy?.sha256,
			timestamp: timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null,
			...fields,
		});
	};
	emit("run/start", { type: "run", status: "started", evidence: [] }, run.started_at);
	// 原生压缩回执只以已核验的观测位置进入轨迹。
	if (observation?.value.compaction?.source === "axiom-ledger")
		emit("native/compaction", {
			type: "compaction",
			status: "completed",
			evidence: [observation.ref("/compaction")],
		});

	// 新运行有原生工具首尾收据。历史仅有工具启动名，未知返回保持缺失。
	const proposals = new Map<string, PiToolReceipt[]>();
	for (const [index, receipt] of (observation?.value.tool_evidence ?? []).entries()) {
		const reference = observation?.ref(`/tool_evidence/${index}`);
		if (!reference) continue;
		emit(
			`rpc/tool/${index}`,
			{
				type: receipt.phase === "start" ? "tool_call" : "tool_return",
				status: receipt.status,
				tool_call_id: receipt.call_id,
				tool: receipt.tool,
				request_id: receipt.request_id ?? undefined,
				error_category: receipt.reason,
				evidence: [reference],
			},
			receipt.timestamp,
		);
		if (receipt.candidate_sha256) {
			const matches = proposals.get(receipt.candidate_sha256) ?? [];
			matches.push(receipt);
			proposals.set(receipt.candidate_sha256, matches);
		}
	}
	if (observation && !observation.value.tool_evidence)
		for (const [index, tool] of (observation.value.tools ?? []).entries())
			emit(`rpc/legacy/${index}`, {
				type: "tool_call",
				status: "observed",
				tool: /^axiom_task_(inspect|baseline|candidate|finish)$/.test(tool) ? tool : "unlisted_tool",
				evidence: [observation.ref(`/tools/${index}`)],
			});

	if (saved && ledger) {
		for (const [index, request] of saved.requests.entries()) {
			const proof = [ledger.ref(`/requests/${index}`)];
			const recovery_epoch = prior ? (prior.requests.some((old) => old.id === request.id) ? 0 : 1) : undefined;
			emit(`request/${request.id}/admit`, {
				type: "model_admission",
				status: "reserved",
				request_id: request.id,
				recovery_epoch,
				budget: { token_estimate: request.estimate },
				evidence: proof,
			});
			if (request.status === "pending" || request.status === "unknown") {
				emit(`request/${request.id}/settle`, {
					type: "model_settlement",
					status: request.status,
					request_id: request.id,
					recovery_epoch,
					error_category: "external_operation_unknown",
					evidence: proof,
				});
			} else if (request.evidence) {
				const { provider, model, usage } = request.evidence;
				const timestamp = journal?.value.find(
					(event) => event.type === "native_pi_usage" && event.detail?.request === request.id,
				)?.timestamp;
				emit(
					`request/${request.id}/settle`,
					{
						type: "model_settlement",
						status: "completed",
						request_id: request.id,
						recovery_epoch,
						provider: /^[-\w.]+$/.test(provider) ? provider : undefined,
						model: /^[-\w./]+$/.test(model) ? model : undefined,
						budget: { tokens_actual: usage.totalTokens },
						evidence: proof,
					},
					timestamp,
				);
			}
		}
		let launchedSteps = 0;
		for (const [index, operation] of saved.commands.entries()) {
			const candidate = operation.runId;
			const source = sources?.value[candidate];
			const matching = source ? proposals.get(source) : undefined;
			const call = matching?.length === 1 ? matching[0] : undefined;
			const identity = {
				operation_id: operation.id,
				candidate_id: candidate,
				fingerprint: operation.fingerprint,
				stage: operation.stage,
				tool_call_id: call?.call_id,
				request_id: call?.request_id ?? undefined,
				recovery_epoch: prior
					? prior.commands.some((old) => old.id === operation.id)
						? (0 as const)
						: (1 as const)
					: undefined,
			};
			const evidence = [ledger.ref(`/commands/${index}`)];
			if (call && sources && observation)
				evidence.push(
					sources.ref(`/${candidate}`),
					observation.ref(`/tool_evidence/${observation.value.tool_evidence?.indexOf(call)}`),
				);
			const key = `operation/${operation.id}`;
			const type =
				operation.script === "review_candidate.py"
					? "candidate_review"
					: operation.reservation
						? "training"
						: /validate\.py$|validate_only\.py$/.test(operation.script)
							? "evaluation"
							: "worker";
			if (operation.reservation)
				emit(`${key}/reserve`, {
					...identity,
					type: "budget_reservation",
					status: operation.status === "not_started" ? "released" : "reserved",
					budget: { training_steps: operation.reservation.steps },
					evidence,
				});
			const position =
				journal?.value.findIndex(
					(event) =>
						event.type === "process_start" &&
						event.operation_id === operation.id &&
						event.run_id === candidate &&
						event.script === operation.script,
				) ?? -1;
			const launch = position >= 0 && journal ? journal.value[position] : undefined;
			if (launch && journal)
				emit(
					`${key}/start`,
					{ ...identity, type, status: "started", evidence: [...evidence, journal.ref(`line:${position + 1}`)] },
					launch.timestamp,
				);
			if (launch && journal && operation.reservation) {
				launchedSteps += operation.reservation.steps;
				if (launchedSteps > saved.spec.budget.training_steps)
					emit(
						`${key}/budget-violation`,
						{
							...identity,
							type: "budget_reservation",
							status: "violated",
							error_category: "budget_violation",
							budget: { training_steps: launchedSteps },
							evidence: [
								ledger.ref("/commands"),
								ledger.ref("/spec/budget/training_steps"),
								journal.ref(`line:${position + 1}`),
							],
						},
						launch.timestamp,
					);
			}
			if ("recordSha256" in operation) {
				const path = `final/commands/${String(operation.id).padStart(3, "0")}.json`;
				const command = await store.document<{ code: number | null; stderr?: string; stopped?: string }>(path);
				// 摘要和独立退出记录必须与账本同时吻合，才给出可判定的错误类别。
				const confirmed =
					command &&
					command.ref("").sha256 === operation.recordSha256 &&
					command.value.code === operation.exitCode;
				const proof = confirmed ? [...evidence, command.ref("")] : evidence;
				const error =
					operation.status !== "failed"
						? undefined
						: !confirmed
							? "unknown"
							: command.value.stopped === "timeout"
								? "timeout"
								: command.value.stopped === "aborted"
									? "cancelled"
									: type === "candidate_review" &&
											launch &&
											command.value.code === 1 &&
											command.value.stderr?.startsWith("Candidate policy rejected:")
										? "invalid_candidate"
										: type === "evaluation"
											? "evaluation_failure"
											: "external_execution_failure";
				emit(`${key}/end`, {
					...identity,
					type,
					status: confirmed ? operation.status : "unconfirmed",
					error_category: error,
					evidence: proof,
				});
				if (operation.reservation)
					emit(`${key}/settle`, {
						...identity,
						type: "budget_settlement",
						status: confirmed ? "settled" : "unconfirmed",
						budget: { training_steps: operation.reservation.steps, compute_seconds: operation.elapsedMs / 1000 },
						evidence: proof,
					});
			} else if (["unknown", "started", "pending"].includes(operation.status)) {
				emit(`${key}/unknown`, {
					...identity,
					type,
					status: "unconfirmed",
					error_category: "external_operation_unknown",
					evidence,
				});
			}
		}
		for (const [index, start] of (journal?.value ?? []).entries())
			if (
				journal &&
				start.type === "process_start" &&
				start.fixture_receipt?.code === 0 &&
				!saved.commands.some((op) => op.id === start.operation_id)
			)
				emit(
					`journal/${index}`,
					{
						type: "worker",
						status: "unauthorized",
						error_category: "policy_violation",
						operation_id: start.operation_id,
						evidence: [journal.ref(`line:${index + 1}`), ledger.ref("/commands")],
					},
					start.timestamp,
				);
		for (const [index, result] of saved.evaluated.entries())
			emit(`evaluation/${index}`, {
				type: "evaluation_result",
				status: "recorded",
				candidate_id: result.id,
				fingerprint: result.fingerprint,
				stage: String(result.validation.level),
				evidence: [ledger.ref(`/evaluated/${index}`)],
			});
		if (before && observation && (observation.value.interrupted || observation.value.barrier)) {
			const previous = before.value;
			const resumed = observation.value.resumed === true || observation.value.resumed === saved.taskId;
			const lineage =
				previous.taskId === saved.taskId &&
				previous.deadline === saved.deadline &&
				JSON.stringify(previous.approval) === JSON.stringify(saved.approval);
			const lost =
				resumed &&
				lineage &&
				previous.evaluated.some(
					(run) =>
						!saved.evaluated.some((current) => current.id === run.id && current.fingerprint === run.fingerprint),
				);
			emit("recovery", {
				type: "durable_recovery",
				status: resumed && lineage && !lost ? "resumed" : resumed ? "failed" : "interrupted",
				error_category: lost ? "context_state_loss" : resumed && !lineage ? "durable_recovery_failure" : undefined,
				evidence: [before.ref(""), ledger.ref(""), observation.ref("")],
			});
		}
		const budget = saved.summary.budget;
		const reason = saved.summary.stop_reason;
		emit("task/stop", {
			type: "task_stop",
			status: saved.summary.status,
			error_category:
				reason &&
				[
					"wall_budget_exhausted",
					"compute_budget_exhausted",
					"token_budget_exhausted",
					"training_step_budget_exhausted",
				].includes(reason)
					? "budget_failure"
					: reason === "user_cancelled"
						? "cancelled"
						: reason === "delivery_integrity_failure"
							? "evidence_integrity_failure"
							: undefined,
			budget: {
				training_steps: budget.training_steps_reserved,
				token_estimate: budget.tokens_admission_estimate,
				tokens_actual: budget.tokens_actual,
				compute_seconds: budget.compute_process_seconds,
				wall_seconds: budget.wall_seconds,
			},
			evidence: [ledger.ref("/summary")],
		});
		const delivery = await store.document<{ best_id: string }>("final/delivery.json");
		if (delivery && saved.summary.delivery)
			emit("delivery", {
				type: "delivery",
				status: "published",
				candidate_id: delivery.value.best_id,
				evidence: [delivery.ref(""), ledger.ref("/summary/delivery")],
			});
	}
	if (!saved && observation) {
		const data = observation.value;
		if (data.rejected?.includes("unapproved candidate parameter") && data.commands?.length === 0)
			emit("policy/denied", {
				type: "policy",
				status: "rejected",
				error_category: "policy_denied",
				evidence: [observation.ref("")],
			});
		if (data.final?.stop_reason === "training_step_budget_exhausted")
			emit("budget/denied", {
				type: "task_stop",
				status: "budget_exhausted",
				error_category: "budget_failure",
				evidence: [observation.ref("/final")],
			});
	}
	for (const [index, entry] of grade.evaluation.entries()) {
		const score = await store.document<Record<string, unknown>>(entry.evidence);
		if (score)
			emit(`verification/${index}`, {
				type: "independent_verification",
				status: typeof score.value.accuracy === "number" ? "evaluated" : "rejected",
				candidate_id: entry.id,
				stage: typeof score.value.level === "string" ? score.value.level : undefined,
				evidence: [score.ref("")],
			});
	}
	const invalidDelivery = grade.harness_correctness.checks.find(
		(check) => check.id === "provenance" && check.status === "fail",
	);
	if (invalidDelivery && events.some((event) => event.type === "delivery")) {
		const proofs = (await Promise.all(invalidDelivery.evidence.map((path) => store.artifact(path)))).filter(
			(proof): proof is EvidenceReference => proof !== undefined,
		);
		if (proofs.length === invalidDelivery.evidence.length && proofs.length)
			emit("delivery/verify", {
				type: "independent_verification",
				status: "rejected",
				error_category: "evidence_integrity_failure",
				evidence: proofs,
			});
	}
	emit("run/end", {
		type: "run",
		status: run.status,
		error_category: run.status === "timed_out" ? "timeout" : run.status === "interrupted" ? "cancelled" : undefined,
		evidence: terminal?.value.status === run.status ? [terminal.ref("/status")] : [],
	});
	return events;
}

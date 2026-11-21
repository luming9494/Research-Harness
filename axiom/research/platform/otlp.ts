// OTLP/HTTP 标准 JSON Span 只允许固定名称和可审计的结构化字段。
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { file, sha256 } from "../../bench/io.ts";
import type { TraceEvent } from "../../bench/trace.ts";
import { openExperimentLedger } from "../../durable/experiment-ledger.ts";
import { localEndpoint, request } from "./http.ts";
import { identities, type PublishedRun } from "./run.ts";

const names = [
	"session",
	"model_request",
	"tool_call",
	"operation",
	"backend",
	"recovery",
	"evaluation",
	"delivery",
	"memory",
] as const;
type Name = (typeof names)[number];
export interface Signal {
	key: string;
	name: Name;
	timestamp: number;
	operation?: number;
	evidence?: string;
	status?: string;
}
type Identity = Pick<PublishedRun, "taskId" | "runId" | "traceId" | "evidenceId">;
const nanoseconds = (ms: number): string => (BigInt(Math.trunc(ms)) * 1000000n).toString();
const spanId = (key: string): string => sha256(key).slice(0, 16);

export function otlpPayload(identity: Identity, events: Signal[], rootMode: "root" | "append" = "root"): object {
	const { taskId, runId, traceId, evidenceId } = identity;
	if (
		!/^wp04-[A-Za-z0-9]{6}$/.test(taskId) ||
		!/^[a-f0-9]{64}$/.test(runId) ||
		!/^[a-f0-9]{32}$/.test(traceId) ||
		!/^[a-f0-9-]{36}$/.test(evidenceId)
	)
		throw new Error("Invalid trace identity");
	const root = spanId(`${traceId}/root`);
	const clean = [
		...new Map(
			events
				.filter((event) => names.includes(event.name) && Number.isFinite(event.timestamp) && event.timestamp > 0)
				.map((event) => [event.key, event]),
		).values(),
	];
	if (!clean.length) throw new Error("No timed trace events");
	const attr = (key: string, value: string): object => ({ key: `axiom.${key}`, value: { stringValue: value } });
	const attrs = [attr("task_id", taskId), attr("run_id", runId), attr("evidence_id", evidenceId)];
	const spans = [
		// 后续会话事件可加入已归档的 Trace，无需覆盖根 Span。
		...(rootMode === "root"
			? [
					{
						traceId,
						spanId: root,
						name: "axiom.run",
						kind: 1,
						startTimeUnixNano: nanoseconds(Math.min(...clean.map((e) => e.timestamp))),
						endTimeUnixNano: nanoseconds(Math.max(...clean.map((e) => e.timestamp))),
						attributes: attrs,
					},
				]
			: []),
		...clean.map((e) => ({
			traceId,
			spanId: spanId(`${traceId}/${e.key}`),
			parentSpanId: root,
			name: `axiom.${e.name}`,
			kind: 1,
			startTimeUnixNano: nanoseconds(e.timestamp),
			endTimeUnixNano: nanoseconds(e.timestamp),
			attributes: [
				...attrs,
				...(Number.isSafeInteger(e.operation) ? [attr("operation_id", String(e.operation))] : []),
				...(e.evidence && /^[a-f0-9]{64}$/.test(e.evidence) ? [attr("evidence_sha256", e.evidence)] : []),
				...(e.status &&
				[
					"pending",
					"started",
					"completed",
					"failed",
					"cancelled",
					"unknown",
					"queued",
					"running",
					"submitted",
					"revalidated",
				].includes(e.status)
					? [attr("status", e.status)]
					: []),
			],
		})),
	];
	return {
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "axiom" } }] },
				scopeSpans: [{ scope: { name: "axiom.pi-platform", version: "1" }, spans }],
			},
		],
	};
}

// 同一投影成功后以本地回执去重。响应丢失时允许重传同一 Trace/Span ID。
export async function exportOtlp(
	origin: URL,
	journal: string,
	identity: Identity,
	events: Signal[],
	rootMode: "root" | "append" = "root",
): Promise<"exported" | "reused"> {
	const payload = otlpPayload(identity, events, rootMode);
	const digest = sha256(JSON.stringify(payload));
	const mark = join(journal, `otlp-${digest}.json`);
	const prior = await readFile(mark, "utf8").catch((err: NodeJS.ErrnoException) => {
		if (err.code !== "ENOENT") throw err;
		return null;
	});
	if (prior === digest) return "reused";
	if (prior !== null) throw new Error("Invalid OTLP receipt");
	const receipt = await request<{ partialSuccess?: { rejectedSpans?: string } }>(
		origin,
		"/v1/traces",
		"POST",
		payload,
	);
	if (Number(receipt.partialSuccess?.rejectedSpans ?? 0) > 0) throw new Error("OTLP partial rejection");
	await writeFile(mark, digest, { flag: "wx" });
	return "exported";
}

const traceNames: Record<string, Name> = {
	run: "session",
	model_request: "model_request",
	model_usage: "model_request",
	model_admission: "model_request",
	model_settlement: "model_request",
	tool_call: "tool_call",
	tool_return: "tool_call",
	operation: "operation",
	worker_start: "operation",
	worker_end: "operation",
	worker: "operation",
	budget_reservation: "operation",
	budget_settlement: "operation",
	external_operation: "backend",
	recovery: "recovery",
	durable_resume: "recovery",
	durable_recovery: "recovery",
	evaluation: "evaluation",
	evaluation_result: "evaluation",
	independent_verification: "evaluation",
	delivery: "delivery",
};

// Bench 轨迹已经将原生 Pi 和 Worker 收据统一，导出时仅保留证据摘要和受控事件类型。
export function benchSignals(events: TraceEvent[]): Signal[] {
	return events.flatMap((e) => {
		const name = traceNames[e.type];
		const timestamp = e.timestamp ? Date.parse(e.timestamp) : NaN;
		return name && Number.isFinite(timestamp)
			? [
					{
						key: e.event_id,
						name,
						timestamp,
						operation: e.operation_id,
						evidence: e.evidence[0]?.sha256,
						status: e.status,
					},
				]
			: [];
	});
}

// 用已提交的后端收据、Durable 状态和独立交付摘要交叉核验真实执行。
export async function backendSignals(
	workspace: string,
	taskId: string,
): Promise<{ identity: Identity; events: Signal[] }> {
	const ledger = await openExperimentLedger(workspace);
	const state = await ledger.load().finally(() => ledger.close());
	const delivery = state?.summary.delivery;
	const endedAt = state?.summary.ended_at;
	const run = state?.evaluated.find((row) => row.id === delivery?.best_id);
	if (!state || state.taskId !== taskId || !state.delivered || !run || !delivery || !endedAt)
		throw new Error("No verified backend delivery");
	const operation = state.commands.find(
		(row) => row.external?.status === "completed" && row.external.fingerprint === run.fingerprint,
	);
	const external = operation?.external;
	if (
		!operation ||
		!external?.submit ||
		!external.observation ||
		external.taskId !== taskId ||
		external.observation.id !== external.submit.id ||
		external.observation.exitCode !== 0
	)
		throw new Error("Incomplete backend receipt");
	const receipt = JSON.parse(
		(await file(workspace, `commands/${String(operation.id).padStart(3, "0")}.json`)).toString(),
	) as {
		external?: typeof external;
	};
	if (
		JSON.stringify(receipt.external) !== JSON.stringify(external) ||
		sha256(await file(workspace, "best/checkpoint.pt")) !== delivery.checkpoint_sha256 ||
		sha256(await file(workspace, "best/validation.json")) !== delivery.validation_sha256
	)
		throw new Error("Backend evidence mismatch");
	const raw = (await file(workspace, "events.jsonl")).toString().trim().split("\n");
	const matching = raw.flatMap((line): Signal[] => {
		const row = JSON.parse(line) as {
			type: string;
			timestamp: string;
			detail?: { id?: number; operation_id?: number; token?: string; backend?: string; status?: string };
		};
		const timestamp = Date.parse(row.timestamp);
		const detail = row.detail;
		if (row.type === "external_reconciled" && detail?.id === operation.id)
			return [
				{ key: "durable/reconcile", name: "recovery", operation: operation.id, timestamp, status: "completed" },
			];
		if (
			row.type !== "external_operation" ||
			detail?.operation_id !== operation.id ||
			detail.token !== external.token ||
			detail.backend !== external.backend
		)
			return [];
		return [
			{
				key: `backend/${detail.status}`,
				name: "backend",
				operation: operation.id,
				timestamp,
				status: detail.status,
			},
		];
	});
	return {
		identity: { taskId, ...identities(taskId, run.id, run.fingerprint) },
		events: [
			...matching,
			{
				key: "ledger/eval",
				name: "evaluation",
				timestamp: endedAt,
				evidence: delivery.validation_sha256,
				status: "completed",
			},
			{
				key: "ledger/delivery",
				name: "delivery",
				timestamp: endedAt,
				evidence: delivery.checkpoint_sha256,
				status: "completed",
			},
		],
	};
}

// 原生会话观察只记录失败类别，避免将异常消息里的路径或凭据输出。
export async function bestEffortOtlp(root: string, identity: Identity, events: Signal[]): Promise<void> {
	const configured = process.env.AXIOM_OTLP_ENDPOINT;
	if (!configured) return;
	try {
		await exportOtlp(localEndpoint(configured), root, identity, events);
	} catch {
		await appendFile(
			join(root, "platform-gaps.jsonl"),
			`${JSON.stringify({ channel: "otlp", run_id: identity.runId, status: "unavailable" })}\n`,
		).catch(() => undefined);
	}
}

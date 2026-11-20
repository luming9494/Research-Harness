// 把已校验的 AXIOM 事件映射到 Pi Telemetry，再导出稳定的本地事件接口。
import { InMemoryTelemetryContext, type SpanAttributes } from "@earendil-works/pi-telemetry";
import type { Grading } from "./grader.ts";
import type { TraceEvent, TraceRun } from "./trace.ts";

/** 只导出白名单身份和原证据摘要，不使用 Telemetry 运行时随机 carrier。 */
export async function exportObservations(
	run: TraceRun,
	events: readonly TraceEvent[],
	grade: Grading,
): Promise<string> {
	const recorder = new InMemoryTelemetryContext();
	await recorder.startSpan(
		{ name: "axiom.bench.run", attributes: { "axiom.run_id": run.run_id, "axiom.case_id": run.case_id } },
		(span) => {
			for (const event of events) {
				const attributes: SpanAttributes = {
					"axiom.event_id": event.event_id,
					"axiom.trace_id": event.trace_id,
					"axiom.status": event.status,
					"axiom.evidence": event.evidence.map((ref) => `${ref.path}#${ref.locator}@${ref.sha256}`),
				};
				// 事件中的身份来自归档 ledger、Pi RPC 和独立评分，原始自由文本不进入适配层。
				for (const [key, value] of Object.entries({
					task_id: event.task_id,
					policy_id: event.policy_id,
					policy_version: event.harness_policy_version,
					policy_sha256: event.policy_sha256,
					request_id: event.request_id,
					tool_call_id: event.tool_call_id,
					operation_id: event.operation_id,
					candidate_id: event.candidate_id,
					fingerprint: event.fingerprint,
					stage: event.stage,
					recovery_epoch: event.recovery_epoch,
					timestamp: event.timestamp,
				}))
					if (value !== undefined && value !== null) attributes[`axiom.${key}`] = value;
				for (const [key, value] of Object.entries(event.budget ?? {})) attributes[`axiom.budget.${key}`] = value;
				span.addEvent(`axiom.${event.type}`, attributes);
			}
		},
	);
	const [span] = recorder.getSpans();
	return `${JSON.stringify(
		{
			schema_version: 1,
			adapter: "pi-telemetry/local",
			trace_id: run.run_id,
			run_id: run.run_id,
			task_success: grade.task_success.status,
			harness_correctness: grade.harness_correctness.status,
			events: span.events,
		},
		null,
		2,
	)}\n`;
}

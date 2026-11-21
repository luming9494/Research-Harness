// 将检索操作投影到 AXIOM-Bench 的既有 Trace 与归因契约。
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { attribute } from "../bench/attribution.ts";
import type { Grades } from "../bench/grader.ts";
import { type Digest, json, save, sha256 } from "../bench/io.ts";
import type { TraceEvent, TraceRun } from "../bench/trace.ts";
import { TraceEvidence } from "../bench/trace-evidence.ts";
import type { Epoch } from "./live.ts";

export async function saveRetrievalTrace(
	root: string,
	run: TraceRun,
	manifests: Digest[],
	grades: Grades,
): Promise<string[]> {
	const store = new TraceEvidence(root, manifests);
	const after = await store.document<TaskCheckpoint>("checkpoint-after.json");
	const before = await store.document<TaskCheckpoint>("checkpoint-before.json");
	const rpc = await store.document<Epoch[]>("pi-events.json");
	const ledger = after ?? before;
	const events: TraceEvent[] = [];
	type Details = Pick<TraceEvent, "type" | "status" | "evidence"> &
		Partial<Omit<TraceEvent, "type" | "status" | "evidence">>;
	const add = (id: string, fields: Details): void => {
		events.push({
			schema_version: 1,
			trace_id: run.run_id,
			event_id: `${run.run_id}:${id}`,
			case_id: run.case_id,
			run_id: run.run_id,
			task_id: ledger?.value.taskId ?? null,
			timestamp: null,
			policy_version: ledger?.value.spec.version ?? null,
			...fields,
		});
	};
	add("run/start", { type: "run", status: "started", timestamp: run.started_at, evidence: [] });
	if (rpc) {
		let previousRequests = 0;
		for (const [epoch, evidence] of rpc.value.entries()) {
			for (const [i, tool] of evidence.tools.entries()) {
				add(`rpc/${epoch}/${i}`, {
					type: tool.event === "tool_execution_end" ? "tool_return" : "tool_call",
					status: "observed",
					tool: tool.tool,
					request_id: previousRequests + tool.request,
					tool_call_id: tool.id ? sha256(`${epoch}:${tool.id}`) : undefined,
					evidence: [rpc.ref(`/${epoch}/tools/${i}`)],
				});
			}
			previousRequests += evidence.admitted;
		}
	}
	if (ledger) {
		for (const [i, request] of ledger.value.requests.entries()) {
			const evidence = [ledger.ref(`/requests/${i}`)];
			add(`request/${request.id}/admit`, {
				type: "model_admission",
				status: "reserved",
				request_id: request.id,
				budget: { token_estimate: request.estimate },
				evidence,
			});
			add(`request/${request.id}/settle`, {
				type: "model_settlement",
				status: request.status,
				request_id: request.id,
				evidence,
				error_category: request.status === "completed" ? undefined : "external_operation_unknown",
			});
		}
		for (const [i, operation] of ledger.value.commands.entries()) {
			const evidence = [ledger.ref(`/commands/${i}`)];
			const receipt = await store.artifact(`commands/${operation.id}.json`);
			const verified = receipt && "recordSha256" in operation && receipt.sha256 === operation.recordSha256;
			add(`retrieval/${operation.id}`, {
				type: "retrieval",
				status: verified ? operation.status : "unconfirmed",
				operation_id: operation.id,
				candidate_id: operation.runId,
				fingerprint: operation.fingerprint,
				budget: verified ? { compute_seconds: operation.elapsedMs / 1000 } : undefined,
				error_category:
					operation.status === "pending" || operation.status === "unknown"
						? "external_operation_unknown"
						: undefined,
				evidence: verified ? [...evidence, receipt] : evidence,
			});
		}
		for (const [i, result] of ledger.value.evaluated.entries()) {
			const receipt = await store.artifact(result.run);
			add(`evaluation/${result.id}`, {
				type: "evaluation_result",
				status: receipt ? "verified" : "recorded",
				candidate_id: result.id,
				fingerprint: result.fingerprint,
				stage: "development",
				evidence: [ledger.ref(`/evaluated/${i}`), ...(receipt ? [receipt] : [])],
			});
		}
	}
	if (before && after && rpc) {
		const resumed =
			rpc.value[0].interrupted &&
			before.value.taskId === after.value.taskId &&
			rpc.value[1]?.task === after.value.taskId &&
			before.value.deadline === after.value.deadline &&
			JSON.stringify(before.value.approval) === JSON.stringify(after.value.approval);
		add("recovery", {
			type: "durable_recovery",
			status: resumed ? "resumed" : "failed",
			error_category: resumed ? undefined : "durable_recovery_failure",
			evidence: [before.ref(""), after.ref(""), rpc.ref("")],
		});
	}
	const delivery = await store.artifact("retrieval/delivery.json");
	if (delivery) add("delivery", { type: "delivery", status: "published", evidence: [delivery] });
	add("run/end", { type: "run", status: run.status, evidence: rpc ? [rpc.ref("")] : [] });
	const failures = attribute(run, events, grades);
	await save(root, "trace.jsonl", `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	await json(root, "attribution.json", { schema_version: 1, run_id: run.run_id, failures });
	return ["trace.jsonl", "attribution.json"];
}

// 外部系统关联以已存在的原生节点为起点，远端结果仅用于核对身份。
import { file, sha256 } from "../../bench/io.ts";
import { localEndpoint, request } from "../platform/http.ts";
import type { Node, Relation } from "./store.ts";

export async function platformEvidence(
	directory: string,
	sha: string,
	native: Node[],
): Promise<{
	nodes: Node[];
	relations: Relation[];
}> {
	const bytes = await file(directory, "sync.json");
	if (sha256(bytes) !== sha) throw new Error("Projection receipt digest mismatch");
	const receipt = JSON.parse(bytes.toString()) as {
		qdrant: { result?: { collection: string } };
		runs: {
			taskId: string;
			runId: string;
			traceId: string;
			evidenceId: string;
			otlp: { status: string };
			mlflow: { result?: { mlflowRunId: string; manifestSha: string } };
		}[];
	};
	const collection = receipt.qdrant.result?.collection;
	if (!collection || !/^axiom_exp_[a-f0-9]{24}$/.test(collection)) throw new Error("No verified Qdrant collection");
	const qdrant = localEndpoint(process.env.AXIOM_QDRANT_ENDPOINT ?? "http://127.0.0.1:6333");
	const mlflow = localEndpoint(process.env.AXIOM_MLFLOW_ENDPOINT ?? "http://127.0.0.1:5000");
	const nodes: Node[] = [];
	const relations: Relation[] = [];
	for (const run of receipt.runs) {
		const expected = native.find(({ id, kind }) => kind === "run" && id === run.runId)?.data as
			| { task: string; ids: { traceId: string; evidenceId: string } }
			| undefined;
		const tracking = run.mlflow.result;
		if (
			!expected ||
			!tracking ||
			!/^[a-f0-9]{32}$/.test(tracking.mlflowRunId) ||
			expected.task !== run.taskId ||
			expected.ids.traceId !== run.traceId ||
			expected.ids.evidenceId !== run.evidenceId ||
			run.otlp.status !== "ok"
		)
			continue;
		const [point, tracked] = await Promise.all([
			request<{ result: { payload: { run_id: string; task_id: string } } }>(
				qdrant,
				`/collections/${collection}/points/${run.evidenceId}`,
			),
			request<{ run: { data: { tags: { key: string; value: string }[] } } }>(
				mlflow,
				`/api/2.0/mlflow/runs/get?run_id=${tracking.mlflowRunId}`,
			),
		]);
		const tags = new Map(tracked.run.data.tags.map(({ key, value }) => [key, value]));
		if (
			point.result.payload.run_id !== run.runId ||
			point.result.payload.task_id !== run.taskId ||
			tags.get("axiom.run_id") !== run.runId ||
			tags.get("axiom.trace_id") !== run.traceId ||
			tags.get("axiom.evidence_id") !== run.evidenceId ||
			tags.get("axiom.manifest_sha256") !== tracking.manifestSha
		)
			throw new Error("Cross-service research identity mismatch");
		const id = `projection-${sha256(JSON.stringify([run.runId, collection, tracking.mlflowRunId]))}`;
		nodes.push({
			id,
			kind: "artifact",
			data: {
				collection,
				evidence: run.evidenceId,
				trace: run.traceId,
				mlflow: tracking.mlflowRunId,
				manifest_sha256: tracking.manifestSha,
			},
		});
		relations.push({ from: run.runId, to: id, kind: "projected_as", source: sha, status: "verified" });
	}
	if (!nodes.length) throw new Error("No projection receipt matches project runs");
	return { nodes, relations };
}

// 工件权限按当前持锁任务和已验证运行派生。模型只提交生成的 ID。
import type { RunResult } from "../../packages/coding-agent/src/axiom/execution/experiment-domain.ts";
import { file, sha256 } from "../bench/io.ts";

export interface ArtifactReference {
	run_id: string;
	artifact_id: string;
	type: "training_history" | "checkpoint";
	path: string;
	summary: string;
	metrics: { accuracy?: number; loss?: number };
	sha256: string;
	access: "numeric_tail" | "reference_only";
}

// 只有正式 validation 结果的已登记摘要可以被引用。
export function artifactsFor(runs: readonly RunResult[]): ArtifactReference[] {
	return runs.flatMap((run): ArtifactReference[] => {
		if (
			!/^(baseline|exp-[1-9]\d*)$/.test(run.id) ||
			run.validation.split !== "validation" ||
			run.validation.level !== "full"
		)
			return [];
		const history = (run as RunResult & { historySha256?: string }).historySha256;
		const checkpoint = run.validation.checkpoint_sha256;
		const metrics = {
			accuracy: typeof run.validation.accuracy === "number" ? run.validation.accuracy : undefined,
			loss: typeof run.validation.loss === "number" ? run.validation.loss : undefined,
		};
		return [
			{
				id: "history",
				type: "training_history",
				name: "history.json",
				summary: "Per-epoch training loss",
				digest: history,
				access: "numeric_tail",
			},
			{
				id: "checkpoint",
				type: "checkpoint",
				name: "checkpoint.pt",
				summary: "Independently evaluated weights",
				digest: checkpoint,
				access: "reference_only",
			},
		].flatMap((item): ArtifactReference[] =>
			typeof item.digest === "string" && /^[a-f0-9]{64}$/.test(item.digest)
				? [
						{
							run_id: run.id,
							artifact_id: `${run.id}:${item.id}`,
							type: item.type as ArtifactReference["type"],
							path: `runs/${run.id}/${item.name}`,
							summary: item.summary,
							metrics,
							sha256: item.digest,
							access: item.access as ArtifactReference["access"],
						},
					]
				: [],
		);
	});
}

// 只返回最多五条数值点。原始日志、权重、评分器、任意路径均无法通过该读取器访问。
export async function artifactTail(
	root: string,
	refs: readonly ArtifactReference[],
	id: string,
): Promise<{ epoch: number; loss: number }[]> {
	const ref = refs.find((item) => item.artifact_id === id && item.access === "numeric_tail");
	if (!ref) throw new Error("Artifact unavailable or not approved for reading");
	const raw = await file(root, ref.path);
	if (raw.length > 64_000 || sha256(raw) !== ref.sha256) throw new Error("Artifact integrity verification failed");
	const value: unknown = JSON.parse(raw.toString("utf8"));
	if (!Array.isArray(value)) throw new Error("Invalid training history");
	return value.slice(-5).map((row: unknown): { epoch: number; loss: number } => {
		if (
			!row ||
			typeof row !== "object" ||
			!("epoch" in row) ||
			!("loss" in row) ||
			typeof row.epoch !== "number" ||
			!Number.isSafeInteger(row.epoch) ||
			typeof row.loss !== "number" ||
			!Number.isFinite(row.loss)
		)
			throw new Error("Invalid training history point");
		return { epoch: row.epoch, loss: row.loss };
	});
}

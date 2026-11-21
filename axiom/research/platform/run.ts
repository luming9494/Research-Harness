// 只有原矩阵、独立评价和原生命令收据均通过验证时才生成外部投影。
import { join } from "node:path";
import { type Digest, file, sha256 } from "../../bench/io.ts";
import type { Experience } from "../../context/experience.ts";
import { openExperimentLedger } from "../../durable/experiment-ledger.ts";
import { type Runtime, taskRoot } from "../environment.ts";
import { verifySamples } from "../evidence.ts";
import { loadPlan, readSamples } from "../execute.ts";

export interface PublishedRun {
	version: 1;
	taskId: string;
	runId: string;
	nativeRun: string;
	traceId: string;
	evidenceId: string;
	operationIds: number[];
	planSha: string;
	checkpointSha: string;
	artifacts: Digest[];
	parameters: { seed: number; learning_rate: number; epochs: number };
	metrics: { accuracy: number; loss: number; compute_ms: number };
	curve: { epoch: number; loss: number }[];
	startedAt: number;
	endedAt: number;
	delivered: boolean;
}

// 同一原生运行的所有投影共享稳定身份，向量库使用 UUID 格式的点键。
export function identities(
	taskId: string,
	run: string,
	fingerprint: string,
): Pick<PublishedRun, "runId" | "traceId" | "evidenceId"> {
	const runId = sha256(JSON.stringify([taskId, run, fingerprint]));
	const e = sha256(`axiom/evidence/${runId}`);
	return {
		runId,
		traceId: sha256(`axiom/trace/${runId}`).slice(0, 32),
		evidenceId: `${e.slice(0, 8)}-${e.slice(8, 12)}-5${e.slice(13, 16)}-8${e.slice(17, 20)}-${e.slice(20, 32)}`,
	};
}

export async function loadResearchRuns(runtime: Runtime, root: string, sha: string): Promise<PublishedRun[]> {
	const plan = await loadPlan(root, sha);
	if (plan.domain !== "tiny") throw new Error("Platform research projection currently requires verified Tiny plans");
	const samples = readSamples(root, plan, sha);
	await verifySamples(runtime, plan, sha, samples);
	const output: PublishedRun[] = [];
	for (const sample of samples) {
		if (sample.status !== "completed" || !sample.task_id || !sample.run || sample.compute_ms === null) continue;
		const taskId = sample.task_id;
		const nativeRun = sample.run.id;
		const workspace = taskRoot(runtime.repo, taskId);
		const ledger = await openExperimentLedger(workspace);
		try {
			const state = await ledger.load();
			if (
				!state?.savedAt ||
				state.taskId !== taskId ||
				!state.evaluated.some((run) => JSON.stringify(run) === JSON.stringify(sample.run))
			)
				throw new Error("Projection lost original ledger run");
			const source = join(workspace, "runs", nativeRun);
			const recorded = JSON.parse((await file(source, "run.json")).toString()) as {
				config: PublishedRun["parameters"];
			};
			// 外部参数投影只读取已批准的三个配置字段。
			const { seed, learning_rate, epochs } = recorded.config;
			const curve = JSON.parse((await file(source, "history.json")).toString()) as PublishedRun["curve"];
			const { accuracy, loss, checkpoint_sha256: checkpointSha } = sample.run.validation;
			if (
				typeof accuracy !== "number" ||
				typeof loss !== "number" ||
				typeof checkpointSha !== "string" ||
				!Number.isFinite(accuracy) ||
				!Number.isFinite(loss) ||
				!/^[a-f0-9]{64}$/.test(checkpointSha) ||
				!Number.isSafeInteger(seed) ||
				!Number.isFinite(learning_rate) ||
				!Number.isSafeInteger(epochs) ||
				curve.length !== epochs ||
				!curve.every((row, i) => row.epoch === i + 1 && Number.isFinite(row.loss))
			)
				throw new Error("Invalid verified experiment metrics");
			const operations = state.commands.filter((item) => sample.operation_ids.includes(item.id));
			const starts = operations.flatMap((item) =>
				"identity" in item && item.identity ? [item.identity.observedAt] : [],
			);
			if (!starts.length) throw new Error("Missing command timing evidence");
			const endedAt = state.summary.ended_at ?? state.savedAt;
			output.push({
				version: 1,
				taskId,
				nativeRun,
				...identities(taskId, nativeRun, sample.run.fingerprint),
				operationIds: sample.operation_ids,
				planSha: sha,
				checkpointSha,
				artifacts: sample.evidence.map((row) => ({
					path: row.path.split("/").at(-1) ?? "",
					sha256: row.sha256,
					bytes: row.bytes,
				})),
				parameters: { epochs, learning_rate, seed },
				metrics: { accuracy, loss, compute_ms: sample.compute_ms },
				curve,
				startedAt: Math.min(...starts),
				endedAt,
				delivered: state.summary.delivery?.best_id === nativeRun,
			});
		} finally {
			await ledger.close();
		}
	}
	return output;
}

// 入库文字由固定模板和数值生成，不复制假设中的自由文本、标签或日志。
export function experienceFor(run: PublishedRun): Experience {
	const p = run.parameters;
	return {
		task: "tiny-xor-v1",
		condition: "learning_rate",
		problem: `Learning-rate validation under fixed initialization seed ${p.seed}`,
		result: `Adam learning rate ${p.learning_rate}, ${p.epochs} epochs, validation accuracy ${run.metrics.accuracy.toFixed(6)}, loss ${run.metrics.loss.toFixed(6)}.`,
		evidence_id: run.evidenceId,
		sha256: run.checkpointSha,
		revalidated: true,
		limits: "Independent validation on the fixed Tiny XOR split. Scope is this seed and configuration.",
	};
}

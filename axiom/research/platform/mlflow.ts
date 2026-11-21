// 实验跟踪是单向投影。稳定键和提交意图处理进程崩溃与丢失回执。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../../bench/io.ts";
import { PlatformHttpError, request } from "./http.ts";
import type { PublishedRun } from "./run.ts";

const api = "/api/2.0/mlflow";
const runIdPattern = /^[a-f0-9]{32}$/;
interface Run {
	info: { run_id: string; artifact_uri: string; status: string };
	data?: { tags?: { key: string; value: string }[] };
}

async function experiment(origin: URL): Promise<string> {
	const name = "AXIOM Verified Research";
	const lookup = async (): Promise<string> =>
		(
			await request<{ experiment: { experiment_id: string } }>(
				origin,
				`${api}/experiments/get-by-name?experiment_name=${encodeURIComponent(name)}`,
			)
		).experiment.experiment_id;
	try {
		return await lookup();
	} catch (err) {
		if (!(err instanceof PlatformHttpError) || err.status !== 404) throw err;
	}
	try {
		return (await request<{ experiment_id: string }>(origin, `${api}/experiments/create`, "POST", { name }))
			.experiment_id;
	} catch {
		return lookup();
	}
}

export async function projectMlflow(
	origin: URL,
	journal: string,
	input: PublishedRun,
): Promise<{ experimentId: string; mlflowRunId: string; manifestSha: string; reused: boolean }> {
	const experimentId = await experiment(origin);
	const lookup = async (): Promise<Run | undefined> => {
		const result = await request<{ runs?: Run[] }>(origin, `${api}/runs/search`, "POST", {
			experiment_ids: [experimentId],
			filter: `tags.\`axiom.run_id\` = '${input.runId}'`,
			max_results: 2,
		});
		if ((result.runs?.length ?? 0) > 1) throw new Error("Ambiguous MLflow logical run identity");
		return result.runs?.[0];
	};
	let run = await lookup();
	const reused = run !== undefined;
	if (!run) {
		// 丢失创建响应时只能对账，不能假定服务没有创建 Run。
		try {
			await writeFile(
				join(journal, `mlflow-${input.runId}.intent`),
				JSON.stringify({ experimentId, runId: input.runId }),
				{ flag: "wx" },
			);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			run = await lookup();
			if (!run) throw new Error("MLflow create outcome unknown; lookup required");
		}
		if (!run)
			run = (
				await request<{ run: Run }>(origin, `${api}/runs/create`, "POST", {
					experiment_id: experimentId,
					start_time: Math.trunc(input.startedAt),
					tags: [
						{ key: "mlflow.runName", value: `tiny-${input.parameters.seed}-${input.parameters.learning_rate}` },
						{ key: "axiom.run_id", value: input.runId },
						{ key: "axiom.task_id", value: input.taskId },
						{ key: "axiom.trace_id", value: input.traceId },
						{ key: "axiom.evidence_id", value: input.evidenceId },
					],
				})
			).run;
	}
	const mlflowRunId = run.info.run_id;
	if (!runIdPattern.test(mlflowRunId)) throw new Error("Invalid MLflow run receipt");
	const { curve, ...facts } = input;
	const manifest = { ...facts, training_curve_points: curve.length };
	const text = JSON.stringify(manifest);
	const manifestSha = sha256(text);
	const prior = run.data?.tags?.find(({ key }) => key === "axiom.manifest_sha256")?.value;
	if (prior && prior !== manifestSha) throw new Error("MLflow publication conflicts with frozen manifest");
	if (prior === manifestSha && run.info.status === "FINISHED")
		return { experimentId, mlflowRunId, manifestSha, reused: true };
	const timestamp = Math.trunc(input.endedAt);
	await request(origin, `${api}/runs/log-batch`, "POST", {
		run_id: mlflowRunId,
		params: Object.entries(input.parameters).map(([key, value]) => ({ key, value: String(value) })),
		metrics: [
			...Object.entries(input.metrics).map(([key, value]) => ({ key, value, timestamp, step: 0 })),
			...curve.map(({ epoch, loss }) => ({ key: "train_loss", value: loss, timestamp, step: epoch })),
		],
	});
	// 只上传可公开的固定清单。权重通过内容摘要与原任务工件关联。
	const uri = /^mlflow-artifacts:\/(\d+\/[a-f0-9]{32}\/artifacts)$/.exec(run.info.artifact_uri)?.[1];
	if (!uri || uri !== `${experimentId}/${mlflowRunId}/artifacts`)
		throw new Error("Expected local proxied MLflow artifact URI");
	const transfer = await fetch(new URL(`/api/2.0/mlflow-artifacts/artifacts/${uri}/axiom-manifest.json`, origin), {
		method: "PUT",
		body: text,
		redirect: "error",
		signal: AbortSignal.timeout(6_000),
		headers: { "content-type": "application/octet-stream" },
	});
	if (!transfer.ok) throw new PlatformHttpError(transfer.status);
	await request(origin, `${api}/runs/set-tag`, "POST", {
		run_id: mlflowRunId,
		key: "axiom.manifest_sha256",
		value: manifestSha,
	});
	await request(origin, `${api}/runs/update`, "POST", {
		run_id: mlflowRunId,
		status: "FINISHED",
		end_time: timestamp,
	});
	return { experimentId, mlflowRunId, manifestSha, reused };
}

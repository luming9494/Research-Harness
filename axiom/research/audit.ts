// 复现按原始工件、独立打分和从固定输入重新执行分别取证。
import { join } from "node:path";
import { childOutput, file } from "../bench/io.ts";
import { loadDense } from "../rag/dense.ts";
import { hybridConfigOf, retrieveHybrid } from "../rag/hybrid.ts";
import { loadDataset } from "../rag/scifact.ts";
import { score } from "../rag/score.ts";
import { verifyRankingReplay } from "../rag/verify.ts";
import { type Runtime, taskRoot } from "./environment.ts";
import { verifySamples } from "./evidence.ts";
import type { Sample } from "./execute.ts";
import type { Plan } from "./plan.ts";

export interface Audit {
	cell: string;
	task_id: string;
	run_id: string;
	run: "passed" | "not_run";
	evaluate: "passed";
	train: "passed" | "mismatch" | "not_run";
	evidence_status: "evaluation_reproduced" | "training_reproduced";
	scope: string;
	observed_ms: number;
	evidence: string[];
}

export async function auditMatrix(runtime: Runtime, plan: Plan, sha: string, samples: Sample[]): Promise<Audit[]> {
	await verifySamples(runtime, plan, sha, samples);
	const signal = AbortSignal.timeout(600_000);
	const data = plan.domain === "scifact" && runtime.data ? await loadDataset(runtime.data, "development") : undefined;
	const dense = data && runtime.vectors ? await loadDense(runtime.vectors, data, "development") : undefined;
	const ids = new Set(data?.documents.map(({ id }) => id));
	const audits: Audit[] = [];
	for (const sample of samples) {
		const run = sample.run;
		const task = sample.task_id;
		if (sample.status !== "completed" || !run || !task) continue;
		const root = taskRoot(runtime.repo, task);
		const started = performance.now();
		let levels: Pick<Audit, "run" | "train" | "scope">;
		if (plan.domain === "scifact") {
			if (!data || !dense) throw new Error("Missing frozen development vectors for audit");
			const saved = JSON.parse((await file(root, run.run)).toString()) as {
				dataset: string;
				rankings: ReturnType<typeof retrieveHybrid>["rankings"];
				index_sha256: string;
				index_bytes: number;
			};
			const replay = retrieveHybrid(data, dense, hybridConfigOf(sample.cell.condition.config), () =>
				signal.throwIfAborted(),
			);
			verifyRankingReplay(saved.rankings, replay.rankings);
			if (
				saved.dataset !== data.fingerprint ||
				saved.index_sha256 !== replay.index_sha256 ||
				saved.index_bytes !== replay.index_bytes
			)
				throw new Error("Rebuilt retrieval index identity differs");
			const independent = score(saved.rankings, data.qrels, ids);
			const expected = JSON.parse(
				(await file(root, `retrieval/${run.id}/contributions.json`)).toString(),
			) as unknown;
			if (
				JSON.stringify(independent.contributions) !== JSON.stringify(expected) ||
				Object.entries(independent.metrics).some(([key, value]) => run.validation[key] !== value)
			)
				throw new Error("Independent SciFact score mismatch");
			levels = {
				run: "passed",
				train: "not_run",
				scope: "Index rebuilt and retrieval replayed from verified frozen document and query vectors. Encoder not rerun.",
			};
		} else {
			const result = await childOutput(
				runtime.python,
				[join(runtime.repo, "examples/tiny-ml-eval/validate_only.py"), "--run", run.run],
				runtime.repo,
				signal,
			);
			const observed = JSON.parse(result.stdout) as Record<string, unknown>;
			for (const metric of ["accuracy", "loss", "samples", "checkpoint_sha256", "run_metadata_sha256"] as const)
				if (observed[metric] !== run.validation[metric])
					throw new Error(`Independent Tiny evaluation differs: ${metric}`);
			const reference = samples.find(
				(other) => other.cell.repeat === 1 && other.cell.condition.id === sample.cell.condition.id,
			);
			const repeated =
				sample.cell.repeat > 1 &&
				!!reference?.run &&
				reference.status === "completed" &&
				reference.task_id !== task &&
				reference.cell.seed === sample.cell.seed;
			const differences = repeated
				? ["accuracy", "loss", "samples"].filter((key) => reference.run?.validation[key] !== run.validation[key])
				: [];
			// 确实重训但指标不同要明确报告，不能标成未执行。
			levels = {
				run: repeated ? "passed" : "not_run",
				train: repeated ? (differences.length ? "mismatch" : "passed") : "not_run",
				scope:
					repeated && differences.length
						? `Fresh training differed on ${differences.join(", ")}. Exact equality is required for Tiny fixed-seed repeats.`
						: repeated
							? "Fresh training from fixed architecture, config, dataset and seed matched independent accuracy, loss and sample count."
							: "Independent checkpoint re-evaluation. Training reproduction requires a fresh repeat with the same seed.",
			};
		}
		audits.push({
			cell: sample.cell.id,
			task_id: task,
			run_id: run.id,
			...levels,
			evaluate: "passed",
			evidence_status: levels.train === "passed" ? "training_reproduced" : "evaluation_reproduced",
			observed_ms: performance.now() - started,
			evidence: sample.evidence.map(({ sha256 }) => sha256),
		});
	}
	return audits;
}

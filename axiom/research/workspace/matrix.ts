// 从原生账本和冻结矩阵重建证据图及报告，保留失败和未观测单元。
import { file, sha256 } from "../../bench/io.ts";
import { type Runtime, taskRoot } from "../environment.ts";
import { verifySamples } from "../evidence.ts";
import { loadPlan, readSamples } from "../execute.ts";
import { identities } from "../platform/run.ts";
import { paired, researchReport } from "../report.ts";
import type { Node, Relation } from "./store.ts";

export async function matrixEvidence(
	runtime: Runtime,
	directory: string,
	sha: string,
): Promise<{
	nodes: Node[];
	relations: Relation[];
	report: ReturnType<typeof researchReport>;
	curves: object[];
}> {
	const plan = await loadPlan(directory, sha);
	const samples = readSamples(directory, plan, sha);
	await verifySamples(runtime, plan, sha, samples);
	const planId = `plan-${sha}`;
	const question = `question-${sha256(plan.question)}`;
	const dataset = `dataset-${plan.controlled.dataset}`;
	const implementation = `model-${plan.controlled.implementation}-${plan.controlled.model}`;
	const protocol = `protocol-${plan.controlled.evaluation}`;
	const nodes: Node[] = [
		{ id: question, kind: "question", data: { text: plan.question } },
		{
			id: planId,
			kind: "plan",
			data: {
				sha256: sha,
				id: plan.id,
				domain: plan.domain,
				budgets: plan.budgets,
				parent: plan.version === 2 ? (plan.lineage?.parent ?? null) : null,
			},
		},
		{ id: dataset, kind: "dataset", data: { digest: plan.controlled.dataset } },
		{
			id: implementation,
			kind: "implementation",
			data: { implementation: plan.controlled.implementation, model: plan.controlled.model },
		},
		{ id: protocol, kind: "protocol", data: { evaluation: plan.controlled.evaluation } },
	];
	const relations: Relation[] = [question, dataset, implementation, protocol].map((to) => ({
		from: planId,
		to,
		kind: "binds",
		source: sha,
		status: "verified",
	}));
	const curves: object[] = [];
	const completed = new Map<string, string>();
	for (const sample of samples) {
		const { task_id: task, run, cell } = sample;
		if (!task || !run || sample.status !== "completed") continue;
		const ids = identities(task, run.id, run.fingerprint);
		completed.set(cell.id, ids.runId);
		nodes.push({
			id: ids.runId,
			kind: "run",
			data: {
				task,
				original_run: run.id,
				ids,
				operations: sample.operation_ids,
				condition: cell.condition.config,
				seed: cell.seed,
				independent: true,
			},
		});
		relations.push(
			{ from: planId, to: ids.runId, kind: "observed_run", source: sha, status: "verified" },
			{ from: ids.runId, to: protocol, kind: "evaluated_by", source: sha, status: "verified" },
		);
		const metric = `metric-${ids.runId}`;
		nodes.push({ id: metric, kind: "metric", data: { independent: true, values: run.validation } });
		relations.push({ from: ids.runId, to: metric, kind: "scored", source: sha, status: "verified" });
		for (const artifact of sample.evidence) {
			const artifactId = `artifact-${artifact.sha256}`;
			nodes.push({ id: artifactId, kind: "artifact", data: { sha256: artifact.sha256, bytes: artifact.bytes } });
			relations.push({
				from: ids.runId,
				to: artifactId,
				kind: "produced",
				source: artifact.sha256,
				status: "verified",
			});
			if (artifact.sha256 === run.validation.checkpoint_sha256 || artifact.sha256 === run.validation.receipt_sha256)
				relations.push({
					from: metric,
					to: artifactId,
					kind: "derived_from",
					source: artifact.sha256,
					status: "verified",
				});
		}
		const history = sample.evidence.find(({ path }) => path === `runs/${run.id}/history.json`);
		if (history) {
			const raw = await file(taskRoot(runtime.repo, task), history.path);
			if (sha256(raw) !== history.sha256) throw new Error("Training history digest changed");
			curves.push({
				run: ids.runId,
				source: history.sha256,
				training: JSON.parse(raw.toString()) as unknown,
				validation: run.validation,
			});
		}
	}
	for (const [index, hypothesis] of plan.hypotheses.entries()) {
		const id = `hypothesis-${sha}-${index}`;
		const chosen = samples.filter(({ cell }) => cell.condition.id === hypothesis.comparison);
		const refs = samples.filter(({ cell }) => cell.condition.id === chosen[0]?.cell.condition.reference);
		const delta = paired(chosen, refs, hypothesis.metric);
		const outcome =
			delta.pairs !== plan.repeats || delta.absolute === null
				? "uncertain"
				: (hypothesis.direction === "increase" ? delta.absolute > 0 : delta.absolute < 0)
					? "supported"
					: delta.absolute === 0
						? "uncertain"
						: "contradicted";
		const finding = `finding-${sha256(JSON.stringify([id, delta, outcome]))}`;
		nodes.push(
			{ id, kind: "hypothesis", data: hypothesis },
			{
				id: finding,
				kind: "finding",
				data: {
					outcome,
					delta,
					metric: hypothesis.metric,
					scope: plan.controlled,
					independent: delta.pairs > 0,
					host_confirmed: true,
					model_commentary: null,
					limitations: "Descriptive paired results within the frozen matrix.",
				},
			},
		);
		relations.push(
			{ from: planId, to: id, kind: "tests", source: sha, status: "verified" },
			{ from: id, to: question, kind: "answers", source: sha, status: "verified" },
			{ from: finding, to: id, kind: "assesses", source: sha, status: "verified" },
		);
		for (const { cell } of [...chosen, ...refs]) {
			const to = completed.get(cell.id);
			if (to) relations.push({ from: finding, to, kind: "uses", source: sha, status: "verified" });
		}
	}
	return { nodes, relations, report: researchReport(plan, sha, samples, []), curves };
}

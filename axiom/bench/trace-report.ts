// 输出版本化归因及证据索引。报告只展示受控文字、结构化数据和相对路径。
import { attribute } from "./attribution.ts";
import type { Grading } from "./grader.ts";
import { type Digest, json, save } from "./io.ts";
import { collectTrace, type TraceRun } from "./trace.ts";
import { type EvidenceReference, TraceEvidence } from "./trace-evidence.ts";

export const traceFiles = ["trace.jsonl", "attribution.json", "attribution.md", "trace-evidence.json"] as const;
export const attributionPaths = {
	schema_version: 1,
	trace: traceFiles[0],
	results: traceFiles[1],
	report: traceFiles[2],
	evidence_index: traceFiles[3],
} as const;

// 序列化只依赖归档证据和评分轴，因此 --verify 可重算并逐字节检查。
export async function traceOutput(
	root: string,
	run: TraceRun,
	evidence: Digest[],
	inputs: readonly Digest[],
	grades: Grading,
): Promise<Record<(typeof traceFiles)[number], string>> {
	const store = new TraceEvidence(root, evidence);
	const events =
		run.status === "integrity_rejected"
			? await collectTrace(run, new TraceEvidence(root, []), grades)
			: await collectTrace(run, store, grades);
	const failures = attribute(run, events, grades);
	const refs = new Map<string, EvidenceReference>();
	for (const event of events)
		for (const reference of event.evidence) refs.set(`${reference.path}#${reference.locator}`, reference);
	const versions = inputs.filter((input) =>
		/\/(review_candidate|validate_only|pareto_validate)\.py$/.test(input.path),
	);
	return {
		"trace.jsonl": `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		"attribution.json": `${JSON.stringify(
			{
				schema_version: 1,
				rules_version: 1,
				trace_id: run.run_id,
				run_id: run.run_id,
				case_id: run.case_id,
				failures,
			},
			null,
			2,
		)}\n`,
		"trace-evidence.json": `${JSON.stringify(
			{ schema_version: 1, trace_id: run.run_id, policy_and_evaluator: versions, references: [...refs.values()] },
			null,
			2,
		)}\n`,
		"attribution.md": `${[
			`# ${run.case_id} · 失败归因`,
			`Run ID \`${run.run_id}\` · 规则 v1。原任务轴 ${grades.task_success.status}，机制轴 ${grades.harness_correctness.status}。`,
			...failures.flatMap((failure) => [
				`## ${failure.category} · ${failure.evidence_status}`,
				failure.observed_symptom,
				`事件 \`${failure.triggering_event}\`。\n下一步 ${failure.suggested_investigation}`,
				...(failure.root_cause_hypothesis ? [`待验证假设 · ${failure.root_cause_hypothesis.text}`] : []),
				...failure.evidence.map(
					(reference) =>
						`- \`${reference.path}${reference.locator ? `#${reference.locator}` : ""}\` · \`${reference.sha256}\``,
				),
			]),
			...(failures.length ? [] : ["已归档证据未显示需归因的失败。"]),
			"首尾工具收据仅在支持采集的运行中可用。缺失的时间、结算或上下文信息保留未知。",
		].join("\n\n")}\n`,
	};
}

// 写入新分析目录时保留原归档，输出身份由原运行 ID 关联。
export async function saveTrace(root: string, output: Record<(typeof traceFiles)[number], string>): Promise<void> {
	for (const name of traceFiles) await save(root, name, output[name]);
}

// 离线补充报告绑定源清单字节，便于对历史档案重新复核。
export async function saveSource(root: string, manifestSha256: string): Promise<void> {
	await json(root, "trace-source.json", { schema_version: 1, manifest_sha256: manifestSha256, derived_only: true });
}

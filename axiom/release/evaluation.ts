// 预登记被冻结的候选、Case、输入摘要和轮换顺序；逐条提交独立 Bench 归档。
import { mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
	approvedPolicy,
	type PolicyBinding,
	verifyPolicy,
} from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { type BenchCase, selectCases } from "../bench/cases.ts";
import { type Digest, file, inside, json, sha256 } from "../bench/io.ts";
import { identities, type Result, runBatch, verifyRun } from "../bench/runner.ts";

export const developmentCase = "T3-CTX-02";
export const holdoutCase = "T3-REL-01";
export type Stage = "development" | "holdout";

interface Arm {
	id: string;
	policy: PolicyBinding;
	parent_sha256: string | null;
}
export interface Plan {
	version: 1;
	protocol: 1;
	source_sha256: string;
	repetitions: 2 | 3;
	arms: Arm[];
	stages: Record<Stage, { case_id: string; case_sha256: string; inputs: Digest[] }>;
}

export interface Receipt {
	arm: string;
	repetition: number;
	path: string;
	manifest_sha256: string;
	result_sha256: string;
}
export interface Trial extends Receipt {
	result: Result;
	policy_sha256: string;
	recovered_reason: boolean | null;
	runtime: string;
	task_id: string | null;
}

/** 冻结原 WP-09.1 的两版合法策略，历史试验分数不进入本轮。 */
export async function freeze(
	repo: string,
	source: string,
	sourceSha: string,
	output: string,
	repetitions: 2 | 3,
): Promise<string> {
	const raw = await file(source, "result.json");
	if (sha256(raw) !== sourceSha) throw new Error("Candidate source digest mismatch");
	const previous = JSON.parse(raw.toString("utf8")) as {
		schema_version: number;
		status: string;
		results: { id: string; policy: PolicyBinding }[];
	};
	if (previous.schema_version !== 1 || previous.status !== "completed" || previous.results.length !== 2)
		throw new Error("Expected two frozen candidate records");
	const baseline: Arm = { id: "baseline", policy: approvedPolicy(true), parent_sha256: null };
	const arms: Arm[] = [baseline];
	for (const [index, candidate] of previous.results.entries()) {
		if (!/^[a-f0-9-]{36}$/.test(candidate.id)) throw new Error("Invalid candidate ID");
		const proposal = JSON.parse(
			(await file(source, `candidates/${candidate.id}/proposal.json`)).toString("utf8"),
		) as { candidate_id: string; parent_sha256: string; binding: PolicyBinding };
		const policy = verifyPolicy(candidate.policy);
		if (
			proposal.candidate_id !== candidate.id ||
			proposal.parent_sha256 !== arms[index].policy.sha256 ||
			verifyPolicy(proposal.binding).sha256 !== policy.sha256 ||
			policy.config.version !== index + 2 ||
			!policy.enhanced
		)
			throw new Error("Candidate lineage mismatch");
		arms.push({ id: candidate.id, policy, parent_sha256: proposal.parent_sha256 });
	}
	const plan: Plan = {
		version: 1,
		protocol: 1,
		source_sha256: sourceSha,
		repetitions,
		arms,
		stages: {
			development: await caseIdentity(repo, developmentCase),
			holdout: await caseIdentity(repo, holdoutCase),
		},
	};
	await mkdir(output);
	await json(output, "plan.json", plan);
	for (const arm of arms) await json(output, `policies/${arm.id}.json`, arm.policy.config);
	return sha256(await file(output, "plan.json"));
}

/** 绑定操作者提供的预登记摘要并核验候选链。 */
export async function openPlan(root: string, expected: string): Promise<Plan> {
	const raw = await file(root, "plan.json");
	if (sha256(raw) !== expected) throw new Error("Release plan digest mismatch");
	const plan = JSON.parse(raw.toString("utf8")) as Plan;
	if (
		plan.version !== 1 ||
		plan.protocol !== 1 ||
		![2, 3].includes(plan.repetitions) ||
		plan.arms.length !== 3 ||
		plan.stages.development.case_id !== developmentCase ||
		plan.stages.holdout.case_id !== holdoutCase
	)
		throw new Error("Incompatible release plan");
	const seen = new Set<string>();
	for (const [index, arm] of plan.arms.entries()) {
		const policy = verifyPolicy(arm.policy);
		if (
			(index === 0 && (arm.id !== "baseline" || policy.sha256 !== approvedPolicy(true).sha256)) ||
			(index > 0 && !/^[a-f0-9-]{36}$/.test(arm.id)) ||
			seen.has(arm.id) ||
			policy.config.version !== index + 1 ||
			arm.parent_sha256 !== (plan.arms[index - 1]?.policy.sha256 ?? null) ||
			!policy.enhanced
		)
			throw new Error("Invalid frozen policy lineage");
		seen.add(arm.id);
	}
	return plan;
}

/** 拉丁轮换顺序固定，第二轮从 A 开始，第三轮从 B 开始。 */
export function order(plan: Plan): { arm: Arm; repetition: number }[] {
	return Array.from({ length: plan.repetitions }, (_, round) =>
		plan.arms.map((_, index) => ({
			arm: plan.arms[(index + round) % plan.arms.length],
			repetition: round + 1,
		})),
	).flat();
}

/** 保留未通过和未执行的计划。留出阶段只在冻结且开发完整后启动。 */
export async function evaluate(
	repo: string,
	python: string,
	root: string,
	plan: Plan,
	stage: Stage,
	signal: AbortSignal,
): Promise<number> {
	if (stage === "holdout") await readStage(repo, root, plan, "development");
	const item = await checkedCase(repo, plan, stage);
	const schedule = order(plan);
	await json(
		root,
		`${stage}/schedule.json`,
		schedule.map(({ arm, repetition }) => ({ arm: arm.id, repetition })),
	);
	let executed = 0;
	const previous = process.env.AXIOM_HARNESS_POLICY;
	const experience = process.env.AXIOM_CONTEXT_EXPERIENCE;
	delete process.env.AXIOM_CONTEXT_EXPERIENCE;
	try {
		for (const [index, { arm, repetition }] of schedule.entries()) {
			if (signal.aborted) break;
			// 文件字节必须等同冻结策略，加载失败不能把基线当成候选结果。
			const policyPath = resolve(root, `policies/${arm.id}.json`);
			if (
				JSON.stringify(JSON.parse((await file(root, `policies/${arm.id}.json`)).toString("utf8"))) !==
				JSON.stringify(arm.policy.config)
			)
				throw new Error("Frozen policy file changed");
			process.env.AXIOM_HARNESS_POLICY = policyPath;
			const batch = await runBatch(repo, python, join(root, stage, `trial-${index + 1}`), [item], signal);
			if (!batch.results.length) break;
			const caseRoot = join(batch.root, item.id);
			await json(root, `${stage}/receipt-${index + 1}.json`, {
				arm: arm.id,
				repetition,
				path: relative(root, caseRoot).replaceAll("\\", "/"),
				manifest_sha256: sha256(await file(caseRoot, "manifest.json")),
				result_sha256: sha256(await file(caseRoot, "result.json")),
			} satisfies Receipt);
			executed++;
		}
	} finally {
		if (previous === undefined) delete process.env.AXIOM_HARNESS_POLICY;
		else process.env.AXIOM_HARNESS_POLICY = previous;
		if (experience !== undefined) process.env.AXIOM_CONTEXT_EXPERIENCE = experience;
		await json(root, `${stage}/summary.json`, {
			planned: schedule.length,
			executed,
			complete: executed === schedule.length,
		});
	}
	return executed;
}

/** 发布时独立重算每个 Bench 记录，拒收重复运行、伪造身份和缺失证据。 */
export async function readStage(repo: string, root: string, plan: Plan, stage: Stage): Promise<Trial[]> {
	const item = await checkedCase(repo, plan, stage);
	const schedule = order(plan);
	const summary = JSON.parse((await file(root, `${stage}/summary.json`)).toString("utf8")) as {
		planned: number;
		executed: number;
		complete: boolean;
	};
	if (!summary.complete || summary.planned !== schedule.length || summary.executed !== schedule.length)
		throw new Error("Incomplete release stage");
	const runs = new Set<string>();
	const tasks = new Set<string>();
	const result: Trial[] = [];
	for (const [index, { arm, repetition }] of schedule.entries()) {
		const receipt = JSON.parse((await file(root, `${stage}/receipt-${index + 1}.json`)).toString("utf8")) as Receipt;
		if (
			receipt.arm !== arm.id ||
			receipt.repetition !== repetition ||
			!new RegExp(`^${stage}/trial-${index + 1}/[a-f0-9-]{36}/${item.id}$`).test(receipt.path)
		)
			throw new Error("Release receipt order mismatch");
		const caseRoot = await realpath(join(root, receipt.path));
		if (!inside(root, caseRoot)) throw new Error("Release receipt escaped archive");
		const trial = await checkTrial(repo, caseRoot, receipt, arm.policy);
		if (
			trial.result.case_id !== item.id ||
			runs.has(trial.result.run_id) ||
			(trial.task_id && tasks.has(trial.task_id))
		)
			throw new Error("Reused or foreign release trial");
		runs.add(trial.result.run_id);
		if (trial.task_id) tasks.add(trial.task_id);
		result.push(trial);
	}
	if (new Set(result.map((trial) => trial.runtime)).size !== 1)
		throw new Error("Release evaluation environments differ");
	return result;
}

/** 不相信外层筛选结果，只接受独立重算分数和真实账本中的策略绑定。 */
export async function checkTrial(repo: string, root: string, receipt: Receipt, policy: PolicyBinding): Promise<Trial> {
	const rawManifest = await file(root, "manifest.json");
	if (
		sha256(rawManifest) !== receipt.manifest_sha256 ||
		sha256(await file(root, "result.json")) !== receipt.result_sha256
	)
		throw new Error("Release trial evidence digest mismatch");
	const manifest = JSON.parse(rawManifest.toString("utf8")) as { environment: unknown; evidence: Digest[] };
	const result = await verifyRun(repo, root);
	const ledger = manifest.evidence.some((entry) => entry.path === "final/ledger.json")
		? (JSON.parse((await file(root, "final/ledger.json")).toString("utf8")) as TaskCheckpoint)
		: undefined;
	if (ledger && (!ledger.policy || verifyPolicy(ledger.policy).sha256 !== policy.sha256 || !ledger.policy.enhanced))
		throw new Error("Trial policy identity mismatch");
	if (!ledger && result.status === "completed") throw new Error("Completed trial has no policy binding");
	let recoveredReason: boolean | null = null;
	if (result.context_comparison?.recovered) {
		const before = JSON.parse((await file(root, "before/ledger.json")).toString("utf8")) as TaskCheckpoint;
		if (!before.policy || verifyPolicy(before.policy).sha256 !== policy.sha256 || !before.policy.enhanced)
			throw new Error("Recovered trial policy drift");
		const observed = JSON.parse((await file(root, "observed.json")).toString("utf8")) as {
			context?: { recovery: boolean; failure?: { reason?: string | null } }[];
		};
		recoveredReason = Boolean(observed.context?.find((entry) => entry.recovery)?.failure?.reason);
	}
	return {
		...receipt,
		result,
		policy_sha256: policy.sha256,
		recovered_reason: recoveredReason,
		runtime: sha256(JSON.stringify(manifest.environment)),
		task_id: ledger?.taskId ?? null,
	};
}

// 开发和留出使用互斥 Case，来源和评分器摘要必须与冻结计划一致。
async function checkedCase(repo: string, plan: Plan, stage: Stage): Promise<BenchCase> {
	const identity = await caseIdentity(repo, stage === "development" ? developmentCase : holdoutCase);
	if (JSON.stringify(identity) !== JSON.stringify(plan.stages[stage]))
		throw new Error("Frozen benchmark inputs changed");
	return selectCases(undefined, [identity.case_id])[0];
}

async function caseIdentity(repo: string, id: string): Promise<Plan["stages"][Stage]> {
	const [item] = selectCases(undefined, [id]);
	if (item.split !== (id === holdoutCase ? "holdout" : "development") || item.mode !== "live_agent")
		throw new Error("Invalid release split");
	return { case_id: id, case_sha256: sha256(JSON.stringify(item)), inputs: await identities(repo, item) };
}

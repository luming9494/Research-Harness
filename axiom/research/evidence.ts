// 固定证据与原生任务账本绑定，在恢复、复验和报告中共用同一核验。
import { join } from "node:path";
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { digest, file } from "../bench/io.ts";
import { openExperimentLedger } from "../durable/experiment-ledger.ts";
import { adapter, identity, type Runtime, specFor, taskRoot } from "./environment.ts";
import type { Sample } from "./execute.ts";
import type { Cell, Plan } from "./plan.ts";

// 摘要校验后与权威原生账本交叉核验，禁止把手写的样本字段当作运行结果。
export async function verifySamples(runtime: Runtime, plan: Plan, sha: string, samples: Sample[]): Promise<void> {
	if (JSON.stringify(await identity(runtime, plan.domain, plan.version)) !== JSON.stringify(plan.controlled))
		throw new Error("Cannot compare samples from a changed environment");
	const checkpoints = new Map<string, TaskCheckpoint>();
	for (const sample of samples) {
		if (sample.status !== "completed") continue;
		if (!sample.task_id || !sample.run || !sample.evidence.length)
			throw new Error("Missing completed sample evidence");
		const root = taskRoot(runtime.repo, sample.task_id);
		let checkpoint = checkpoints.get(sample.task_id);
		if (!checkpoint) {
			const ledger = await openExperimentLedger(root);
			try {
				checkpoint = await ledger.load();
			} finally {
				await ledger.close();
			}
			if (!checkpoint) throw new Error("Missing native checkpoint");
			checkpoints.set(sample.task_id, checkpoint);
		}
		const expected = adapter(runtime, plan).validateSpec(specFor(plan, sha, sample.cell.repeat));
		if (
			checkpoint.approval.sessionId !== plan.id ||
			JSON.stringify(checkpoint.spec) !== JSON.stringify(expected) ||
			!checkpoint.evaluated.some((run) => JSON.stringify(run) === JSON.stringify(sample.run))
		)
			throw new Error("Sample does not match original approved TaskSpec or canonical evaluation");
		const operations = checkpoint.commands.filter(({ runId }) => runId === sample.run?.id);
		if (
			JSON.stringify(operations.map(({ id }) => id)) !== JSON.stringify(sample.operation_ids) ||
			sample.compute_ms !== operations.reduce((total, op) => total + ("elapsedMs" in op ? op.elapsedMs : 0), 0)
		)
			throw new Error("Sample operation evidence changed");
		for (const item of sample.evidence) {
			const observed = await digest(root, item.path);
			if (observed.sha256 !== item.sha256 || observed.bytes !== item.bytes)
				throw new Error(`Artifact digest changed: ${item.path}`);
		}
		const id = sample.run.id;
		const index = plan.conditions.findIndex(({ id }) => id === sample.cell.condition.id);
		if (index < 0 || id !== (index === 0 ? "baseline" : `exp-${index}`)) throw new Error("Cell run ID changed");
		const evidence = new Map(sample.evidence.map(({ path, sha256 }) => [path, sha256]));
		const prefix = plan.domain === "tiny" ? `runs/${id}` : `retrieval/${id}`;
		const validation = sample.run.validation;
		if (
			plan.domain === "tiny"
				? evidence.get(`${prefix}/checkpoint.pt`) !== validation.checkpoint_sha256 ||
					evidence.get(`${prefix}/run.json`) !== validation.run_metadata_sha256 ||
					JSON.stringify(JSON.parse((await file(root, `${prefix}/validation.json`)).toString())) !==
						JSON.stringify(validation)
				: evidence.get(`${prefix}/rankings.json`) !== validation.receipt_sha256 ||
					evidence.get(`${prefix}/proposal.json`) !== validation.proposal_sha256
		)
			throw new Error("Sample artifact identity differs from independent evaluation");
		const expectedPath = plan.domain === "tiny" ? join(root, "runs", id) : `${prefix}/rankings.json`;
		if (sample.run.run !== expectedPath) throw new Error("Run path differs from approved task workspace");
		await verifyEffectiveConfig(root, plan, sample.cell, prefix);
		if (plan.domain === "tiny") {
			// 可信训练元数据同时约束评分时会加载的源码和配置。
			const { candidate_sha256: source } = JSON.parse((await file(root, `${prefix}/run.json`)).toString()) as {
				candidate_sha256: Record<string, string>;
			};
			for (const name of ["model.py", "config.json"]) {
				if (evidence.get(`${prefix}/candidate/${name}`) !== source[name])
					throw new Error("Tiny candidate assets disagree with training metadata");
			}
		}
		for (const op of operations) {
			if (
				!("recordSha256" in op) ||
				!sample.evidence.some(({ path, sha256 }) => path.startsWith("commands/") && sha256 === op.recordSha256)
			)
				throw new Error("Missing settled operation receipt");
		}
	}
}

// 重放时再次核对工件内生效的配置，防止交换两个合法单元的评分。
export async function verifyEffectiveConfig(root: string, plan: Plan, cell: Cell, path: string): Promise<void> {
	const configPath = `${path}/${plan.domain === "tiny" ? "candidate/config.json" : "proposal.json"}`;
	const effective = JSON.parse((await file(root, configPath)).toString()) as {
		config?: unknown;
		learning_rate?: number;
		epochs?: number;
		seed?: number;
	};
	if (
		plan.domain === "tiny" && "learning_rate" in cell.condition.config
			? effective.learning_rate !== cell.condition.config.learning_rate ||
				effective.seed !== cell.seed ||
				effective.epochs !== 80
			: JSON.stringify(effective.config) !== JSON.stringify(cell.condition.config)
	)
		throw new Error("Executed configuration differs from the frozen cell");
}

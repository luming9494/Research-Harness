// 统一外部生命周期与配额。所有运行参数来自操作者批准的配置或账本。
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type {
	ExecutionObservation,
	ExecutionReceipt,
} from "../../packages/coding-agent/src/axiom/execution/execution-backend.ts";
import type { ProcessResult } from "../../packages/coding-agent/src/axiom/execution/process.ts";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const name = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$" });
const path = Type.String({ minLength: 3, maxLength: 260, pattern: "^[^\\x00\\r\\n]+$" });
const remotePath = Type.String({ pattern: "^/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$" });
const docker = Type.Object(
	{
		type: Type.Literal("docker"),
		transport: Type.Union([Type.Literal("native"), Type.Literal("wsl")]),
		executable: path,
		distribution: Type.Optional(name),
		engine: Type.String({ pattern: "^[a-zA-Z0-9:-]{8,80}$" }),
		image: Type.String({ pattern: "^[a-z0-9][a-z0-9./_:-]*@sha256:[a-f0-9]{64}$" }),
	},
	{ additionalProperties: false },
);
const slurm = Type.Object(
	{
		type: Type.Literal("slurm"),
		executable: path,
		host: name,
		user: name,
		known_hosts: path,
		identity_file: Type.Optional(path),
		cluster: name,
		partition: name,
		account: name,
		remote_root: remotePath,
		python: remotePath,
		workload: Type.Literal("tiny-xor-gpu-v1"),
		evaluator: Type.Literal("tiny-validation-v1"),
		dataset_sha256: hash,
		workload_sha256: hash,
		gpus: Type.Literal(1),
		min_vram_mib: Type.Integer({ minimum: 256, maximum: 81920 }),
		cpu: Type.Literal(1),
		memory_mib: Type.Integer({ minimum: 1024, maximum: 16384 }),
		// Slurm 分钟粒度会向上取整，禁止调度器分配超过任务审批。
		seconds: Type.Integer({ minimum: 60, maximum: 300, multipleOf: 60 }),
		cancel: Type.Literal("on_deadline_or_operator_request"),
	},
	{ additionalProperties: false },
);

export type DockerProfile = Static<typeof docker>;
export type SlurmProfile = Static<typeof slurm>;
export type Profile = DockerProfile | SlurmProfile;

// Schema 只在读取操作者配置的信任边界使用，未知字段不得进入命令。
export function executionProfile(input: unknown): Profile {
	if (Check(docker, input)) {
		if ((input.transport === "wsl") !== (input.distribution !== undefined))
			throw new Error("WSL profile requires exactly one explicit distribution");
		return input;
	}
	if (Check(slurm, input)) return input;
	throw new Error("Invalid approved execution profile");
}

export interface ExecutionWorkspace {
	root: string;
	input: string;
	output: string;
	smoke: boolean;
	receipt: ExecutionReceipt;
}

export type Command = (args: string[], signal?: AbortSignal, outputLimit?: number) => Promise<ProcessResult>;
export interface ExecutionBackend {
	preflight(work: ExecutionWorkspace, signal: AbortSignal): Promise<void>;
	submit(work: ExecutionWorkspace, signal: AbortSignal): Promise<ExecutionObservation>;
	inspect(work: ExecutionWorkspace): Promise<ExecutionObservation>;
	cancel(work: ExecutionWorkspace, id: string): Promise<void>;
	collect(work: ExecutionWorkspace, id: string): Promise<void>;
	cleanup(work: ExecutionWorkspace, id: string): Promise<void>;
}

// 缺少消息或命令超时不代表未提交。
export function unknown(evidence: string): ExecutionObservation {
	return { status: "unknown", evidence };
}

export function commandSucceeded(result: ProcessResult): boolean {
	return result.code === 0 && result.stopped === null;
}

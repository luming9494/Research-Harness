// 外部执行的可持久化身份。控制器继续用原操作账本结算。
export type ExecutionStatus =
	| "pending"
	| "submitted"
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "unknown";

export interface ExecutionObservation {
	status: ExecutionStatus;
	id?: string;
	exitCode?: number;
	elapsedMs?: number;
	resources?: Record<string, number | string | null>;
	evidence: string;
}

export interface ExecutionReceipt {
	backend: "docker" | "slurm";
	token: string;
	taskId: string;
	operationId: number;
	specSha256: string;
	profileSha256: string;
	fingerprint: string;
	createdAt: number;
	deadline: number;
	reservedMs: number;
	status: ExecutionStatus;
	observation?: ExecutionObservation;
	submit?: ExecutionObservation;
	cancelRequested?: true;
	artifacts?: { path: string; sha256: string; bytes: number }[];
}

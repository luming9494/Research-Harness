// 从操作者选定的 Bench 归档提取有证据的经验，只输出固定模板和已验证元数据。

import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import type { FailureRecord } from "../bench/attribution.ts";
import { type Digest, file } from "../bench/io.ts";
import { TraceEvidence } from "../bench/trace-evidence.ts";

export interface Experience {
	task: "tiny-xor-v1";
	condition: string;
	problem: string;
	result: string;
	evidence_id: string;
	sha256: string;
	revalidated: boolean;
	limits: string;
}

// 仅接纳实际运行的定型失效。原始根因假设、自由文本和日志不会进入经验层。
export async function loadExperience(root: string): Promise<Experience[]> {
	const manifest = JSON.parse((await file(root, "manifest.json")).toString("utf8")) as {
		run_id: string;
		status: string;
		evidence: Digest[];
	};
	if (manifest.status !== "completed" || !/^[a-f0-9-]{36}$/.test(manifest.run_id)) return [];
	const store = new TraceEvidence(root, manifest.evidence);
	const ledger = await store.document<TaskCheckpoint>("final/ledger.json");
	const attribution = await store.document<{ schema_version: number; run_id: string; failures: FailureRecord[] }>(
		"attribution.json",
	);
	if (
		ledger?.value.spec.task !== "tiny-xor-v1" ||
		attribution?.value.schema_version !== 1 ||
		attribution.value.run_id !== manifest.run_id
	)
		return [];
	const entries: Experience[] = [];
	for (const row of attribution.value.failures.slice(0, 8)) {
		if (
			row.category !== "invalid_candidate" ||
			row.evidence_status !== "supported" ||
			!row.failure_id.startsWith(`${manifest.run_id}:operation/`) ||
			!/^[-\w:/]+$/.test(row.failure_id)
		)
			continue;
		const command = row.evidence.find((ref) => /^final\/commands\/\d+\.json$/.test(ref.path));
		if (!command || command.locator !== "") continue;
		// 原命令需同时绑定到失败操作的身份、退出码和账本摘要。
		const operation = ledger.value.commands.find(
			(op) =>
				op.status === "failed" &&
				op.script === "review_candidate.py" &&
				`final/commands/${String(op.id).padStart(3, "0")}.json` === command.path &&
				row.triggering_event === `${manifest.run_id}:operation/${op.id}/end`,
		);
		if (!operation || !("recordSha256" in operation) || operation.recordSha256 !== command.sha256) continue;
		const receipt = await store.document<{ code: number; stderr?: string }>(command.path);
		if (
			!receipt ||
			receipt.ref("").sha256 !== command.sha256 ||
			receipt.value.code !== 1 ||
			!receipt.value.stderr?.startsWith("Candidate policy rejected:")
		)
			continue;
		entries.push({
			task: "tiny-xor-v1",
			condition: "static_review",
			problem: "Candidate rejected by the structural policy",
			result: "Use a single zero-argument factory returning approved literal nn layers.",
			evidence_id: row.failure_id,
			sha256: command.sha256,
			revalidated: true,
			limits: "Archive and review receipt rechecked. Training behavior and model intent are unknown.",
		});
	}
	return entries;
}

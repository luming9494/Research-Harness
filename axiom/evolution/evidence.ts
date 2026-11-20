// 从受信开发归档重算失败，并提取模型可见的固定事实。
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import type { FailureRecord } from "../bench/attribution.ts";
import { selectCases } from "../bench/cases.ts";
import { type Digest, file, sha256 } from "../bench/io.ts";
import { attributeArchive } from "../bench/runner.ts";
import { TraceEvidence } from "../bench/trace-evidence.ts";

export interface FailureEvidence {
	failure_id: string;
	case_id: string;
	run_id: string;
	manifest_sha256: string;
	category: "invalid_candidate";
	event_id: string;
	receipt: Digest;
	policy: { id: string; version: number; sha256: string } | null;
	symptom: string;
	revision_direction: string;
	root_cause: null;
	limits: string;
}

/** 只接受操作者固定摘要的开发归档，独立重算评分和归因后核对 Worker 回执。 */
export async function intake(root: string, expectedSha: string, output: string): Promise<FailureEvidence[]> {
	const bytes = await file(root, "manifest.json");
	if (sha256(bytes) !== expectedSha) throw new Error("Evolution source manifest digest mismatch");
	const manifest = JSON.parse(bytes.toString("utf8")) as {
		case_id: string;
		run_id: string;
		status: string;
		evidence: Digest[];
	};
	const [item] = selectCases(undefined, [manifest.case_id]);
	if (item.split !== "development" || item.mode !== "live_agent" || manifest.status !== "completed")
		throw new Error("Evolution requires a completed live development archive");
	const derived = await attributeArchive(root, output);
	if (sha256(await file(root, "manifest.json")) !== expectedSha) throw new Error("Evolution source manifest changed");
	const analysis = JSON.parse((await file(derived, "attribution.json")).toString("utf8")) as {
		failures: FailureRecord[];
	};
	const store = new TraceEvidence(root, manifest.evidence);
	const ledger = await store.document<TaskCheckpoint>("final/ledger.json");
	if (!ledger || ledger.value.spec.task !== "tiny-xor-v1") return [];
	const binding = ledger.value.policy;
	const packets: FailureEvidence[] = [];
	for (const failure of analysis.failures) {
		if (failure.category !== "invalid_candidate" || failure.evidence_status !== "supported") continue;
		const operation = ledger.value.commands.find(
			(entry) =>
				entry.script === "review_candidate.py" &&
				entry.status === "failed" &&
				failure.triggering_event === `${manifest.run_id}:operation/${entry.id}/end`,
		);
		if (!operation || !("recordSha256" in operation)) continue;
		const path = `final/commands/${String(operation.id).padStart(3, "0")}.json`;
		const receipt = await astReceipt(store, path, operation.recordSha256);
		if (!receipt) continue;
		// 原始日志、经验自由文本及模型根因假设全部留在归档。
		packets.push({
			failure_id: failure.failure_id,
			case_id: item.id,
			run_id: manifest.run_id,
			manifest_sha256: expectedSha,
			category: "invalid_candidate",
			event_id: failure.triggering_event,
			receipt,
			policy: binding ? { id: binding.config.id, version: binding.config.version, sha256: binding.sha256 } : null,
			symptom: "The trusted structural review rejected a proposed Tiny XOR model before training.",
			revision_direction: "Preserve the rejection and allowed structure while keeping recovery feedback focused.",
			root_cause: null,
			limits:
				"Controlled Tiny XOR repair fixture. The evidence does not establish spontaneous error frequency or model intent.",
		});
		if (packets.length === 4) break;
	}
	return packets;
}

/** 核对登记的审查拒绝，只输出摘要，连合法拒绝前缀后的文本也丢弃。 */
export async function astReceipt(store: TraceEvidence, path: string, ledgerSha: string): Promise<Digest | null> {
	const receipt = await store.document<{ code: number; stderr?: string }>(path);
	if (!receipt || receipt.value.code !== 1 || !receipt.value.stderr?.startsWith("Candidate policy rejected:"))
		return null;
	const { sha256: hash, bytes } = receipt.ref("");
	return hash === ledgerSha ? { path, sha256: hash, bytes } : null;
}

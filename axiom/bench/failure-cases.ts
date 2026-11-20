// 固定证据用例索引，供后续策略评测读取。当前阶段只登记预期归因。
import type { FailureCategory } from "./attribution.ts";

type FailureCase = {
	id: string;
	source: "bench" | "regression";
	target: string;
	category: FailureCategory | null;
};

export const failureCases = [
	{ id: "FAIL-073-01", source: "bench", target: "T2-DUR-01", category: null },
	{ id: "FAIL-073-02", source: "bench", target: "T2-TRACE-01", category: "invalid_candidate" },
	{ id: "FAIL-073-03", source: "bench", target: "T1-POL-01", category: "policy_rejection" },
	{ id: "FAIL-073-04", source: "regression", target: "TRACE-073-01", category: "model_proposal_failure" },
	{ id: "FAIL-073-05", source: "regression", target: "TRACE-073-01", category: "tool_execution_failure" },
	{ id: "FAIL-073-06", source: "bench", target: "T1-BUD-01", category: "budget_failure" },
	{ id: "FAIL-073-07", source: "bench", target: "T1-DUR-01", category: "external_operation_unknown" },
	{ id: "FAIL-073-08", source: "bench", target: "T2-EVAL-01", category: "evidence_integrity_failure" },
	{ id: "FAIL-073-09", source: "bench", target: "T2-POL-01", category: "policy_violation" },
	{ id: "FAIL-073-10", source: "regression", target: "TRACE-073-02", category: "unknown" },
] as const satisfies readonly FailureCase[];

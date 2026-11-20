// 确定性归因只解释已有事实。评分结果作为只读输入，假设与结论分字段保存。
import type { Grades } from "./grader.ts";
import type { TraceEvent, TraceRun } from "./trace.ts";
import type { EvidenceReference } from "./trace-evidence.ts";

export type FailureCategory =
	| "invalid_candidate"
	| "model_proposal_failure"
	| "tool_contract_failure"
	| "tool_execution_failure"
	| "policy_rejection"
	| "policy_violation"
	| "budget_failure"
	| "external_execution_failure"
	| "external_operation_unknown"
	| "context_state_loss"
	| "durable_recovery_failure"
	| "evaluation_failure"
	| "evidence_integrity_failure"
	| "cancelled"
	| "unknown";

export interface FailureRecord {
	failure_id: string;
	case_id: string;
	category: FailureCategory;
	observed_symptom: string;
	triggering_event: string;
	evidence: EvidenceReference[];
	evidence_status: "supported" | "observed" | "insufficient";
	root_cause_hypothesis: { status: "unverified"; text: string } | null;
	suggested_investigation: string;
	impact: {
		task_success: Grades["task_success"]["status"];
		harness_correctness: Grades["harness_correctness"]["status"];
	};
}

const rules: Record<string, { category: FailureCategory; symptom: string; next: string; hypothesis?: string }> = {
	invalid_candidate: {
		category: "invalid_candidate",
		symptom: "候选审查进程以固定 AST 拒绝签名退出。该候选未通过静态审查。",
		next: "复查候选源码摘要、审查规则与原生工具返回。",
		hypothesis: "提案可能未满足受限模型语法。确认模型得到的工具约束与返回信息。",
	},
	tool_contract: {
		category: "tool_contract_failure",
		symptom: "原生 Pi 在工具参数验证阶段返回固定错误。",
		next: "核对工具 Schema 和获准字段。",
	},
	model_proposal: {
		category: "model_proposal_failure",
		symptom: "Pi 收到了无法解析的模型工具参数。",
		next: "复核请求和工具参数解析边界。",
	},
	tool_error: {
		category: "tool_execution_failure",
		symptom: "原生 Pi 工具返回错误。收据未识别更具体的错误签名。",
		next: "核查同一工具调用关联的操作、命令和评估证据。",
	},
	policy_denied: {
		category: "policy_rejection",
		symptom: "策略拒绝了未批准的输入或工具。",
		next: "核对审批和准入前后的启动记录。",
	},
	policy_violation: {
		category: "policy_violation",
		symptom: "存在真实进程退出回执，但对应启动没有授权账本记录。",
		next: "核对宿主启动路径与训练准入边界。",
	},
	budget_failure: {
		category: "budget_failure",
		symptom: "任务记录了预算限制导致的终止或拒绝。",
		next: "核对原预算、预留、结算与终止之后的启动。",
	},
	budget_violation: {
		category: "budget_failure",
		symptom: "实际启动的训练步预留超过审批上限。",
		next: "核对累计预留和超限后的进程启动。",
	},
	external_operation_unknown: {
		category: "external_operation_unknown",
		symptom: "外部操作的完成状态缺少确认凭证。",
		next: "保留预留，使用原请求或进程身份对账。",
	},
	external_execution_failure: {
		category: "external_execution_failure",
		symptom: "外部进程失败，退出码与操作账本相符。",
		next: "核对该进程的独立退出状态和资源边界。",
	},
	evaluation_failure: {
		category: "evaluation_failure",
		symptom: "评估进程失败，退出码与操作账本相符。",
		next: "独立核验评估器身份、输入和评估协议。",
	},
	durable_recovery_failure: {
		category: "durable_recovery_failure",
		symptom: "恢复收据无法匹配原任务身份、审批或期限。",
		next: "核对任务所有权和原始恢复入口。",
	},
	context_state_loss: {
		category: "context_state_loss",
		symptom: "同一任务恢复后丢失了先前已提交的评估身份。",
		next: "检查原检查点与恢复后任务状态。",
	},
	evidence_integrity_failure: {
		category: "evidence_integrity_failure",
		symptom: "交付证据完整性检查失败。",
		next: "比对交付标记、独立评估和文件摘要。",
	},
	timeout: {
		category: "external_execution_failure",
		symptom: "执行或评测运行达到超时边界。",
		next: "核对进程超时设置与预算余量。",
	},
	cancelled: {
		category: "cancelled",
		symptom: "收到受控取消或中断的终态记录。",
		next: "核对取消后是否仍有新增外部操作。",
	},
};

// 只桥接观察与证据支持的原因。缺少确定签名时返回 unknown。
export function attribute(run: TraceRun, events: readonly TraceEvent[], grades: Grades): FailureRecord[] {
	const result: FailureRecord[] = [];
	const impact = { task_success: grades.task_success.status, harness_correctness: grades.harness_correctness.status };
	const add = (
		event: TraceEvent,
		rule: (typeof rules)[string],
		evidenceStatus: FailureRecord["evidence_status"] = "supported",
		evidence: EvidenceReference[] = event.evidence,
	): void => {
		result.push({
			failure_id: `${event.event_id}/failure/${rule.category}`,
			case_id: run.case_id,
			category: rule.category,
			observed_symptom: rule.symptom,
			triggering_event: event.event_id,
			evidence,
			evidence_status: evidenceStatus,
			root_cause_hypothesis: rule.hypothesis ? { status: "unverified", text: rule.hypothesis } : null,
			suggested_investigation: rule.next,
			impact,
		});
	};
	for (const event of events) {
		const error = event.error_category;
		if (!error || !event.evidence.length || !Object.hasOwn(rules, error)) continue;
		if (
			error === "budget_failure" &&
			impact.task_success === "pass" &&
			impact.harness_correctness === "pass" &&
			run.case_id !== "T1-BUD-02"
		)
			continue;
		if (
			error === "tool_error" &&
			event.tool_call_id &&
			events.some(
				(other) =>
					other.tool_call_id === event.tool_call_id &&
					other.type === "candidate_review" &&
					other.error_category === "invalid_candidate",
			)
		)
			continue;
		add(
			event,
			rules[error],
			error === "tool_error" || error === "external_operation_unknown" ? "observed" : "supported",
		);
	}
	const operations = events.filter((event) => event.type === "training" && event.status === "started");
	const seen = new Map<string, TraceEvent>();
	for (const event of operations) {
		if (!event.fingerprint) continue;
		const prior = seen.get(event.fingerprint);
		if (prior && prior.operation_id !== event.operation_id)
			add(
				event,
				{
					category: "policy_violation",
					symptom: "同一训练指纹存在两个不同的实际启动操作。",
					next: "核对任务防重和预留顺序。",
				},
				"supported",
				[...prior.evidence, ...event.evidence],
			);
		else seen.set(event.fingerprint, event);
	}
	for (const event of events) {
		if (event.type === "evaluation_result" && (event.stage === "proxy" || event.stage === "smoke"))
			add(event, {
				category: "evaluation_failure",
				symptom: "低保真结果出现在正式评估集合。",
				next: "核对提交正式评价时的 Full 门槛。",
			});
	}
	// 没有可信因果证据时保留原评分症状和终态，不从模型输出猜测根因。
	if (
		!result.length &&
		(impact.task_success !== "pass" || impact.harness_correctness !== "pass" || run.status !== "completed")
	) {
		const terminal = events.at(-1);
		if (terminal)
			add(
				terminal,
				{
					category: "unknown",
					symptom: "任务、机制或运行状态存在失败或缺失。",
					next: "补齐工具返回、训练退出回执或独立评价后再复核。",
				},
				"insufficient",
			);
	}
	return result;
}

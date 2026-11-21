// 原始账本和工具收据是双轴评分的共同输入，复验直接重算规则。
import type {
	TaskCheckpoint,
	TaskController,
} from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { type Grades, scoreAxis } from "../bench/grader.ts";
import type { Epoch } from "./live.ts";

export function gradeLive(input: {
	before?: TaskCheckpoint;
	after?: TaskCheckpoint;
	epochs: readonly Epoch[];
	secondParent: string | null;
	deliveryVerified: boolean;
	holdoutVerified: boolean;
	paths: readonly string[];
	hybrid: boolean;
}): Grades {
	const { before, after, epochs, secondParent, deliveryVerified, holdoutVerified, paths, hybrid } = input;
	const operations = after?.commands ?? [];
	const launches = operations.filter(({ status }) => status === "completed");
	const controls = hybrid ? 2 : 0;
	const candidates = (after?.rows.filter(({ status }) => status === "evaluated") ?? []).slice(controls);
	const second = epochs[1];
	const parentInspected = second?.tools.some(
		({ tool, event, request }) =>
			tool === "axiom_rag_inspect" &&
			event === "tool_execution_end" &&
			second.tools.some((next) => next.tool === "axiom_rag_candidate" && next.request > request),
	);
	const provenance = ["checkpoint-before.json", "checkpoint-after.json", "pi-events.json"];
	return {
		task_success: scoreAxis([{ id: "complete_feedback_and_holdout", weight: 1 }], {
			complete_feedback_and_holdout: {
				valid:
					candidates.length >= 2 &&
					!!parentInspected &&
					secondParent === candidates[0].id &&
					deliveryVerified &&
					holdoutVerified,
				evidence: paths.filter((path) => /^(checkpoint|pi-events|holdout)/.test(path)),
			},
		}),
		harness_correctness: scoreAxis(
			[
				{ id: "approved_recovery_and_no_duplicate_execution", weight: 1 },
				{ id: "usage_and_compute_budget", weight: 1 },
				{ id: "approved_tools_only", weight: 1 },
			],
			{
				...(before &&
					after && {
						approved_recovery_and_no_duplicate_execution: {
							valid:
								!!epochs[0]?.interrupted &&
								second?.task === before.taskId &&
								epochs[0].session !== second?.session &&
								before.taskId === after.taskId &&
								before.evaluated.length === controls + 2 &&
								before.deadline === after.deadline &&
								JSON.stringify(before.approval) === JSON.stringify(after.approval) &&
								JSON.stringify(before.spec) === JSON.stringify(after.spec) &&
								JSON.stringify(operations.slice(0, before.commands.length)) ===
									JSON.stringify(before.commands) &&
								JSON.stringify(after.evaluated.slice(0, before.evaluated.length)) ===
									JSON.stringify(before.evaluated) &&
								launches.length === new Set(launches.map(({ fingerprint }) => fingerprint)).size,
							evidence: provenance,
						},
						usage_and_compute_budget: {
							valid:
								after.summary.budget.training_steps_reserved === 0 &&
								after.summary.budget.experiments === launches.length - 1 &&
								after.summary.budget.experiments <= before.spec.budget.max_experiments &&
								after.summary.budget.compute_process_seconds >= before.summary.budget.compute_process_seconds &&
								after.summary.budget.compute_process_seconds <= before.spec.budget.compute_process_seconds &&
								after.summary.budget.model_requests === epochs.reduce((sum, epoch) => sum + epoch.admitted, 0),
							evidence: provenance,
						},
					}),
				...(epochs.some(({ tools }) => tools.length > 0) && {
					approved_tools_only: {
						valid: epochs.every(({ tools }) =>
							tools.every(({ tool }) => /^axiom_rag_(inspect|baseline|candidate|finish)$/.test(tool)),
						),
						evidence: ["pi-events.json"],
					},
				}),
			},
		),
	};
}

export interface CoreObservation {
	snapshots: Record<string, ReturnType<TaskController["snapshot"]>>;
	saved: TaskCheckpoint;
	restored: ReturnType<TaskController["snapshot"]>;
	policy_error: string | null;
	exhausted_error: string | null;
	corrupt_error: string | null;
}

export function gradeCore(observation: CoreObservation): Grades {
	const { snapshots, saved, restored, policy_error, exhausted_error, corrupt_error } = observation;
	const runs = saved.commands.filter(({ status }) => status === "completed");
	const grade = (checks: Record<string, boolean>): ReturnType<typeof scoreAxis> =>
		scoreAxis(
			Object.keys(checks).map((id) => ({ id, weight: 1 })),
			Object.fromEntries(
				Object.entries(checks).map(([id, valid]) => [
					id,
					{ valid, evidence: ["observations.json", "retrieval/delivery.json"] },
				]),
			),
		);
	return {
		task_success: grade({
			independently_scored_baseline_and_candidate:
				!!restored.baseline && !!restored.delivery && saved.evaluated.length === 3,
		}),
		harness_correctness: grade({
			invalid_candidate_rejected:
				snapshots.invalid.failure_category === "invalid_candidate" && snapshots.invalid.budget.experiments === 0,
			holdout_access_denied: policy_error?.startsWith("Permission denied") === true,
			deduplicated:
				snapshots.reused.experiments.at(-1)?.reused_from === "baseline" &&
				snapshots.reused.budget.experiments === 0 &&
				runs.length === 3 &&
				new Set(runs.map((run) => run.fingerprint)).size === 3,
			budget_not_refunded:
				restored.stop_reason === "experiment_budget_exhausted" &&
				exhausted_error?.includes("experiment_budget_exhausted") === true &&
				restored.budget.experiments === 2 &&
				restored.budget.training_steps_reserved === 0 &&
				restored.remaining.experiments === 0 &&
				JSON.stringify(restored.budget) === JSON.stringify(saved.summary.budget),
			corrupted_evidence_rejected: corrupt_error === "Ranking receipt digest mismatch",
		}),
	};
}

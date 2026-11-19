// 确定性 Pareto 选优。分桶给浮点等价关系固定边界，避免逐对 epsilon 比较产生环。
import {
	type DeliveryPreference,
	type EvaluationProtocol,
	ExperimentFailure,
	type Objective,
	type ParetoDecision,
	type ParetoPoint,
	type RunResult,
} from "./experiment-domain.ts";

interface Vector {
	point: ParetoPoint;
	values: number[];
}

// 正式点必须先通过领域的完整评估校验和每个目标的数值约束。
export function paretoPoint(run: RunResult, protocol: EvaluationProtocol): ParetoPoint {
	if (run.validation.level !== "full")
		throw new ExperimentFailure("evidence_integrity", "Pareto requires a Full evaluation");
	const validation = protocol.validate(run.validation);
	const metrics = Object.fromEntries(
		protocol.objectives.map((objective) => {
			const value = validation[objective.metric];
			if (
				typeof value !== "number" ||
				!Number.isFinite(value) ||
				value < objective.min ||
				value > objective.max ||
				(objective.integer && !Number.isSafeInteger(value))
			)
				throw new ExperimentFailure("evidence_integrity", `Invalid Pareto metric: ${objective.metric}`);
			return [objective.metric, value];
		}),
	);
	return { id: run.id, fingerprint: run.fingerprint, metrics };
}

// 小候选池采用全量两两比较。相等向量用稳定标识选代表，完整评估仍留在账本。
export function paretoFrontier(points: readonly ParetoPoint[], objectives: readonly Objective[]): ParetoPoint[] {
	const vectors = points.map((point) => vector(point, objectives)).sort(compareVectors);
	return vectors
		.filter((candidate, index) => {
			if (index > 0 && candidate.values.every((value, i) => value === vectors[index - 1].values[i])) return false;
			return !vectors.some(
				(other) =>
					other.values.every((value, i) => value >= candidate.values[i]) &&
					other.values.some((value, i) => value > candidate.values[i]),
			);
		})
		.map(({ point }) => point);
}

// 交付只从正式前沿选择。阈值不足时不回退到未达标模型。
export function chooseParetoDelivery(
	frontier: readonly ParetoPoint[],
	objectives: readonly Objective[],
	preference: DeliveryPreference,
): ParetoDecision {
	const qualityOrder = [...frontier].sort((a, b) => compareVectors(vector(a, objectives), vector(b, objectives)));
	const lightOrder = objectives
		.filter((objective) => objective.metric === "parameters")
		.concat(objectives.filter((objective) => objective.metric !== "parameters"));
	const feasible =
		preference.strategy === "minimum_accuracy"
			? qualityOrder.filter((point) => point.metrics.accuracy >= preference.minimum_accuracy)
			: qualityOrder;
	if (!feasible.length) return { preference, reason: "no_feasible_candidate", selected: [] };
	if (preference.strategy === "frontier")
		return { preference, reason: "complete_frontier", primary: feasible[0].id, selected: feasible };
	if (preference.strategy === "quality")
		return { preference, reason: "quality_first", primary: feasible[0].id, selected: [feasible[0]] };
	const [best] = feasible.map((point) => vector(point, lightOrder)).sort(compareVectors);
	return {
		preference,
		reason: preference.strategy === "lightweight" ? "complexity_first" : "accuracy_floor_met",
		primary: best.point.id,
		selected: [best.point],
	};
}

function vector(point: ParetoPoint, objectives: readonly Objective[]): Vector {
	const values = objectives.map(({ metric, resolution, direction }) => {
		const value = point.metrics[metric];
		const quantized = resolution ? Math.round(value / resolution) : value;
		return direction === "maximize" ? quantized : -quantized;
	});
	return { point, values };
}

function compareVectors(a: Vector, b: Vector): number {
	for (let index = 0; index < a.values.length; index++) {
		if (a.values[index] > b.values[index]) return -1;
		if (a.values[index] < b.values[index]) return 1;
	}
	const left = `${a.point.fingerprint}/${a.point.id}`;
	const right = `${b.point.fingerprint}/${b.point.id}`;
	return left < right ? -1 : left > right ? 1 : 0;
}

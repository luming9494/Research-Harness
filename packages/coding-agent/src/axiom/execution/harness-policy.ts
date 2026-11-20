// 只描述可变的模型提示和上下文呈现。执行、审批、预算和评分不属于策略契约。
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { sha256 } from "./task-spec.ts";

const priority = Type.Integer({ minimum: 0, maximum: 100 });
const schema = Type.Object(
	{
		schema_version: Type.Literal(1),
		id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
		version: Type.Integer({ minimum: 1, maximum: 1000000 }),
		created_at: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" }),
		source: Type.Union([Type.Literal("builtin"), Type.Literal("operator")]),
		baseline_sha256: Type.Union([Type.Null(), Type.String({ pattern: "^[a-f0-9]{64}$" })]),
		settings: Type.Object(
			{
				prompt: Type.Union([Type.Literal("balanced"), Type.Literal("evidence_first")]),
				window_tokens: Type.Integer({ minimum: 900, maximum: 3200 }),
				priorities: Type.Object(
					{ recent: priority, operations: priority, experience: priority, artifacts: priority },
					{ additionalProperties: false },
				),
				feedback: Type.Union([Type.Literal("summary"), Type.Literal("structured")]),
				experience_limit: Type.Integer({ minimum: 0, maximum: 8 }),
				error_detail: Type.Union([Type.Literal("category"), Type.Literal("reason")]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type HarnessPolicy = Static<typeof schema>;
export interface PolicyBinding {
	config: HarnessPolicy;
	sha256: string;
	enhanced: boolean;
}

const baseline: HarnessPolicy = {
	schema_version: 1,
	id: "axiom-approved",
	version: 1,
	created_at: "2026-11-20T00:00:00Z",
	source: "builtin",
	baseline_sha256: null,
	settings: {
		prompt: "balanced",
		window_tokens: 1600,
		priorities: { recent: 40, artifacts: 30, experience: 20, operations: 10 },
		feedback: "structured",
		experience_limit: 8,
		error_detail: "reason",
	},
};

// 哈希不依赖 JSON 对象的序列化顺序。
function canonical(value: object): string {
	return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
		entry && typeof entry === "object" && !Array.isArray(entry)
			? Object.fromEntries(Object.entries(entry).sort(([a], [b]): number => (a < b ? -1 : a > b ? 1 : 0)))
			: entry,
	);
}

const baselineDigest = sha256(canonical(baseline));

/** 返回批准版本的副本供操作者审计与生成候选版本。 */
export function approvedPolicy(enhanced: boolean): PolicyBinding {
	return { config: structuredClone(baseline), sha256: baselineDigest, enhanced };
}

/** 校验完整包络，拒绝任何未声明字段或未继承批准基线的版本。 */
export function bindPolicy(value: unknown, enhanced: boolean): PolicyBinding {
	if (!Check(schema, value) || !Number.isFinite(Date.parse(value.created_at)))
		throw new Error("Invalid Harness Policy schema");
	const sha = sha256(canonical(value));
	if (
		value.source === "builtin"
			? sha !== baselineDigest
			: value.baseline_sha256 !== baselineDigest || value.id !== baseline.id || value.version <= baseline.version
	)
		throw new Error("Incompatible Harness Policy lineage");
	return { config: structuredClone(value), sha256: sha, enhanced };
}

/** 恢复校验失败时拒绝接管，避免用新策略替换原批准身份。 */
export function verifyPolicy(binding: PolicyBinding): PolicyBinding {
	if (typeof binding.enhanced !== "boolean") throw new Error("Invalid Harness Context mode");
	const result = bindPolicy(binding.config, binding.enhanced);
	if (result.sha256 !== binding.sha256) throw new Error("Harness Policy identity mismatch");
	return result;
}

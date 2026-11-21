// 提案协议只接受方向、参照、指标与证据序号。正式陈述由宿主从同一组字段生成。
import { Type } from "typebox";
import { Check } from "typebox/value";
import { conditions, type Domain, type Hypothesis } from "../plan.ts";

const proposal = Type.Object(
	{
		comparison: Type.String(),
		reference: Type.String(),
		metric: Type.Union([Type.Literal("accuracy"), Type.Literal("ndcg10")]),
		direction: Type.Union([Type.Literal("increase"), Type.Literal("decrease")]),
		ref: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export function researchHypothesis(
	text: string,
	domain: Domain,
	sources: readonly { id: string }[],
): { hypothesis: Hypothesis; evidenceId: string; reference: string } {
	const raw: unknown = JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ""));
	if (!Check(proposal, raw)) throw new Error("Invalid structured hypothesis");
	const control = conditions[domain].find(({ id }) => id === raw.comparison)?.reference;
	const source = sources[raw.ref - 1];
	if (!source || control !== raw.reference || raw.metric !== (domain === "tiny" ? "accuracy" : "ndcg10"))
		throw new Error("Hypothesis does not match approved comparison, metric, control or source");
	return {
		evidenceId: source.id,
		reference: raw.reference,
		hypothesis: {
			comparison: raw.comparison,
			metric: raw.metric,
			direction: raw.direction,
			statement: `Under the frozen ${domain} protocol, ${raw.comparison} will ${raw.direction} ${raw.metric} versus ${raw.reference}.`,
		},
	};
}

// 持平和缺少有效配对都保留为证据不足。
export function assessDirection(
	direction: Hypothesis["direction"],
	delta: number | null,
	complete: boolean,
): "supported" | "contradicted" | "uncertain" {
	if (!complete || delta === null || delta === 0) return "uncertain";
	return (direction === "increase") === delta > 0 ? "supported" : "contradicted";
}

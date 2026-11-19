// 顺序筛选策略。只用同协议代理分数作比较，少量或接近的样本继续全训。
export interface PromotionDecision {
	action: "promoted" | "pruned";
	reason: "direct_full" | "warmup" | "competitive_proxy" | "trailing_proxy" | "full_budget";
	proxy_score?: number;
	reference?: number;
	observations: number;
	rank?: number;
	margin?: number;
}

const margin = 0.05;

export function decidePromotion(
	proxy: number | undefined,
	previous: readonly number[],
	direction: "maximize" | "minimize",
	fullAvailable: boolean,
): PromotionDecision {
	if (proxy === undefined)
		return {
			action: fullAvailable ? "promoted" : "pruned",
			reason: fullAvailable ? "direct_full" : "full_budget",
			observations: 0,
		};
	const sign = direction === "maximize" ? 1 : -1;
	const scores = previous.map((value) => value * sign);
	const reference = scores.length === 0 ? undefined : Math.max(...scores);
	const reason = !fullAvailable
		? "full_budget"
		: scores.length < 2
			? "warmup"
			: reference !== undefined && reference - proxy * sign > margin + 1e-12
				? "trailing_proxy"
				: "competitive_proxy";
	return {
		action: reason === "full_budget" || reason === "trailing_proxy" ? "pruned" : "promoted",
		reason,
		proxy_score: proxy,
		reference: reference === undefined ? undefined : reference * sign,
		observations: scores.length,
		rank: 1 + scores.filter((score) => score > proxy * sign).length,
		margin,
	};
}

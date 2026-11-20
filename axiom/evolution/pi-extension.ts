// 提案 Session 禁用缓存预热，并限制 DeepSeek 请求输出长度。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function policyProposalExtension(pi: ExtensionAPI): void {
	pi.on("cache_warming_decision", () => ({ action: "stop" }));
	pi.on("before_provider_request", (event) => {
		// Provider payload 是原生扩展接口的输入边界。
		if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload))
			return { ...event.payload, max_tokens: 768 };
	});
}

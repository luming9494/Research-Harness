// 消融仅比较同一科研决策的一次真实请求，宿主阻止实验工具调用。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function contextProbe(pi: ExtensionAPI): void {
	pi.on("tool_call", () => ({ block: true, reason: "Read-only context ablation" }));
	pi.on("before_provider_request", (event, ctx) => {
		// 供应商请求是外部输入边界，统一四组生成上限。
		if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
			// 只将 UUID 返回本地 Runner，用有摘要的目录确认是否为已批准证据。
			const ids = [
				...new Set(
					JSON.stringify(event.payload).match(/[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}/g),
				),
			];
			ctx.ui.notify(`Context probe evidence ${JSON.stringify(ids)}`, "info");
			return { ...event.payload, max_tokens: 256, tool_choice: "none" };
		}
	});
}

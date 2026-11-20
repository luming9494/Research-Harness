// 将原生 Pi 事件压缩为结构化收据，避免存储消息、参数与自由文本错误。
import { sha256 } from "./io.ts";

export interface PiToolReceipt {
	timestamp: string;
	call_id: string;
	tool: string;
	phase: "start" | "end";
	status: "started" | "completed" | "failed";
	request_id: number | null;
	candidate_sha256?: string;
	reason?: "model_proposal" | "tool_contract" | "policy_denied" | "cancelled" | "tool_error";
}

export interface PiToolEvent {
	type: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	args?: { content?: unknown };
	result?: { content?: { type?: string; text?: string }[] };
}

// 识别 Pi 自己的固定错误前缀。未识别的工具错误只保留其发生事实。
export function toolReceipt(event: PiToolEvent, processNumber: number, requests: number): PiToolReceipt | undefined {
	if ((event.type !== "tool_execution_start" && event.type !== "tool_execution_end") || !event.toolCallId)
		return undefined;
	const tool =
		event.toolName && /^axiom_task_(inspect|baseline|candidate|finish)$/.test(event.toolName)
			? event.toolName
			: "unlisted_tool";
	const start = event.type === "tool_execution_start";
	const receipt: PiToolReceipt = {
		timestamp: new Date().toISOString(),
		call_id: sha256(`${processNumber}:${event.toolCallId}`),
		tool,
		phase: start ? "start" : "end",
		status: start ? "started" : event.isError ? "failed" : "completed",
		request_id: requests || null,
	};
	if (start && tool === "axiom_task_candidate" && typeof event.args?.content === "string")
		receipt.candidate_sha256 = sha256(event.args.content);
	if (!start && event.isError) {
		const message = event.result?.content?.[0]?.text ?? "";
		receipt.reason = message.startsWith('Invalid arguments for tool "')
			? "model_proposal"
			: message.startsWith('Validation failed for tool "')
				? "tool_contract"
				: /^(AXIOM task permits only reviewed ML tools|Permission denied:)/.test(message)
					? "policy_denied"
					: message === "Operation aborted"
						? "cancelled"
						: "tool_error";
	}
	return receipt;
}

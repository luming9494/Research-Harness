// 操作者策略文件只在创建任务时读取。回退结果单独标记。
import { readFile } from "node:fs/promises";
import {
	approvedPolicy,
	bindPolicy,
	type PolicyBinding,
} from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";

export async function openTaskPolicy(
	path: string | undefined,
	enhanced: boolean,
): Promise<{ policy: PolicyBinding; fallback: boolean }> {
	if (!path) return { policy: approvedPolicy(enhanced), fallback: false };
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return { policy: bindPolicy(value, enhanced), fallback: false };
	} catch {
		return { policy: approvedPolicy(enhanced), fallback: true };
	}
}

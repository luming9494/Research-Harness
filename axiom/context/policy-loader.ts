// 操作者策略文件只在创建任务时读取。回退结果单独标记。
import { readFile } from "node:fs/promises";
import {
	approvedPolicy,
	bindPolicy,
	type PolicyBinding,
} from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";
import { PolicyRegistry } from "../release/registry.ts";

export async function openTaskPolicy(
	path: string | undefined,
	enhanced: boolean,
	registryPath?: string,
): Promise<{ policy: PolicyBinding; fallback: boolean }> {
	// 生产注册表只供新建任务读取，独立 Bench 仍使用固定候选文件。
	if (registryPath) {
		try {
			const registry = new PolicyRegistry(registryPath);
			try {
				const selected = registry.active();
				return { policy: { ...selected.policy, enhanced }, fallback: selected.rolled_back };
			} finally {
				registry.close();
			}
		} catch {
			return { policy: approvedPolicy(enhanced), fallback: true };
		}
	}
	if (!path) return { policy: approvedPolicy(enhanced), fallback: false };
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return { policy: bindPolicy(value, enhanced), fallback: false };
	} catch {
		return { policy: approvedPolicy(enhanced), fallback: true };
	}
}

// 显式选择需要 WSL2 Docker 的验收。常规离线回归使用独立确定性测试。
import { defineConfig, mergeConfig } from "vitest/config";
import codingAgent from "../../packages/coding-agent/vitest.config.ts";

export default mergeConfig(
	codingAgent,
	defineConfig({ test: { include: ["test/suite/axiom-docker-live.acceptance.ts"] } }),
);

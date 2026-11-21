# AXIOM 简历事实与验收映射

目标稿见 [AXIOM_RESUME](AXIOM_RESUME.md)。本页按已运行的证据描述六项能力。

| 技术亮点 | 已核验事实与边界 | 实现及证据 |
| --- | --- | --- |
| 自进化 Harness | 真实模型验证失败归因、白名单提案、反馈修订、独立开发与留出对照。晋升与回滚机制通过隔离验证，候选收益以当次门槛为准。 | [提案入口](../axiom/evolution/cli.ts)、[发布机制](AXIOM_POLICY_RELEASE.md)、[最终对照](AXIOM_FINAL_ENGINEERING.md) |
| 持久化执行 | 本地 CPU 和 Docker 实验通过跨进程恢复、预算续算和防重。Slurm 对账通过离线回归，真实集群待验收。 | [Durable 账本](../axiom/durable/experiment-ledger.ts)、[统一后端](AXIOM_UNIFIED_EXECUTION.md) |
| 自主科研优化 | 真实运行 Tiny 多保真与 Pareto、SciFact 混合检索、多种子消融及固定条件训练复现。 | [多保真](AXIOM_MULTI_FIDELITY.md)、[Pareto](AXIOM_PARETO.md)、[SciFact](AXIOM_HYBRID_RAG.md)、[科研验证](AXIOM_RESEARCH_VALIDATION.md) |
| 上下文工程 | 四层上下文、压缩、恢复及正常 Pi 的 Qdrant 引用已验收。普遍节省 Token 的收益待证实。 | [Builder](../axiom/context/builder.ts)、[上下文工程](AXIOM_CONTEXT_ENGINEERING.md)、[科研工作区](AXIOM_RESEARCH_WORKSPACE.md) |
| 安全执行与工具治理 | TaskSpec、人工审批、禁网 Docker、独立评价及策略版本绑定已验收，适用于批准入口和固定沙箱配置。 | [TaskController](../packages/coding-agent/src/axiom/execution/task-controller.ts)、[沙箱](AXIOM_SANDBOX_OBSERVABILITY.md)、[治理](AXIOM_POLICY_GOVERNANCE.md) |
| Agent Evals 与可观测性 | 真实 Pi 双轴对照、归因及三端同一 Run 的证据关联已验收。 | [评测对照](AXIOM_BENCH_COMPARISON.md)、[归因](AXIOM_FAILURE_ATTRIBUTION.md)、[科研平台](AXIOM_RESEARCH_PLATFORM.md) |

正式 Dropout/MNIST 复现保留为独立验收。QC-DETR 导入维持未复验等级。

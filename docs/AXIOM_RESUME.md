### AXIOM — 面向自主科研的自进化 Agent Harness

- **项目概述**：基于 Pi Agent 二次开发的领域级 Agent Harness，面向模型优化、论文复现、消融实验及 RAG 系统优化，构建集自主实验、持久化执行、上下文工程、独立评测与 Harness 自进化于一体的科研 Agent 系统。
- **技术栈**：TypeScript + Node.js + Python + Pi Agent SDK + Pi Durable + SQLite + Docker + Slurm + Qdrant + PyTorch + OpenTelemetry + MLflow
- **项目细节与亮点**：
  - **自进化 Harness**：借鉴 Meta-Harness 与 Self-Harness，设计实验优化与 Harness 优化的双闭环架构，基于历史执行轨迹进行失败归因、策略生成与反思优化，通过独立回归评测、版本化管理与回滚机制实现受控自进化。
  - **持久化执行引擎**：基于 Pi Durable 构建长程任务运行机制，结合 SQLite 事务账本、Checkpoint、实验指纹与外部作业对账，实现任务中断恢复、执行防重、预算续算及远程 GPU 作业状态恢复。
  - **自主科研优化**：借鉴 AutoResearch 构建假设生成、候选搜索、实验执行、反馈决策闭环，引入多保真评估、候选剪枝与 Pareto 多目标优化，实现预算约束下的模型结构、超参数及 RAG 检索策略自主探索。
  - **上下文工程**：设计工作上下文、结构化状态、情景记忆与产物存储四层上下文架构，结合历史实验检索、工具输出压缩与任务状态重建，减少冗余上下文开销，提升长程任务连续性。
  - **安全执行与工具治理**：基于 TaskSpec 实现策略驱动的工具权限控制，结合 Docker 沙箱、资源配额、人工审批与独立评估器隔离，约束 Agent 自主代码执行及策略修改行为。
  - **Agent Evals 与可观测性**：构建 AXIOM-Bench 领域评测集，覆盖任务成功率、多轮执行可靠性、故障恢复、Token 成本及安全性；结合 OpenTelemetry 运行轨迹与 Run Manifest 实现实验失败归因、产物追溯及独立复验。

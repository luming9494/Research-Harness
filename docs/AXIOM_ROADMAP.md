# Research Harness / AXIOM · CLI-first 路线

> 以已固定的 Pi 1.5.0 源码为主体；不主动同步上游。新架构优先复用已有 Pi 机制，不重复造 TUI、Session 和基础 Agent Loop。

AXIOM 是面向自主科研的自进化 Agent Harness。机器学习是首个场景，当前实现以可信 Tiny CPU Optimize 为主。目标是让同一实验控制层管理模型优化、消融、论文复现、RAG 策略优化和 Harness 自身的改进。完整目标见 [简历项目稿](AXIOM_RESUME.md)，实际能力以 [验收记录](AXIOM_VALIDATION.md) 为准。

阶段交付、依赖和验收条件见 [完整开发计划](AXIOM_DEVELOPMENT_PLAN.md)。

## 当前里程碑

| 阶段 | 现状 | 接下来的判定标准 |
| --- | --- | --- |
| 新底座 | 本地完整构建、静态检查、离线 CLI RPC 启动通过 | 交互 TUI 人工验收仍待执行 |
| WP-01 | 独立 `.venv` 下真实 CPU 训练、Checkpoint 重载和评估回归通过 | 保持可复验回归 |
| WP-02 | 原生 Session/faux 工具注册、权限、Smoke、取消和工具恢复通过 | 保持原生工具回归 |
| WP-03 | 人工候选的真实训练、独立验证、keep 与失败 revert 通过 | 不将人工候选验收称作模型自主优化 |
| WP-04 | 可信 Tiny CPU 多轮内核已迁入，两阶段真实 LLM 主流程经原生 RPC 验收通过 | 补齐终端 TUI 人工验收，保留较差、平分和失败候选的离线回归 |
| WP-05.2 | Tiny CPU 实验账本与原生恢复入口已接入，真实 CPU 跨进程恢复已验收，独立静态代码审阅已通过。[恢复验证](AXIOM_WP05_RUNTIME.md) | 后续将现有恢复与防重用例纳入 AXIOM-Bench |
| WP-05.3 | Windows Tiny CPU 持久化执行结项，独立静态审阅已通过。[故障用例](AXIOM_WP05_RUNTIME.md#故障用例记录) | Linux 真实运行另行验收 |
| WP-06.1 | 通用实验内核接入 Tiny CPU、审批限制下的学习率搜索和第二个测试适配器，独立静态审阅已通过。[实验内核](AXIOM_EXPERIMENT_ENGINE.md) | 保留 v1/v2 兼容回归 |
| WP-06.2 | v3 分级评估、保守剪枝、分段记账与恢复，独立静态审阅已通过。[多保真评估](AXIOM_MULTI_FIDELITY.md) | 保留分级与恢复回归 |
| WP-06.3 | v4 独立多目标评分、Pareto 前沿、按偏好交付和证据引用，独立静态审阅已通过。[Pareto 优化](AXIOM_PARETO.md) | 保留持久化回归 |
| WP-07.1 | AXIOM-Bench 统一 CLI、独立双轴判题和证据复核。[基础评测框架](AXIOM_BENCH.md) | 阶段性通过独立静态审阅 |
| WP-07.2 | 同一 Runner 支持 B0/B1/B2 真实模型对照、分组统计和新增 CPU 机制判题。[真实对照](AXIOM_BENCH_COMPARISON.md) | 已通过独立静态审阅 |
| WP-07.3 | Bench 为每次运行派生可复核 Trace 和失败归因，保留复跑 Case 与历史评分。[失败归因](AXIOM_FAILURE_ATTRIBUTION.md) | 已通过独立静态源码审阅 |
| WP-08.1 | 可选的四层上下文、Durable 重建、证据筛选与受控工件窗口，已完成 Pi 跨进程对照。[上下文与真实对照](AXIOM_CONTEXT_ENGINEERING.md) | 等待独立审阅 |
| 后续 | 规划中 | 第二类 AI 任务、跨任务评测、Ablate、Reproduce 和远程 GPU Runner |

## 两个优化循环

- **内环改实验**。在固定 TaskSpec 和评估协议下提出假设、生成候选、分阶段执行、比较收益与成本，最后交付历史最佳或一组 Pareto 候选。训练架构、超参数和 RAG 检索配置是不同任务的搜索空间。[autoresearch](https://github.com/karpathy/autoresearch)
- **外环改运行策略**。基于已归档轨迹提出配置变更，用固定基线做对照，经过独立评测后才可提升为可用版本。第一版只开放 Prompt、白名单 Skill、工具输出和上下文策略配置。评分器、留出任务、权限与预算由运行方固定。现有任务绑定策略版本，新版本适用于新任务，回滚切回上一已验收版本。[Meta-Harness](https://arxiv.org/abs/2603.28052) · [Self-Harness](https://arxiv.org/abs/2606.09498) · [HarnessEvolve](https://arxiv.org/abs/2609.00829) · [Harnesses That Improve Themselves](https://arxiv.org/abs/2611.22299) · [Airbnb Agent Harness Optimizer](https://github.com/airbnb/agent-harness-optimizer)

## 开发顺序

| 优先级 | 模块 | 首个可验收结果 |
| --- | --- | --- |
| P0 · 1 | **Durable Execution / WP-05** | 固定 Tiny CPU 任务完成首轮后退出进程，新进程恢复同一任务与剩余预算，仅执行剩余候选，并独立核验最佳交付。 |
| P0 · 2 | **Autonomous Research** | 在同一候选空间和预算下比较现有全训流程与多保真策略，记录候选剪枝、低成本代理误判及完整评估。先固定质量和成本两类目标，再验证 Pareto 候选选择。 |
| P0 · 贯穿前两项 | **AXIOM-Bench** | 先把候选重复、进程崩溃、用量不明、超时、预算耗尽与产物篡改做成可判分案例。以规则、命令和产物为判题证据，分别记录任务是否完成、运行机制是否正确。 |
| P1 · 1 | **上下文、策略治理、证据链** | 以工作上下文、结构化任务状态、历史经验、原始产物四层重建上下文，复用 Pi 的通用压缩。用 TaskSpec 限制工具与资源，隔离评分器；用同一 run ID 将决策、执行、指标和产物串入 Run Manifest。 |
| P1 · 2 | **Self-Evolving Harness** | 围绕一个可重复失败完成「诊断 → 配置提案 → 对照与留出评测 → 发布或拒绝 → 回滚」。例如减少训练日志带来的 Token 消耗，同时保持失败信息可见和任务成功率达标。 |
| P2 | **RAG、消融与复现、Slurm** | 用 RAG 固定语料和留出查询验证同一搜索循环。用控制变量矩阵验证消融，用 Run / Evaluate / Train 区分复现层级。Slurm 最终验收为杀掉本地进程后继续监控原 GPU 作业，并核对作业 ID、提交次数与产物。 |
| P3 | **可视化** | 从已稳定的账本和证据契约展示任务进度与实验对照。 |

AXIOM-Bench 先用 faux provider 和真实 CPU 执行做确定性回归，再用隔离案例进行真实模型对照。归因至少区分模型、工具、上下文、预算、执行环境、评估器与未知。每条归因引用实际事件或产物。报告保留任务成功、恢复成功、重复启动、预算、越权拦截和独立复验的分子分母。多次运行时固定任务、模型、预算和环境，分别报告 `pass@k`（至少一次成功）与 `pass^k`（每次均成功）。候选生成只看开发轨迹，留出结果用于独立验收，避免多轮调参泄漏答案。[Trial by Trace](https://arxiv.org/abs/2610.32285) · [Agent Evals](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) · [MLE-bench](https://github.com/openai/mle-bench) · [PaperBench](https://openai.com/index/paperbench/)

## WP-05 设计与已验收范围

**Pi 提供会话、工具调度与持久化原语，AXIOM 负责科研任务的业务事实。** WP-05.2 使用 Pi Durable 的 SQLite 文档事务保存权威账本，并沿用本地单写者保护。恢复由原生 Pi 扩展显式触发，外部训练与模型请求不注册为 Durable 自动重放任务。WP-04 JSON 报告继续用于展示与审计。[Pi Durable](../packages/durable/README.md) · [WP-05.2 实现与验证](AXIOM_WP05_RUNTIME.md)

1. **持久化执行边界**。为同一任务保留稳定任务 ID、原 TaskSpec、原截止时间、可信输入身份和候选指纹。启动前先提交执行意图及预算预留。执行结束后持久化独立评估凭证、产物指纹和已结算用量。远程作业 ID 接入留给 Slurm 阶段。
2. **对账后才恢复**。通过任务 ID 重新打开，由单一实例核验原规则、有效产物和剩余预算。经验证的已完成实验直接复用。若在“已记录意图、尚无完成证据”的窗口崩溃，保留预留并暂停相关操作。查询或核验类步骤可重放，外部启动和模型请求只有在副作用可确认时才有资格续跑。已有合法历史最佳仍可独立交付。
3. **以真实重启和故障注入验收**。基线加首轮完成后杀掉进程，再重新启动并执行剩余候选。核对任务 ID、候选计数、截止时间、Token 结算、产物哈希与实际启动记录。同时覆盖启动边界崩溃、工具超时、重复接管、预算到期及证据损坏。首个切片使用现有可信 Tiny CPU，保留构建、`npm run check` 与 `npm run test:ml` 回归。

阶段演示先做本地进程重启，再做 Slurm 断连和重接。DETR 量化可作为后续多目标场景，以 mAP、显存、延迟和 GPU 时间作为独立度量。RAG 的混合检索与重排作为候选策略，共用实验预算、去重、选优和取证机制。

## 新代码原则

新增模块前回答：

- Pi 当前源码是否已有对应能力？
- 是否能通过原生 Extension、Skill 或少量修改解决？
- 剩余问题由多个 AI 任务共享，还是只属于一个领域？当前实现能否为共用机制提供具体验证？

不为了“二开深度”而修改 Pi 底层 Agent Loop；只有明确的功能缺口和可复验的技术理由才动底层。

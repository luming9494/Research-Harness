# AXIOM WP-15 最终工程整合

## Architecture

Pi 提供会话、供应商、工具事件与通用上下文。AXIOM 的 TaskController、Pi Durable 和 SQLite 管理审批、执行意图、预算、对账及交付。Research Workspace 保存项目关系和有摘要的证据。Qdrant、MLflow 和 OTLP 接收可重建投影。

- **科研内环**经过原文定位、结构化提案、宿主审批、冻结矩阵、可信 Worker、独立评测、配对统计和反馈。宿主从获准条件生成可证伪陈述。提案字段绑定 comparison、reference、metric、direction 与证据序号，额外说明与错误引用被拒绝，未知或持平的结果保留为证据不足。
- **策略外环**根据实际 Bench 失败归因生成策略提案，范围为六个呈现字段。冻结后独立运行开发与留出，双轴评分和发布门槛复用 v1。发布和监测回滚由 SQLite 的活动指针事务控制。

## Quick Start

使用 [README](../README.md) 安装 Node、仓库依赖和 CPU PyTorch，并配置独立 Pi 登录。Docker 使用 [统一执行指南](AXIOM_UNIFIED_EXECUTION.md) 的固定镜像摘要及 TaskSpec。三项本机服务的启动命令见 [科研平台](AXIOM_RESEARCH_PLATFORM.md)。

## Demo Guide

从仓库根目录运行下列入口，并保留输出的 ID 与 SHA-256。

1. `npm run workspace:axiom -- create --name NAME --question QUESTION` 创建项目。准备本地论文和定位元数据，执行 `workspace:axiom paper` 得到 Claim ID。
2. `workspace:axiom propose --project ID --domain tiny --claim CLAIM_ID --out CANDIDATE` 运行一次真实规划。用 `workspace:axiom approve --project ID --plan CANDIDATE --sha CANDIDATE_SHA` 批准并获得 Plan SHA。
3. `workspace:axiom run --project ID --plan CANDIDATE --sha PLAN_SHA --interrupt` 在首单元提交边界断开。另起进程去掉 `--interrupt` 继续。用 `workspace:axiom report --project ID --plan CANDIDATE --sha PLAN_SHA --audit --out REPORT` 输出独立复评、配对统计与复现等级。
4. 三项本机服务启动后，对同一 Tiny 计划执行 `platform:axiom sync`，再用 `workspace:axiom projection` 核对 Project、Plan、Task、Operation、Run、MLflow、Trace、Qdrant 和 Finding。
5. 用 `npm run bench:axiom -- --verify BENCH_CASE_DIR` 复核 Bench 结果。使用下面的跨领域入口核对历史实验和工件。
6. 根据 [策略发布指南](AXIOM_POLICY_RELEASE.md) 冻结候选并执行 development、holdout 和 gate。默认预演展示发布资格。指定隔离注册表演示回滚可复用现有确定性测试和真实负例，保留各自证据类别。

WP-15 在 WP-14 冻结 Tiny 计划上重新独立评测六个 checkpoint，三个同条件种子重复精确一致。报告分别记录计算、独立评分和可复现等级。人工确认使用 `workspace:axiom confirm-finding --project ID --source FINDING_ID --sha FINDING_SHA` 追加事件，输入摘要取对应 Finding 节点 JSON 的 SHA-256。

本轮真实规划先拒绝了字段误名 `numeric_ref`，保留其原响应及费用。修订提示后获得合法的 `rate-low` 对 `rate-base` 准确率下降假设，并引用原 Finding。审批后在 `wp04-fKhRKQ` 首单元提交后强杀，用同一计划与 Task ID 完成 6/6 单元，首单元仍为操作 1–3。报告见 `private/wp15/pilot-recovered`。三端服务测试中，停服时工作区仍可读，复机后保留原 6 个 MLflow Run、7 个 Qdrant 点和关联 Trace。

## Cross-domain Benchmark

```text
npm run suite:axiom -- --tiny TINY --tiny-sha TINY_SHA --tiny-bench CASE --rag RAG --rag-sha RAG_SHA --rag-holdout HOLDOUT_CASE --rag-holdout-sha HOLDOUT_SHA --data DATA --vectors VECTORS --vector-sha VECTOR_SHA --project ID --paper-project PAPER_ID --docker TASK_ID --out OUTPUT
```

Tiny 使用多种子计划和当前版可复核的 T3 恢复归档。SciFact 从固定缓存重建 BM25、Dense 和 RRF 排名并独立复评。Workspace 核对原生实验身份和论文证据边。Docker 复核实际历史容器、恢复与工件结果。Slurm 执行离线对账、防重、取消及配额用例。各领域任务与 Harness 分别登记。

本机复核中，Tiny、SciFact、Workspace、Docker 双轴通过。Slurm 机制通过七项离线用例，真实 GPU 任务保留未知。首次读取旧 Tiny 归档因基准资产身份不匹配而保留未知，随后使用本次正式开发对照的有效归档复核通过。

真实 Docker 任务 `wp04-1gqSOX` 在容器运行期间强杀，恢复原容器 `24705b78ecccbd247061e792dad76bcd23544eadcbf0df50c00cf453b9ae60f8`。账本只有一个外部提交，512 个验证样本的 accuracy 为 0.990234375，容器随后清理。SciFact 已重新复核冻结开发与留出排名。

## Self-Evolving Harness

源失败从已核验的 Tiny AST 轨迹抽取。候选 A 将窗口从 1,600 改为 1,200。候选 B 读开发反馈后将窗口改为 960，并调整 recent、operations、experience、artifacts 优先级。两者均保留具体错误和结构化反馈。正式计划 SHA-256 为 `c643e0cec5981f678ba8755d6e25934e9e29ed4e204518ce8b6a79ca57fb9162`。候选完整配置、父摘要和结构化提案随档案留存。新增代码会在后续调用前记意图并保存响应原文。

| 阶段 / 策略 | Task / Harness | 输入 / 总 Token 均值 | 估算 USD 合计 | Worker / 墙钟秒均值 |
| --- | --- | ---: | ---: | ---: |
| 开发 / 基线 | 2/3 · 3/3 | 23,111 / 24,205 | 0.021388 | 50.25 / 79.51 |
| 开发 / A | 3/3 · 3/3 | 17,673 / 18,739 | 0.017148 | 46.07 / 70.55 |
| 开发 / B | 3/3 · 3/3 | 20,477 / 21,632 | 0.019238 | 59.81 / 82.69 |
| 留出 / 基线 | 2/3 · 3/3 | 18,085 / 19,037 | 0.017032 | 44.63 / 70.37 |
| 留出 / A | 3/3 · 3/3 | 20,324 / 21,383 | 0.019017 | 60.28 / 82.44 |
| 留出 / B | 3/3 · 3/3 | 21,165 / 22,168 | 0.019197 | 41.26 / 64.27 |

开发与留出各完成 9/9，按三组轮换。18 次均恢复、保留错误可见性并完成修订，重复启动为 0。各组三次都有成功，因此经验 `pass@3` 均为 1；两阶段基线的 `pass^3` 均为 0，A/B 均为 1。小样本只作描述。

发布门槛 v1 对 A、B 均给出 `inconclusive`。两阶段的基线各有一个任务未通过，比较资格不足。A/B 留出输入的样本均值也高于基线。隔离 `publish --apply` 实测拒绝且注册表未创建。活动策略保持原批准版本。版本绑定、事务回滚和监测分支继续由隔离回归验证。

## Context Ablation

`npm run context:axiom -- --catalog PLATFORM_DIR --sha CATALOG_SHA --candidate POLICY_JSON --out OUTPUT` 在正常 Pi 任务上比较原生呈现、四层、四层加 Qdrant 和候选呈现加 Qdrant。各组同模型、单次真实请求、只读，使用实际发送载荷中的可信 Evidence ID 独立核对模型引用。

| 组 | 输入 / 总 Token | Pi 估算 USD | 引用判分 |
| --- | ---: | ---: | --- |
| 原生 | 516 / 551 | 0.000084492 | 未成功 |
| 四层 | 1,121 / 1,229 | 0.000353004 | 未成功 |
| 四层 + Qdrant | 1,739 / 1,774 | 0.000450804 | 通过 |
| 候选 B + Qdrant | 1,739 / 1,772 | 0.000448404 | 通过 |

各组 Harness 均通过。两组 Qdrant 实际发送各三个 Evidence ID，模型各正确引用一个。向量经验组较四层组增加 618 输入 Token。候选获准用于只读对照，注册表晋升取决于独立门槛。首次试跑期间 Qdrant 退出，四组均缺少正确引用，费用和失败保留。

## Limitations

真实远程 Slurm GPU 为 `pending_external_validation`。正式 Dropout/MNIST 属于独立挑战。少量固定 Bench 重复、缓存复评和单问题消融仅支持对应条件下的描述性结论。

正式策略对照使用 122 次请求、362,504 输入 Token、381,490 总 Token，Pi 估算 USD 0.113019456。包含提案与探索、两轮上下文及两次科研规划，本阶段合计 **152 次请求、430,137 输入 Token、453,499 总 Token、估计 USD 0.134685048**。上述归档用量均有记录，供应商账单未知。

原始证据位于本地 `private/wp15`，包括 `gate.log`、`release`、`evolution`、`context-final`、`suite-verified`、`pilot-recovered` 和 `service-replay.log`。建议独立审阅后将本次提交作为正式挑战的冻结基线，沿用已批准策略。

Windows `npm run check` 和新增定向测试 4/4 通过。WSL2 `npm run build:offline` 及 `AXIOM_ML_TEST_CONCURRENCY=1 npm run test:ml` 通过，全量 170/170。SciFact 正式归档复核 37 个文件、9 组分数和 5,245 条排名查询。

[六项简历亮点的实际证据](AXIOM_RESUME_EVIDENCE.md)

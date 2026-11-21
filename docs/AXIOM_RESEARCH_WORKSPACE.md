# AXIOM WP-14 科研工作区与论文证据图

`workspace:axiom` 将操作者批准的资料、冻结矩阵、独立评价和科研结论关联到项目。SQLite 保存工作区元数据、状态修订和确定性关系。原矩阵账本和 Pi Durable 保存执行事实、资源和审批身份。工作区 CLI 复用原 Python 训练、评分器、受控领域和执行入口。

## 操作与证据

| 命令 | 输入与作用 |
| --- | --- |
| `create --name NAME --question QUESTION` | 创建项目并返回 UUID |
| `show --project ID` | 查询状态、证据节点、关系、来源和核验级别 |
| `status --project ID --status active\|paused\|closed` | 追加状态修订 |
| `paper --project ID --source FILE --sha SHA --metadata JSON` | 固定原文摘要、定位和操作者释义 |
| `import --project ID --source IMPORT_JSON --sha SHA --claim CLAIM_ID` | 读取 WP-11.2 格式的历史导入回执 |
| `propose --project ID --domain tiny\|scifact --out CANDIDATE --parent PLAN_NODE` | 使用一次原生 Pi 调用生成待审候选。也可用 `--claim` 指定论文依据 |
| `approve --project ID --plan CANDIDATE --sha CANDIDATE_SHA` | 绑定项目、候选摘要、依据与父版本，返回冻结计划摘要 |
| `run --project ID --plan CANDIDATE --sha PLAN_SHA` | 沿用冻结计划与原矩阵执行。可加 `--interrupt` 验证首单元提交后强杀 |
| `report --project ID --plan PLAN --sha PLAN_SHA --out REPORT` | 核对原矩阵/账本，产生 JSON 和 Markdown。可加 `--audit` 实际复验 |
| `projection --project ID --source PLATFORM_OUT --sha SYNC_SHA` | 核对原生运行、Qdrant、MLflow 和已接受的 OTLP 投影回执 |
| `execution --project ID --source TASK_ID --parent PLAN_NODE` | 关联具有已确认交付的现有后端任务，并核验原命令收据和工件 |

在仓库根目录执行 `npm run workspace:axiom -- <命令>`。SciFact 运行及复验沿用 `--data`、`--vectors`、`--vector-sha`。报告输出目录使用新的归档位置。

论文元数据输入包含 `title`、`authors`、可选 `identifier`，以及由 `statement`、`excerpt`、`location` 组成的 `claims`。PDF 使用本机 Poppler 的 `pdftotext` 及 1 基页号。Markdown、TXT、结构化文本使用 1 基行号。导入设置输入大小、子进程时间和输出限制。扫描件需要有文字层。原文定位核验与释义可信度分别记录，关系中的操作者关联标为 `reported`。

科研问题、计划、假设、数据、实现、协议、运行、指标及工件具有按内容或原生身份推导的 ID。指标与原生独立评分逐项对账，候选权重或检索回执摘要与度量相连。失败、未知单元留在矩阵报告。训练 loss 保留逐 epoch 记录，验证值来自独立终点评分。成对差值按相同种子和对照计算，Pareto 仍复用原实现。假设方向用结构化字段生成正式表述，模型原说明单独保留。

## 正常 Pi 会话的研究经验

Enhanced Context 在每次新建或恢复会话时，用 TaskSpec 目标、阶段与失败状态生成有限长度的本地检索查询。Qdrant 和已固定摘要的本地目录分别校验任务、数据、协议、切分和复验状态。Context Builder 按原预算裁剪，只放入经过匹配的事实、Evidence ID 和适用边界。历史 AST 经验在对应失败时仍可用。Qdrant 不可用时可沿用 `AXIOM_CONTEXT_EXPERIENCE`。

使用 WP-13 的 `platform:axiom sync` 重建带范围标签的集合。旧目录可供原对照命令读取，重新投影后可供正常会话按数据身份检索。原 TaskSpec、审批、预算计算及 Durable 约束继续由各自权威入口执行。

## 真实验收记录

### WP-11.2 Tiny 多种子项目

项目 `7b6166a0-0a17-48db-ae66-de1931269d86` 使用原三种子九组独立评价和九份训练曲线。总体原执行计算耗时 229.679 秒。

| 学习率 | 平均 accuracy | 平均 loss | 对照配对 accuracy 差值 |
| ---: | ---: | ---: | ---: |
| 0.03 | 0.895833 | 0.193784 | 基线 |
| 0.01 | 0.770833 | 0.524889 | -0.125000 |
| 0.08 | 0.867188 | 0.139091 | -0.028646 |

低学习率提升准确率的假设被当前矩阵反向结果否定。高学习率降低准确率的方向获支持。基线和高学习率在准确率、loss、计算时间构成的 Pareto 前沿。结果仅描述这组固定条件与三个种子。

### QC-DETR 导入

使用本地工作稿 `paper_writing/PAPER_DRAFT.md` 的真实行定位及 WP-11.2 E2 导入回执建立 Paper → Claim 和 Claim ↔ Run → Protocol 关系。E2 的 AP 0.3033、AP50 0.4635、AP75 0.3238 均标记为自报。缺失 checkpoint、历史日志、数据身份、运行 revision 和 seed，证据级别为 `imported_unverified`。

### 真实 Pi 与外部服务

正常增强上下文任务 `wp04-4jqvRk` 中，`deepseek/deepseek-flash` 自行引用 `18bd5f80-79d1-5096-88b5-a9e9702f1a71`，选择对应学习率 0.08。UUID 未写入用户问题。该次请求用量 2,542 Token，估计 USD 0.000717936。科研规划首个回复未通过结构校验（1,324 Token，USD 0.000460368），第二个回复选择受控 `rate-high` 并引用已有 Finding（1,223 Token，USD 0.000346536）。总计 3 次真实请求、5,089 Token、Pi 估计 USD 0.001524840，实际供应商账单未知。规划第二次回执的说明文字与结构化方向存在冲突，旧冻结计划保留原证据，后续候选的正式假设由宿主生成。

九个原生 Run 与 Qdrant、MLflow、OTLP 回执完成身份核对。Qdrant 实际停机时，外部映射步骤失败，独立进程仍能查询项目。启动后再次核对九条，关系可幂等重建。外部系统观测来自本机受控服务，真实 Slurm 集群待外部授权验证。Docker 观测可经 WP-13 投影读取实际命令回执。

项目关联了 WP-12 的真实 Docker 任务 `wp04-PPfFub`、Trace `3575524e73f5c9686d6b40c6b41e1724` 及 checkpoint 摘要 `656f54e103dc1d88df0f5e9cef2c34aeb50f208cf17d759f52339acf92c3654f`。项目中的操作者归属标为 `reported`，Docker 交付证据单独核验。此次 Tiny 矩阵在本地 CPU 执行，远程作业仍通过既有任务入口提交。

### 冻结、强杀与恢复

审批后原计划摘要为 `3f58b8363622f3af9fe740b68b58d41ec7887fd8c69e043d2c92cf79a5db0930`。原生任务 `wp04-bg98qc` 的 `rate-base-r1` 完成、操作 1–3 提交后强杀。新进程从同一冻结计划、Task ID 和操作收据继续，完成 6/6 单元，首单元仍只对应操作 1–3。另一次固定种子重复使用 `wp04-U66TlT`。平均验证准确率在 0.03 和 0.08 两组均为 0.990234375，结构化的“准确率提升”方向证据不足。两组 loss 分别为 0.067995 和 0.026793。累计原生计算 165.351 秒。

`report --audit` 独立复评全部六个 checkpoint。三个同种子重复的 accuracy、loss 和样本数与首轮精确一致，均达到训练复现等级。

私有验收材料位于 `private/wp14`，包含 `tiny-report`、`detr-graph.json`、`native.json`、`planner*`、`interrupt.log`、`resume.log` 和停机前后证据。

最终范围索引有 11 个点，含九条已验证训练经验和两条从固定矩阵计算的配对结论。使用本地 Poppler 对合成 PDF 验证了页号、原文和文件摘要。Windows 定向 Context/Workspace/Platform 用例及 `npm run check` 通过。WSL2 离线构建及单并发全量回归 166/166 通过，构建和测试日志分别为 `build-wsl.log` 和 `test-wsl.log`。正式模型请求与确定性测试分别记账。

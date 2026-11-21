# WP-11.2 · 多种子科研验证与实验接入

## 安全对账

`reconcile` 持有矩阵锁，以原 TaskSpec 和绑定的 Durable 账本恢复任务身份。可核验的完整评分与命令收据产生 `completed`。已知执行失败保留 `failed` 及已结算计算开销。只提交了启动意图，且没有其他证据表明已授权时，可以标为 `not_started`。原生启动记录缺少最终结果时保留 `unknown`，后续 `run` 跳过该单元。账本关联冲突或已提交工件缺失时拒绝对账。启动握手前强杀、提交启动记录后强杀、重复对账、收据丢失及操作 ID 冲突见 `RES-112-04`。

恢复继续使用原生预算、截止时间和操作记录。无法安全保留原单元身份的中断候选保守停留在待核对状态。

## Tiny CPU 多种子结果

Windows 正式计划 `0da3458070c4475d13fdebbc1aa532ade564b340f6ee946b93c81f30a542f272`。Seed 42、43、44 分别关联原生任务 `wp04-bRl7sv`、`wp04-F2ZBwe`、`wp04-jIBPNV`。三组各完成 3/3，共 9 次真实训练，失败与未知均为 0。全量训练固定 shallow-tanh、Adam、80 epochs、全批量 1024 训练样本、512 个验证样本和验证协议。数据由固定划分种子生成，每步按同一顺序使用全批量。实验种子改变模型初始化。

| 学习率 | Accuracy 均值 ± 样本 SD | Accuracy 范围 | Loss 均值 ± 样本 SD | Loss 范围 | 平均计算秒 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.03 | 0.895833 ± 0.165202 | 0.705078–0.992188 | 0.193784 ± 0.221115 | 0.064261–0.449097 | 23.774 |
| 0.01 | 0.770833 ± 0.078935 | 0.679688–0.816406 | 0.524889 ± 0.117825 | 0.455598–0.660934 | 27.357 |
| 0.08 | 0.867188 ± 0.214817 | 0.619141–0.992188 | 0.139091 ± 0.188342 | 0.026793–0.356530 | 25.429 |

按 Seed 42、43、44 与 0.03 配对，0.01 的 Accuracy 差为 −0.173828、−0.025391、−0.175781。0.08 的差为 0、−0.085938、0，Loss 差为 −0.041202、−0.092567、−0.030312。Python `statistics` 从九份评分独立重算均值、样本标准差、范围和配对差，与报告一致。0.01 提升准确率的假设未获支持。0.08 的准确率下降集中于 Seed 43，结论限于这三个种子。三组累计实际子进程结算 229.679 秒，含启动和独立评价。Pareto 以最大准确率、最小 loss 和最小计算开销为目标，0.03 与 0.08 位于前沿。

九个 checkpoint 均通过独立评价复算，工件与原生收据见 `private/wp112/tiny-audit/audit.json`。复验清单 SHA-256 为 `633e1fd6e33f559741c24d14597f79ae61270c0d47bcc8b1495ab820d87489b3`。本矩阵以不同种子进行新训练。每个种子只有一轮，`training_reproduced` 仍需独立同种子重训。

## SciFact 反馈修订

冻结父计划 SHA-256 为 `e40bb1f8f8790417a291c2ffd040bbdc631cd80fa7e85bb3dd0b7b07c006f0c7`。从已核验的开发集证据向原生 Pi 提供两项方向预测失败的聚合差值。首次模型回答把 Top‑15 和固定 Top‑30 同时当作比较基线，予以拒绝。规范限制为一个显式 RRF 对照和一个结构化方向。第二次模型提出 Sparse Top‑20，对照 Sparse Top‑30，固定 Dense Top‑30 和 `rrf_k=60`，预测开发集 nDCG@10 上升。

候选 SHA-256 `786efa350dcfe8da42945ba7b11275784e2241804dc098d6339f4722f5acf74d`，由 `source.json` 和模型回执绑定原 Run ID、工件摘要与父计划身份。正式候选保持待审批。启动需要显式 `approve` 并提交新计划摘要。留出数据、原始评分器及执行工具保持隔离。两次请求均使用 DeepSeek Flash，合计 1,490 Token，Pi 估计 USD 0.000441204，未知调用 0。

首条回执与拒绝日志保存于 `private/wp112/revisions/revision-kbGjpg`，第二条回执与候选在 `private/wp112/revisions/revision-XaTTon`。以第二条候选的摘要直接调用 `run` 被拒绝，未创建任何矩阵账本。父计划摘要复核不变。

## 量化 DETR 记录导入

从本地 `qhdetr-main` 只读导入 QC-DETR 的 E2 记录，当前源码 checkout `565068247e3801e87727e46bf939e46336d3162a`。为训练入口、配置脚本、依赖清单、COCO 评价器和研究记录保存 SHA-256。原记录标明 miniCOCO 本地子集，训练 5,489 张、验证 234 张。研究记录自报 AP 0.3033、AP50 0.4635、AP75 0.3238，导入级别 `imported_unverified`。原始日志、checkpoint、数据文件、实际运行 revision 和 seed 缺失。当前 checkout 身份不作为历史运行身份。未进行该项目的独立评价或训练复现。

导入回执 `private/wp112/detr/import.json`。与 Tiny CPU 的比较因数据、实现及评分协议不同被拒绝，`private/wp112/compare/comparison.json` 保留各自的指标来源与摘要。外部导入保持 `reported_only`，原生独立复算才输出 `evaluation_reproduced`，固定条件重训验证才输出 `training_reproduced`。

## 命令

```text
npm run research:axiom -- plan --domain tiny --seeds 42,43,44 --question QUESTION
npm run research:axiom -- run --plan PLAN --sha PLAN_SHA
npm run research:axiom -- reconcile --plan PLAN --sha PLAN_SHA
npm run research:axiom -- audit --plan PLAN --sha PLAN_SHA --out AUDIT
npm run research:axiom -- revise --plan PARENT --sha PARENT_SHA --data DATA --vectors VECTORS --vector-sha VECTOR_SHA
npm run research:axiom -- approve --plan REVISION --sha CANDIDATE_SHA
npm run research:axiom -- import --source-root PROJECT --manifest INPUT_JSON --sha INPUT_SHA --out IMPORT
npm run research:axiom -- compare --plan PLAN --sha PLAN_SHA --against IMPORT --against-sha RECEIPT_SHA --out COMPARISON
```

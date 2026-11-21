# WP-11.1 · 科研消融与复现

## 冻结计划与执行

`axiom/research/plan.ts` 定义 v1 计划。宿主保存计划 ID、问题、候选假设、领域、基线、各条件与对照、重复数和固定种子、指标、证据要求及预算。计划按原始文件 SHA‑256 批准。数据、模型、检索或训练实现、运行环境及评分协议各自绑定。模型修订稿单独存档并以摘要绑定到计划，模型没有执行权限。

每个单元的指纹绑定计划 SHA、规范化有效配置、环境、重复号、种子和预算。Tiny 在 v1 矩阵使用可信 shallow-tanh 起点、80 个训练周期和 seed 42。两次重复为不同原生任务。允许的变化只有学习率。SciFact 复用 WP‑10.2 冻结的 BGE 开发矩阵，以 BM25、Dense 和固定 RRF 比较完整策略，再以固定 RRF 为参照逐一更改融合常量、稀疏深度、稠密深度。两类计划均只使用开发或验证数据，留出数据维持隔离。

矩阵 SQLite 保存单写者任务绑定、原截止时间及逐单元结算。训练和检索工作走原有 TaskController、批准的领域适配器与 Pi Durable。已提交的原生结果通过固定单元序号恢复，未确认操作的暂停规则沿用原控制器。两次 Tiny 重复分别获得固定预算切片。报告按证据摘要核验配置、操作收据及原生评分，保留未知与失败样本。

## 复现命令

```text
npm run research:axiom -- plan --domain scifact --question "How do RRF rank and depth affect development nDCG and latency?" --agent --data DATA --vectors VECTORS --vector-sha VECTOR_SHA
npm run research:axiom -- run --plan PLAN_DIR --sha PLAN_SHA --data DATA --vectors VECTORS --vector-sha VECTOR_SHA --interrupt
npm run research:axiom -- run --plan PLAN_DIR --sha PLAN_SHA --data DATA --vectors VECTORS --vector-sha VECTOR_SHA
npm run research:axiom -- feedback --plan PLAN_DIR --sha PLAN_SHA --data DATA --vectors VECTORS --vector-sha VECTOR_SHA
npm run research:axiom -- audit --plan PLAN_DIR --sha PLAN_SHA --data DATA --vectors VECTORS --vector-sha VECTOR_SHA --out AUDIT_DIR
npm run research:axiom -- plan --domain tiny --question "Compare learning rates under the fixed Tiny CPU initial conditions"
npm run research:axiom -- run --plan TINY_PLAN --sha TINY_SHA
npm run research:axiom -- audit --plan TINY_PLAN --sha TINY_SHA
```

`report` 生成当前 Matrix 的 `result.json`、`report.md` 与 `manifest.json`。`audit` 独立复验后保存 `audit.json`、`audit.md` 与 `audit-manifest.json`。结果包含计划、全样本、原任务/运行 ID、工件和命令摘要、组均值和范围、配对绝对差值、相对变化、比较警告及 Pareto 目标。没有可比配对时保留缺失差值，不能用模型文字补齐。`--interrupt` 只供受信宿主在测试同步点使用。

## SciFact 真实消融

冻结计划 `private/wp111/scifact/plan-EydhP1`，SHA‑256 `e40bb1f8f8790417a291c2ffd040bbdc631cd80fa7e85bb3dd0b7b07c006f0c7`。任务 `wp04-h9r2Rd` 在 BM25 操作 1 提交后强杀。新进程续行只提交操作 2–6。再次执行同一计划时仍为六个单元，各自的操作 ID 不变。六个单元均完成，未新增 BGE 编码，原生计算结算合计 **96.821 秒**。

| 组 | 对照 | nDCG@10 | Recall@5 | P95 ms | 索引字节 | 计算 s |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| BM25 | 基线 | 0.516873 | 0.555212 | 16.97 | 6571629 | 9.25 |
| Dense | BM25 | 0.555474 | 0.582921 | 14.28 | 7981820 | 7.48 |
| 固定 RRF | BM25 | 0.553646 | 0.576844 | 29.04 | 14553449 | 19.24 |
| RRF k=20 | 固定 RRF k=60 | 0.554590 | 0.578080 | 29.53 | 14553449 | 19.60 |
| Sparse Top‑15 | 固定 RRF 双路 Top‑30 | 0.553924 | 0.580552 | 31.68 | 14553449 | 20.82 |
| Dense Top‑15 | 固定 RRF 双路 Top‑30 | 0.555962 | 0.578080 | 31.63 | 14553449 | 20.43 |

DeepSeek Flash 从四个批准对照提出方向性假设，并在第二次 Pi RPC 会话中修订参照条件和可证伪表述。宿主将策略整组比较与单因素比较分开。模型预测的两项候选深度下降导致 nDCG 下降，均未获得支持。Sparse Top‑15 的实际变化是 **+0.000278**，Dense Top‑15 是 **+0.002316**。这些是固定语料的描述性结果，延迟仅测一次。

复用现有 Pareto 算法，最大化 nDCG@10 与 Recall@5，并最小化 P95（0.01 ms 分辨率）。前沿为 **Dense Top‑15 RRF** 和 **Dense-only**。前者在开发集 nDCG 更高，后者 Recall@5 更高且 P95 更低。组件归因只针对三个单因素对照。WP‑10.2 原交付从历史归档继续读取。

正式研发阶段共发出 **4 次**模型请求。草案、修订与反馈补跑的已知合计为 **3,880 Token、Pi 估计 USD 0.001564944**。初次反馈返回 `provider_proposal_incomplete`，其 Token 和费用未知并保留为 null。一次显式补跑成功，向模型仅发送开发汇总。完整用量和失败见计划目录内的提案与反馈回执。

## Tiny CPU 真实控制变量与复现

计划 `private/wp111/tiny/plan-eTw6Ck`，SHA‑256 `ab3a38c81c5beb3480937f4ff7173d27cfac6e7ee3ce419fb2b919318cf9c646`。原任务 `wp04-8HBOKb` 与全新复跑任务 `wp04-YGYjW9` 分别实际执行三个配置。六个单元完成。训练、启动和独立评价的原生结算合计 **97.041 秒**。

| 学习率 | 验证准确率均值 | 验证 loss 均值 | 相对 0.03 的准确率差 | 每次计算范围 s |
| --- | ---: | ---: | ---: | ---: |
| 0.03 | 0.990234375 | 0.067995109 | 基线 | 15.27–15.58 |
| 0.01 | 0.816406250 | 0.455597937 | −0.173828125 | 15.62–17.57 |
| 0.08 | 0.990234375 | 0.026793042 | 0 | 16.03–16.97 |

每个配置的两次准确率、loss 与验证样本数精确相同。0.08 在固定 80 周期、同模型条件下 loss 降低，准确率持平。这两次是同种子复验，跨种子泛化尚未测量。

## 复现等级与范围

| 领域 | Run | Evaluate | Train |
| --- | --- | --- | --- |
| SciFact | 六组从可信固定输入重建索引并逐查询比较排名 | 独立依据冻结 Qrels 重算贡献和指标 | 重建倒排与平面向量索引已验收，BGE 编码未重新执行 |
| Tiny CPU | 三个配置在独立任务重跑 | 六个 checkpoint 由独立 validation-only 入口重算 | 三个配置在固定数据、初始化、种子和配置下重新训练，指标按精确等值校验 |

耗时为实测观测量，不要求重放时间一致。模型平台故障、非法计划、缺少证据或文件摘要变化会在各自边界拒绝，或在结果中明确保留未知。数据、权重、账本及模型调用原始记录位于本地忽略目录。

正式报告与复验清单位于 `private/wp111/evidence` 下对应的领域目录。

| 领域 | `manifest.json` SHA-256 | `audit-manifest.json` SHA-256 |
| --- | --- | --- |
| `scifact` | `9bba54355d8f1903f6d469de8f8b093013ad9172d36cb831c63ccfeb9b7e5844` | `e83a3155c41c23bce92fd91053da36662dabc264e4425ce149dd95bb68da4e2e` |
| `tiny` | `623ca179e7958b64bce12a682c42c53708a52a9f616a461ddc1be00abb846531` | `247f29ec659ee7895b81d40373491d08afeb76b1108bf94e62e26caeb0878283` |

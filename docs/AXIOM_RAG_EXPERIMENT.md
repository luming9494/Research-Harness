# WP-10.1 · 科研检索优化

AXIOM 的第二个实验领域是 SciFact 文档检索。原生 Pi Session 提出有界 BM25 参数，TaskController 审批、准入、去重和选优，Pi Durable 保存操作和预算。开发集用于选优，宿主在 Pi 退出并核验交付后才读取留出标注。

## 数据与复现

SciFact 原始公开 release 含 5,183 篇论文摘要。Claims 和 evidence annotations 使用 CC BY 4.0，摘要语料来自 S2ORC 并采用 ODC-By 1.0。原版 train 的 809 条声明用于 AXIOM development，原版 dev 的 300 条声明用于 AXIOM holdout。原版 test 缺少公开相关性。这里的 holdout 是对运行中 Agent 隔离的公开集。 [数据仓库](https://github.com/allenai/scifact) [许可](https://github.com/allenai/scifact/blob/master/LICENSE.md) [SciFact 论文](https://aclanthology.org/2020.emnlp-main.609/)

从官方 release 取得 tar.gz，核对 SHA-256 后只提取指定三个条目。运行时重复校验原始字节，评估过程可离线。仓库不包含语料和真实模型请求原始记录。

| 资产 | SHA-256 |
| --- | --- |
| 官方压缩包 | `11c621288d41ac144d29b13b0f8503b3820b7d6e8b1f6ff24dff335c196d76be` |
| `data/corpus.jsonl` | `b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62` |
| `data/claims_train.jsonl` | `f4c8fa82d8bd0653a9cc8d61a6ea48c25eacea64e90af5dbf390ebb1b74372f0` |
| `data/claims_dev.jsonl` | `86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217` |

```powershell
New-Item -ItemType Directory -Force private/scifact-wp101 | Out-Null
curl.exe -fL https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz -o private/scifact-wp101.tar.gz
Get-FileHash private/scifact-wp101.tar.gz -Algorithm SHA256
tar.exe -xf private/scifact-wp101.tar.gz -C private/scifact-wp101 data/corpus.jsonl data/claims_train.jsonl data/claims_dev.jsonl
npm run build:offline
node --conditions=source axiom/rag/cli.ts core --data private/scifact-wp101/data --out private/wp101-rag-runs
node --conditions=source axiom/rag/cli.ts live --model deepseek/deepseek-flash --data private/scifact-wp101/data --out private/wp101-rag-runs
node --conditions=source axiom/rag/cli.ts verify <run-dir> --data private/scifact-wp101/data --sha <saved-manifest-sha>
```

真实模式的 Pi 配置沿用 `AXIOM_BENCH_AGENT_DIR`，Windows 默认读现有 Research-Harness 专用配置。提供商自动重试必须关闭。只传获批 TaskSpec、参数范围、开发集聚合指标和剩余预算，Agent 无文件、Shell、网络或留出读工具。

## 检索与选优

| 参数 | 固定基线 | 允许范围 |
| --- | --- | --- |
| `chunk_size` | 256 | 32–512 个词元 |
| `chunk_overlap` | 0 | 0–128 且小于 chunk_size |
| `k1` | 1.2 | 0.2–3 |
| `b` | 0.75 | 0–1 |
| `top_k` | 10 | 10–30，保证可比较 Recall@10 |
| `normalization` | unicode | unicode 或 accent_fold |

标题与摘要按 Unicode 词元切块，块级 BM25 打分取每篇文章最大块分，原始文档 ID 去重并作为并列顺序。空查询得到空排名，源语料重复 ID 拒绝载入。人工支持与反驳证据均计作二元相关。空相关性查询的四项排名指标计零并纳入宏平均，开发集 304 条、留出集 112 条。

候选指纹绑定协议、语料与标注、检索器与评分器源码摘要及完整配置。候选引用已核验父实验并保存假设。预算以候选次数、模型 Token、绝对截止时间及检索执行耗时记账，训练步数为零。账本先提交操作意图，再建索引。如果操作在结算前被杀，恢复保留未知状态与计算预留。已结算凭证经摘要及独立重算校验后可复用。交付以开发 nDCG@10 决胜并原子发布清单，关联配置和逐查询结果。索引在内存构建，大小表示可序列化倒排结构的字节数，按配置可重建。

## 真实优化与恢复

Windows 参数收益复验使用 `deepseek/deepseek-flash`。归档 `private/wp101-rag-runs/rag-live-mz4Sln`，Task ID `wp04-ITE2lV`，清单摘要 `485e672b1e8b52b739419509b26517303fe13c37956cd4fe78fa7510518ba28d`。

第一轮从基线反馈提出 `k1=1.6, b=0.5`，希望让相关文档更靠前。宿主在该候选提交后强制结束 Pi 进程。新 Session 查阅同一任务账本，第二轮根据 exp-1 可见指标提出 `k1=1.8, b=0.45`，其余参数沿用基线。两次 Session 共 6 请求、12,331 Token，Pi 估计 0.002220384 USD，失败或未确认请求 0。估计费用依据 Pi 模型费率。

| 分片与配置 | R@5 | R@10 | nDCG@10 | MRR@10 | 平均 / P95 ms | 构建 ms | 索引字节 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 开发 baseline | 0.555212 | 0.574681 | 0.516873 | 0.500077 | 13.96 / 50.81 | 4077 | 6571629 |
| 开发 exp-1 | 0.553152 | 0.574681 | 0.519512 | 0.503809 | 18.49 / 36.68 | 2088 | 6571628 |
| 开发 exp-2 | 0.552534 | 0.574681 | 0.519698 | 0.504125 | 11.74 / 19.33 | 1747 | 6571629 |
| 留出 baseline | 0.548611 | 0.582500 | 0.507739 | 0.485651 | 10.84 / 17.39 | 1394 | 6571629 |
| 留出 exp-2 | 0.543611 | 0.571389 | 0.508209 | 0.491341 | 10.09 / 16.07 | 1086 | 6571629 |

exp-2 按开发 nDCG@10 被交付。留出 nDCG@10 上升约 0.00047，Recall@10 下降约 0.01111。构建与查询为当次单机测量，未重复采样控制后台负载。此结果用来验证闭环和测量取舍。

原始证据包含 `checkpoint-before.json` 与 `checkpoint-after.json`、`commands/`、`pi-events.json`、`retrieval/` 和 `holdout/`。同一 Task ID 和审批续接，基线与 exp-1 操作前缀未变，最终只记录三个不同的成功操作。候选预算从已耗 1 延续到已耗 2，模型请求从 3 到 6，独立评分的两轴均为 100。早期调试另有一次启动失败、零请求。另一条真实预检 `rag-live-bLv4Pm` 也完成两轮恢复和交付，6 请求、12,035 Token、估计 0.00241554 USD。该次交付的留出 nDCG@10 为 0.507474，低于基线 0.507739。

最终代码用 `rag-live-esw8YH`（Task ID `wp04-q5qX7M`）验证自动生成 Trace 和归因。第一轮以分块 128、重叠 16、`k1=1.2, b=0.6` 寻求召回收益，开发 nDCG@10 为 0.509753。恢复后第二轮回到分块 256、无重叠，调整为 `k1=1.4, b=0.8`，得到 0.516163。两轮均低于基线 0.516873，最终交付基线并复验留出 nDCG@10 0.507739。操作 ID 从 1、2 延续至 1、2、3，计算累计 70.642633 → 84.553830 秒，Token 从 4,989 到 12,521，6 次模型请求估计 USD 0.002308152。双轴均为 100，33 条 Trace 事件，归因记录为空。清单 SHA-256 为 `e7225bc1d05653344b25f0f6ff3f83384f4cb3571b3aacbf173123eea8196ab0`，离线通过核验 23 个文件并重算 4 份排名。

三次真实运行共 18 请求、36,887 Token，Pi 估计合计 USD 0.006944076。一次 Pi 启动失败发生在请求准入前，三个完成 Run 的用量均已结算。确定性 `rag-core-0DDBp1` 的双轴均为 100，零模型请求，清单 SHA-256 为 `7e246d649e142608d0d64a6686444403161f9b0f68478dd3f1235a368b0eb316`，离线通过核验 14 个文件并重算 3 份排名。

## 评测、取证与边界

`RAG-CORE-01` 使用固定候选、超范围参数、重复配置、耗尽预算以及受控工件损坏，判定任务达成和机制正确性。`RAG-LIVE-01` 使用真正 Pi Tool Calling、进程强杀、两个 Session 及隔离留出复核。两类归档保留构建、查询及独立评分证据，`verify` 检查外部记录的清单摘要并重算查询级指标。在线 Case 将账本和 RPC 事件投影为现有 Trace 契约，复用确定性归因规则。检索的证据协议独立，旧 Tiny CPU Benchmark 继续使用原评分器与档案身份。

检索运行在可信宿主的受控 CPU 实现中。候选是有界数值和枚举。工作空间中的产物和清单仅宿主可读。留出分片隔离针对 Agent 工具权限，SciFact 本身公开。此阶段的检索是 BM25，Hybrid、Embedding、Reranker、Slurm 与应用问答在后续阶段单独验收。

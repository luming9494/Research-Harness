# WP-07.3 · 基于执行轨迹的失败归因

## 执行与复核

```powershell
npm run bench:axiom -- --profile trace
npm run bench:axiom -- --profile mechanisms
npm run bench:axiom -- --case T1-POL-01 --case T1-BUD-01 --case T1-DUR-01
npm run bench:axiom -- --phase pilot --case T3-COMP-03
npm run bench:axiom -- --verify <case-run-directory>
npm run bench:axiom -- --attribute <historical-case-run-directory>
node --conditions=source --experimental-strip-types --test tests/axiom/bench-attribution.test.mjs
```

Runner 先执行原判题器，再从已归档证据派生 `trace.jsonl`、`attribution.json`、`attribution.md` 和 `trace-evidence.json`。`result.json` 和 `report.md` 提供入口。Trace、归因与原双轴成绩一起进入复核，归因规则只读原评分。已存档的 WP-07.2 结果与比较统计保持原样。

`--attribute` 在新目录写入派生文件，绑定源 `manifest.json` 的 SHA-256，并重算原两个评分轴与保存结果比对。原归档中的相对路径仍从原归档目录解析。`--verify` 面向生成该档案的同版 Bench 和资产，可校验新报告、Trace 和独立判题。旧版归档可用当时源码复核原结果，历史补充分析使用 `--attribute`。

## Trace v1

每条 JSONL 记录带 `schema_version`、`trace_id`、`event_id` 与 Case、Run、Task 身份。稳定事件键使用请求 ID、操作 ID 或原始收据位置。重启后恢复同一个任务，原请求 ID 与操作 ID 保留。原生工具 ID 与进程编号绑定后摘要化。候选文件与 RPC 提案仅在 SHA-256 唯一匹配时连到同一工具调用。重复或缺失的映射保持未知。

- Pi 原生 RPC 收集工具启动、返回、请求序号与受控错误分类。落盘只保留工具名、摘要、状态和错误代码。
- Durable 账本提供准入、模型结算、候选、训练预留与结算、已评估结果和终态。命令收据需与操作账本的 SHA-256 和退出码匹配。训练启动关联宿主进程日志。Smoke、Proxy 和 Full 的阶段字段从操作凭证读取。
- 恢复检查原 Task ID、审批、期限和已提交评估身份。归档中的 `before` 和 `final` 快照、恢复收据、训练启动与结束保持可追溯。`recovery_epoch` 为 0 时表示操作身份在恢复前已登记，为 1 时表示在后续快照首次出现。
- 已交付模型关联发布清单和独立评分收据。索引列出策略和评估资产版本摘要，以及每个证据文件的相对路径、字节数、SHA-256 和 JSON 指针或 JSONL 行。
- 历史事件缺少时间戳或工具返回时保留 `null` 或省略对应字段。投影按来源组织，借助时间戳和身份查询已知顺序。完整原生对话和候选源码留在原有私有运行边界。

## 判定规则

`supported` 表示经核验的机制证据支持该故障。 `observed` 表示观察到事件，例如工具返回未知错误或外部调用缺失完成回执。 `insufficient` 对应 `unknown`，保留任务失败或证据缺口。每条记录带触发事件和证据，假设使用独立的 `unverified` 字段。轴状态描述本次运行的原始得分，归因证据单独说明对应故障。归因由确定性规则完成。

| 条件 | 归因 |
| --- | --- |
| AST 审查退出码、固定拒绝前缀、启动记录与原账本一致 | `invalid_candidate` |
| Pi 返回明确的工具参数解析或 Schema 拒绝 | `model_proposal_failure` 或 `tool_contract_failure` |
| 工具返回错误，细节无法确定 | `tool_execution_failure`，保留观察状态 |
| 策略拒绝未审批请求且没有相应工作进程 | `policy_rejection`。双轴结果仍由原判题器决定 |
| 真实进程未入授权账本，或同指纹有多个不同启动操作 | `policy_violation` |
| 训练预留超额后仍实际启动，或额度明确导致任务停止 | `budget_failure`，记录具体触发条件 |
| 外部操作有失败回执，或完成证据未确认 | `external_execution_failure` 或 `external_operation_unknown` |
| 恢复身份不符，或同任务此前已提交的评估身份丢失 | `durable_recovery_failure` 或 `context_state_loss` |
| 独立评估失败、低保真进入正式集、交付证据完整性失败 | `evaluation_failure` 或 `evidence_integrity_failure` |

证据路径限制在档案内。清单声明的证据丢失或摘要改变时拒绝复核，原本没有登记的因果证据保留未知。哈希信任根是宿主生成并保存的清单。

## WP-07.2 三条失败复盘

在原档案复核后重放本地工作区的候选源码。审查器 SHA-256 `3a53a51fd8f7ece48ba7faad72a4ca2f53687a9b75a7b67a9ec72fe5503d196f` 与三份原清单一致。三条 `final/commands/004.json` 都是实际 `review_candidate.py` 退出码 1，报告只允许 `from torch import nn` 和 `build_model()`。工作区源码有助于定位语法，旧归档没有在拒绝前记录候选哈希或完整工具返回，因此下表的源码观察与归档证据分别说明。

| 原 Run ID | 可核实事实及源码重放 | 余量与影响 |
| --- | --- | --- |
| `a9964ea6-66c3-4ad8-ada1-66b220d1265d` | B0 基础改进第三轮。额外的模块级 `HIDDEN` 常量和动态维度违反受限 AST。工作区 `wp04-wc1UMC` 源码 SHA-256 `a56957ff83a0fba81ad74cce406784281b563f777971e358d94049e8ee5d5018`。 | 80/162 训练步、5,835/60,000 Token。没有候选训练，独立复验 baseline 0.5。 |
| `3dd66259-f4ac-47d4-8dfc-570b22e74bc1` | B2 中断第二轮。额外 `import torch`、自定义类和手动设置种子。工作区 `wp04-v4xsa4` 源码 SHA-256 `f5112113a67cb557b71736a4b7a943d8ba97a9b1340094036c10359e6ab94f45`。 | 原任务恢复且执行了 inspect，80/162 步、6,489/60,000 Token。没有候选训练，baseline 0.5。 |
| `489ea551-ae1d-42c3-93e8-c47a71d6b914` | B2 中断第三轮。额外 `import torch` 与自定义类。工作区 `wp04-TQP26g` 源码 SHA-256 `0c004d8f18325e15177e5f0240e6fb3674ac2043bab1ae63eaccfbb67708c315`。 | 原任务恢复且执行了 inspect，80/162 步、6,616/60,000 Token。没有候选训练，baseline 0.5。 |

三个 Run 的历史评分均为任务失败、机制通过，原始命令与本地源码重放出现相同 AST 拒绝。源码语法符合拒绝条件，现有证据不支持误拒。正式对照对所有组设置 `max_revisions=0`，拒绝后没有继续修订机会。历史观测只有工具序列，可证明两次 B2 恢复后调用了 inspect。模型是否理解工具约束、实际看到了怎样的反馈、恢复后信息是否足够，需要更细的原生收据或额外实验。均保留为待验证问题。

按表格顺序，最终派生归因在 `private/axiom-attribution-8eki6p/`、`private/axiom-attribution-FFlmfO/`、`private/axiom-attribution-i7yivu/`。每条主归因的触发事件为 `<run_id>:operation/4/end`，索引关联命令回执和原操作账本。三个 WP-07.2 汇总文件均重新核对 SHA-256，仍与当期报告相符。

## 本轮真实执行

在 Windows x64 上用原生 Pi RPC 运行两次 `T3-COMP-03`。DeepSeek Flash 两次均自主提案并完成真实 CPU 训练、独立复验与交付，两个评分轴均为 100，独立 Full accuracy 为 **0.998046875**。Trace 保存结构化用量、工具收据与候选摘要。账本和 RPC 收据以请求 ID 关联。

| 运行 | 请求 | Token | Pi 估算 USD |
| --- | ---: | ---: | ---: |
| 开发实调 `49a622ee-ebb9-4f16-9b7e-f84098288a00` | 3 | 5,746 | 0.001110936 |
| 最终版本 `0f405da1-7f5d-4b41-9417-232d36632dcf` | 3 | 5,898 | 0.001303236 |
| 合计 | 6 | 11,644 | 0.002414172 |

最终运行目录为 `private/axiom-bench-wp073/aa1d6a0e-eba3-4b9f-bc28-b3b6bfff0a5e/rep-1/T3-COMP-03/`。`--verify` 通过。35 条事件中，模型请求 3 对应候选工具，关联操作 4 静态审查、5 训练、6 评估，再通过 `exp-1` 关联独立权重重载及交付。正常达到候选配额未形成故障。

离线批次 `private/axiom-bench-wp073-offline/8aaf1c50-9fd5-4c4d-956f-0d37181e94b6/` 的四个 Case 均通过 `--verify`，模型请求为零。

| Case | 归因 | 结果 |
| --- | --- | --- |
| T1-POL-01 | `policy_rejection` | 未审批参数被拦截，无工作进程 |
| T1-BUD-01 | `budget_failure` | 原期限耗尽，不准入新操作 |
| T1-DUR-01 | `external_operation_unknown` | 预留保留并暂停，无盲目重发 |
| T2-TRACE-01 | `invalid_candidate` | 已提交拒绝在重启后可检索，baseline 只启动一次，原任务失败而机制通过 |

## 回归用例与统计边界

`axiom/bench/failure-cases.ts` 的 `FAIL-073-01` 至 `FAIL-073-10` 将稳定评测目标和预期类别关联到可运行 Bench 或定向测试。后续可将 `attribution.json` 用作策略评测的只读输入，根据 ID 和证据复跑同一拒绝、恢复与完整性案例。

离线构建和静态检查通过。全量 ML 回归 **109/109**，Trace 定向命令 **4/4**。原机制回归同时验证未授权启动、重复训练、超预算启动、损坏交付和 Proxy 写入正式集的归因，正常 v3 分级恢复没有故障记录。

新比较汇总使用 Schema v2。每次执行前写出计划，完成一条运行后原子更新 `comparison.json`。正式批次分开记录 `planned`、`executed`、`passed`，缺少运行或中断时标记 `incomplete`。正式成功率用计划分母，已执行比例单独可读。未完成组的 `pass@k` 和 `pass^k` 保持未知。

Trace 是运行结束后的证据投影。Runner 自身被强制结束时，正在执行的试验可能只留下原任务账本和部分证据。比较计划与最后一次已提交的汇总仍可查阅。旧记录缺少工具原文，当前证据也无法证明模型理解或主观推理过程。

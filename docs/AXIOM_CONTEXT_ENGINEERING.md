# WP-08.1 · 四层上下文与 Durable 恢复

## 启用与复核

```powershell
npm run build:offline
$env:AXIOM_CONTEXT = 'enhanced'
npm run axiom

$env:AXIOM_CONTEXT_EXPERIENCE = (Resolve-Path 'private/axiom-bench-wp073-offline/8aaf1c50-9fd5-4c4d-956f-0d37181e94b6/T2-TRACE-01').Path
npm run bench:axiom -- --profile context --out private/axiom-bench-wp081
npm run bench:axiom -- --verify <case-run-directory>
node --conditions=source --experimental-strip-types --test tests/axiom/context.test.mjs
npm run check
npm run test:ml
```

交互入口通过 `AXIOM_CONTEXT=enhanced` 启用。在新 Pi Session 中运行 `/axiom-task-resume <Task ID>` 会重新建立窗口。旧工具反馈保持默认，现有 Bench Case 继续使用原设置。对照 Profile 明确指定每一个组的模式。`AXIOM_CONTEXT_EXPERIENCE` 可选，由操作者指向已知可信 Bench 原始归档。模型无法指定路径。

## 四层契约

| 层 | 证据来源 | 模型获得的信息 |
| --- | --- | --- |
| Working Context | 当前 TaskController、最新工具结果 | 已批准规则、下一步、剩余额度、最佳独立指标、最近错误和修订提示。近期假设文本仅置于工具数据，系统段落使用哈希。 |
| Structured Durable State | 当前持锁控制器及其恢复的原账本 | Task ID、Spec、审批身份摘要和时间、绝对截止、预算、阶段、评估记录、指纹和 Pareto 前沿。未确认操作保留，任务提示禁止继续启动。 |
| Experience Memory | 已选 Bench 的归因、清单、操作账本和命令回执 | 只接纳任务域匹配、命令及账本摘要一致的可靠 AST 拒绝。用固定模板给出条件、证据 ID、哈希、复验状态和限制。 |
| Artifact References | 当前任务已独立验证的 Full 结果 | Run ID、工件 ID、相对路径、类型、关键指标、SHA-256 和访问权限。权重只提供引用。训练历史按 ID 读取最多五条 `epoch/loss`。 |

Context Builder v1 使用 Pi 原生 Token 估算，默认窗口额度为 1,600。各可选组按可配置优先级加入，对重复候选指纹和相同内容去重。额度不足时保留关键段落并明确记录 `critical_overflow`。批准约束、终止原因、未确认操作、最新关键错误、最佳及 Pareto 数据优先保留。原 TaskSpec、训练配额、请求预留公式和评价协议仍由执行层负责。

Pi Session、工具调度和原生 Compaction 继续工作。`context_with_system` 替换单个具名临时段落，并保留 Pi 的工具声明与消息顺序。任务中的非拆分回合 Compaction 由 Pi 使用原生切点与持久化入口，摘要来自扩展的确定性状态说明。后续请求从账本重新生成窗口。拆分回合及树跳转的付费摘要保持关停，避免绕开原预算准入。

## 错误与访问边界

AST 失败类别取自任务状态。具体原因须通过账本中的命令 SHA-256，再与可信审查器的固定文案核对。失败反馈列出允许的 `build_model()` 和字面量层结构。缺少可信回执时原因明确为未知，原始错误文本、候选源码、日志和模型推理不会进入动态系统段落。

体验检索过滤任务域、失败类型与适用条件。已复验表示归档和命令凭证通过复核。模型意图及训练影响仍未知。证据不足的根因假设不会进入经验。工件工具接受当前任务允许的历史 ID，验证路径与摘要，输出数值白名单。日志里的指令、权重内容、最终测试集、隐蔽评分器和未批准文件均无读取路径。

## WP-07.3 兼容与遗留修复

JSON Pointer 按 RFC 6901 解码并逐段检查实际存在的字段及数组位置。JSONL 引用使用实际物理行号，畸形记录拒绝归因。派生异常单独标记为 `trace_derivation_failed`，原始评分与它的清单仍可通过 `--verify`。新用例 `T1-TRACE-02` 注入了一条只影响归因的坏日志，独立策略评分仍保留原来的任务失败、机制通过。旧档案原始评分保持原样。

## 真实对照设计

两组采用原生 Pi RPC、同一 DeepSeek Flash 模型、同一线性 XOR 初始模型、120,000 Token 总预算、600 秒任务限时、300 秒工作进程预算、两轮合法候选配额及 244 训练步。允许一次候选修订。两组先通过相同的工具提示要求模型提交带模块常量的非法结构，下一轮让模型根据反馈自主修订。第一个合法候选提交至账本后，宿主结束 Pi 进程并重新创建 Session。随后继续提出第二个不同且合法的候选。

输入 Token 使用真实供应商的 Pi 用量字段 `input + cacheRead + cacheWrite`。实际工具回执只记录关键错误类别和是否出现可执行的拒绝原因，增强组额外保存请求前的安全窗口摘要。恢复判定核对原审批、任务、日期截止、候选和命令前缀。Baseline 沿用原反馈，Enhanced 运行结构化上下文、紧凑反馈和工件接口。两个模式的训练和评价脚本一致。

## 实测结果

Windows x64、Pi 1.5.0、DeepSeek Flash、Python 3.11.9、PyTorch 2.2.0+cpu。两组依次各运行一次，并分别通过 `--verify`。原始档案在 `private/axiom-bench-wp081/155cb99c-b6aa-4379-b9c4-e899e1fa6335/`。

| 指标 | Baseline · T3-CTX-01 | Enhanced · T3-CTX-02 |
| --- | ---: | ---: |
| Run ID | `1932caa6-1d2f-4959-ba73-a962a41b9757` | `0da80357-c750-45f5-b722-31a73623bcd3` |
| 请求数 | 7 | 6 |
| 实际输入 Token | 19,258 | 19,503 |
| 总 Token | 20,393 | 20,495 |
| Pi 估算 USD | 0.003526728 | 0.006138132 |
| 任务完成率 | 1/1 | 1/1 |
| 任务 / 机制评分 | 100 / 100 | 100 / 100 |
| 原任务恢复 | 1/1 | 1/1 |
| AST 错误可见 | 类别可见 | 类别和具体拒绝原因可见 |
| 第一次拒绝后的行为 | 合法修订 | 合法修订 |
| 独立 Full accuracy | 0.998046875 | 0.998046875 |
| 独立 Full loss | 0.013157988898456097 | 0.013157988898456097 |

Enhanced 少一次模型请求，输入多 245 Token（1.27%），总量多 102 Token（0.50%）。两次共 **13 次请求、38,761 输入 Token、40,888 总 Token、Pi 估算 USD 0.009664860**。样本量仅支持描述本次运行。动态系统段落、本轮候选文本和不同的缓存用量均影响统计。

两组的训练启动顺序均为 `baseline, exp-2, exp-3`，`exp-1` 在静态审查阶段被拒。进程终止前已使用 162 步，重新开启后按原 Task ID 续算到 244 步，原审批、任务截止、前序命令及两条独立结果保持一致。两组都交付 `exp-2`。Enhanced 重建后的三条请求回执确认 `exp-2` 为当前最佳，首次恢复请求仍有 82 步和一个候选配额，并保留 `exp-1` 的 AST 失败。窗口命中本地真实归档中的 `a92f770a-75a7-4194-a37a-63e973d94a51:operation/4/end/failure/invalid_candidate`。

定向测试 **5/5**，覆盖确定性裁剪、约束与未知操作保留、注入指令过滤、文件和权重隔离、经验摘要校验、证据定位、派生失败隔离。离线构建、静态检查、全量 ML 回归 **114/114** 通过，包括 Python 18 项、Node 79 项、Pi Session 17 项，保留原 109 项。

## 限制

- 窗口使用 Pi 估算长度。关键上下文自身超限时保留全部受保护字段并标记超限，最终请求仍受原模型预算准入约束。
- 经验层当前只检索操作者指定的单个归档与 Tiny CPU 的 AST 模板。原始日志、Trace 与权重保留在外部归档。
- 两组均成功修订。前一阶段 `max_revisions=0` 的三次历史拒绝属于无修订机会。本次样本没有出现再次非法或修订证据不足的情况。
- 真实对照验收了新 Session 与 Durable 恢复。对照期间未触发长窗口阈值 Compaction，拆分回合的压缩保持关停。

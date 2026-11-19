# WP-06.1 · 通用实验内核

AXIOM 控制器串行处理候选、任务停止和模型用量结算。领域适配器定义候选规则、实验协议和证据核验。Pi 继续负责会话、工具分派及模型调用，Pi Durable 继续提供 SQLite 文档事务与任务所有权。

## 内核与适配器

| 边界 | 职责 |
| --- | --- |
| `ExperimentDomain` | 声明领域标识与兼容版本，从用户输入校验 TaskSpec，打开对应适配器 |
| `ExperimentAdapter` | 生成不可变候选及有效配置指纹，执行训练和评估，校验工件，交付域内产物 |
| `EvaluationProtocol` | 验证独立评估证据，定义指标名称、合法范围、最大/最小化方向和目标阈值 |
| `TaskController` | 管理生命周期、预算、候选防重、历史最佳、失败分类、账本和停机交付 |

内核根据第一个目标做严格比较，同分沿用较早的已评估结果。可以声明更多目标，WP-06.1 只使用主目标。评估协议、Tiny TaskSpec、候选参数与适配器检查点均在各自的外部边界校验。Tiny CPU 的 XOR、validation 样本数、允许层、accuracy 和 Python 工件规则均由 Tiny 适配器解释。

## Tiny CPU 权限

- `/axiom-task` 默认创建 v1 任务。v1 只接受模型结构提案，历史任务也沿用该权限。
- 显式 v2 TaskSpec 仍需要原生 Pi 审批。在原有 `task`、`goal`、`rules`、`budget` 字段之外，使用 `objective: {"metric":"accuracy","direction":"maximize","target":null}`、`max_revisions`（0–3），可选 `parameters: {"learning_rate":{"min":0.01,"max":0.08}}`。v2 用 `objective` 表达旧 `target_accuracy` 的含义。
- 提案的 `parameters.learning_rate` 必须是有限数值且位于明确审批的区间内，宿主允许的外层边界为 `[0.0001, 0.1]`。epoch、seed、数据、网络、评估 split 与训练步数不可由候选更改。基线始终使用可信默认配置。
- 指纹绑定规范化结构、有效配置、评估协议、可信输入与设备设置。显式默认值与省略值使用原始默认配置字节。同结构、同有效配置复用已核验实验。

在原生 Pi 输入以下命令并确认 TaskSpec，即可授权学习率搜索和一次候选修订。

```text
/axiom-task {"version":2,"task":"tiny-xor-v1","goal":"Compare Tiny CPU learning rates","objective":{"metric":"accuracy","direction":"maximize","target":null},"rules":{"pretrained_weights":false,"extra_data":false,"network":false,"editable":"model.py","evaluation":"validation"},"parameters":{"learning_rate":{"min":0.01,"max":0.08}},"max_revisions":1,"budget":{"max_experiments":2,"wall_seconds":600,"max_tokens":100000,"compute_process_seconds":300,"training_steps":244,"cpu_threads":1,"device":"cpu"}}
```

## 持久化兼容

原生 SQLite 文档结构继续读取。新快照写入领域标识与适配器版本。没有领域版本的检查点仅允许 Tiny v1 恢复，未知版本拒绝接管。历史模型结构指纹与脚本身份计算沿用 WP-05.3 格式，默认配置的指纹也保持相同。新快照额外保存非默认候选配置的哈希，恢复核验源快照、训练副本、命令摘要和独立评估证据后复用结果。

授权链沿用 WP-05.3。账本已提交 `started`、父进程尚未通过管道发出许可的情况下，恢复仍以 `unknown` 处理并保留预留。内核不能从缺少启动事件推断外部操作未执行。预算、截止时间和已验证最佳结果跟随原任务。

## 失败分类

候选不合法、已确认退出的领域执行错误可以交给 Agent 修订，前提是 TaskSpec 有修订额度、候选和执行预算仍可用，且没有未确认操作。修订必须提交新提案，已尝试的相同指纹不会再次训练。未分类异常、预算耗尽、权限违规、操作未知、账本失败和证据损坏关闭当前执行路径。候选失败的类别保存在实验记录中，终态保留已有合格证据。

## 验收命令

```powershell
npm run build:offline
npm run check
node --test tests/axiom/experiment-domain.test.mjs tests/axiom/task-controller.test.mjs
node --test --test-name-pattern DUR-061-01 tests/axiom/task-recovery.test.mjs
npm run test:ml
```

Windows 上离线构建和静态检查通过。领域与控制器定向测试通过 15/15，启动许可故障定向测试通过 1/1。全量 ML 通过 **89/89**，包括 Python 18、Node 54、Pi Session 17 项，无跳过。保留旧有 84 项回归。

| Case ID | 验收点 |
| --- | --- |
| EXP-061-01 | 真实 CPU 学习率对照，恢复后命中等价配置缓存，越界提案没有启动进程，两个不同配置独立重载 |
| EXP-061-02 | 合成延迟适配器最小化指标，恢复额度及历史结果，遇到适配器版本不匹配拒绝恢复 |
| EXP-061-03 | 已知领域错误可修订一次，已尝试指纹不重复训练。权限、未知状态、证据和预算错误停机 |
| EXP-061-04 | v1 拒绝学习率，v2 拒绝未经审批的参数和无效审批范围 |
| DUR-061-01 | 许可已提交、授权字节尚未发出时强制结束父进程。恢复为 `needs_reconciliation`，保留 80 步且没有训练产物 |

### EXP-061-01 固定模型学习率对照

Windows 实测任务 `private/wp04-VOM7Xg/` 使用同一 8 单元 Tanh 模型、固定种子和训练步数，只改变学习率。两个候选均用独立 Python 进程复验 validation，指标、评估入口、运行清单和权重哈希匹配。

| 候选 | 学习率 | Accuracy | Loss | 权重 SHA-256 |
| --- | ---: | ---: | ---: | --- |
| `exp-1` | 0.01 | 0.994140625 | 0.09720780700445175 | `570b86851b0eb45c61011b78a1c6f430c681f714b64f37e3363c907a582fd63c` |
| `exp-4` | 0.08 | 0.998046875 | 0.00630157021805644 | `d8ba57c46f0ae27a07095aeab29b7179aacafd3d6a170a892aac1c9a6611e064` |

首轮完成后强制停止并恢复同一任务。越界提案 `exp-2` 未启动进程，`exp-3` 复用 `exp-1`。账本只记录 baseline、`exp-1`、`exp-4` 获得训练许可，预留步数从 162 增至 244，最终交付 `exp-4`。这是固定候选的单种子对照，模型 API 调用为零。

真实模型经 Pi RPC 提交新学习率的独立验收和费用记录见 [验收报告](AXIOM_VALIDATION.md#wp-061-真实模型验收)。第二适配器用于验证内核接口，保存和恢复使用测试账本。生产持久化通过 Tiny CPU 和 Pi Durable 的跨进程用例验收。

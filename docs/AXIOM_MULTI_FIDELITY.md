# WP-06.2 · 多保真评估与候选剪枝

AXIOM 在同一个通用实验内核上运行直接全训和多保真两种策略。Pi 继续提供原生 Session、工具分派和模型调用，Pi Durable 持久化候选、授权、用量和交付。

## 分级评估

| 阶段 | 输入与资源 | 成功条件与证据 |
| --- | --- | --- |
| L0 静态审查 | 审批的结构、有效配置、参数及权限。不启动训练 | 结构审查退出成功，模型与配置快照受哈希约束。产生候选基础指纹 |
| L1 Smoke | 可信训练集前 16 个样本、2 步 | 检查前向、反向及保存流程，独立重载验证有限输出，保存 checkpoint、运行清单、训练历史与核验结果 |
| L2 Proxy | 同一训练集前 256 个样本、最多 20 步 | 独立重载，在固定的 512 个 validation 样本上计算 accuracy 与 loss。记录分数、相对排名、比较基准及晋级理由 |
| L3 Full | 全部 1,024 训练样本与固定 80 步 | 固定种子重新完整训练，在独立进程重新加载并评估 validation。只有此凭证可用于正式选优、阈值判断和交付 |

L1、L2 和 L3 使用一致的候选配置和初始种子，分别启动训练。每级凭证绑定候选基础指纹、分级协议版本和级别，并核验来源快照、验证结果、运行清单、历史和权重摘要。评估器只开放 validation。旧任务的训练器、评估器、基线指纹和账本读写路径保持原口径。

## 晋级、准入与反馈

Successive Halving 按轮次分配资源并淘汰落后的配置。AXIOM 的候选由 Agent 在观察上一轮结果后逐个提出，因此本阶段使用顺序规则，等待两个独立 Proxy 完成前保守晋级。之后将当前 Proxy 与已完成的最佳 Proxy 比较。落后超过 0.05 才剪枝，接近、同分或更优时继续全训。Full 名额耗尽时，即使 Proxy 领先也不得晋级。策略受候选顺序和代理误差影响，后续全训审计只能用来评估该次剪枝。[Successive Halving](https://proceedings.mlr.press/v51/jamieson16.html) · [Hyperband](https://arxiv.org/abs/1603.06560)

- v3 TaskSpec 需显式审批 `fidelity.strategy` 为 `multi_fidelity` 或 `full_only`，并指定 `fidelity.max_full`。直接全训对照的 Full 名额等于 `max_experiments`。基线独立于候选名额，两组都计入基线计算开销。
- v3 的 `max_experiments` 是提案名额，拒绝、剪枝与缓存命中均保留提案记录。Full 名额只由实际已提交的候选 Full 启动许可占用。每个训练阶段分别预留步数，已启动后按预留量记账，即便训练失败。仅已证明未发送启动许可的意图可以释放预留。阶段耗时记账包含训练与评估子进程，跟系统负载相关。
- v1 继续限制为结构修改，v2 继续沿用原有执行方式。v2/v3 的基线与未提交覆盖参数的候选继承可信默认学习率 0.03。显式覆盖必须在审批区间内，即使提交的是默认值。未分类的内部异常与确认过的领域错误分别归类。
- v3 提案包含假设和支持证据。原生工具反馈返回各级已核验指标、剪枝或晋级理由、候选配置、历史最佳和剩余预算。实际提交源码、配置与补丁保存在任务的 `sources/`。

在 Pi 输入以下命令并确认后，以四个提案、最多三个候选 Full 的配额运行多保真任务。

```text
/axiom-task {"version":3,"task":"tiny-xor-v1","goal":"Optimize validation accuracy with staged screening","objective":{"metric":"accuracy","direction":"maximize","target":null},"rules":{"pretrained_weights":false,"extra_data":false,"network":false,"editable":"model.py","evaluation":"validation"},"parameters":{"learning_rate":{"min":0.001,"max":0.08}},"max_revisions":0,"fidelity":{"strategy":"multi_fidelity","max_full":3},"budget":{"max_experiments":4,"wall_seconds":900,"max_tokens":220000,"compute_process_seconds":700,"training_steps":560,"cpu_threads":1,"device":"cpu"}}
```

## Durable 恢复

阶段指纹、候选与各级凭证都写入原账本。Proxy 保存后允许重新计算尚未提交的决策。晋级提交后，重启重新核对决策，只运行尚未授权的阶段。若 Worker 已获授权却缺少完整阶段凭证，保持待核对并保留预留，即使磁盘已有部分输出。剪枝凭证重开后仍为剪枝，相同候选不重新筛选。已有完整最佳可独立交付。

## 验收命令

```powershell
npm run build:offline
npm run check
node --test --test-name-pattern 'MF-062-01|MF-062-02' tests/axiom/multi-fidelity.test.mjs
node --test --test-name-pattern 'MF-062-04' tests/axiom/multi-fidelity.test.mjs
npm run test:ml
```

Windows 离线构建和静态检查通过，三项定向测试通过。全量 ML 重跑 **94/94**，其中 Python 18、Node 59、Pi Session 17 项，无跳过，保留原有 89 项回归。

| Case ID | 验收点 |
| --- | --- |
| MF-062-01 | 样本不足、阈值同分、排序与 Full 上限，高保真选优拒绝 Proxy |
| MF-062-02 | 默认学习率与显式覆盖的审批区间 |
| MF-062-03 | 隔离固定候选池对照与误剪枝审计，拒绝晋级字段覆盖 |
| MF-062-04 | Proxy 和晋级的跨进程恢复，Full 授权不明时保留预留并停止 |
| MF-062-05 | 分级步数用尽、Full 名额用尽、重启后不重做剪枝候选 |

Windows 定向故障任务 `private/wp04-MCVBGK/` 先在 Proxy 凭证提交后强制退出，恢复后未重复 Smoke 或 Proxy。又在晋级决策提交后退出，恢复只执行首轮待执行的 Full。第二轮 Full 的授权提交后再次退出，下一次恢复保持 `needs_reconciliation` 并保留 80 步，交付第一轮已核验最佳。命令序号和预算在再次打开后保持一致。

## 固定候选池 CPU 对照

Windows 全量重跑中，直接全训任务为 `private/wp04-xOCZBa/`，多保真任务为 `private/wp04-4J2Em9/`。两组按相同次序提交四个候选，基础指纹逐项一致。训练配置的固定种子为 42，使用同一数据、规则和 accuracy 目标。两组都审批了四个提案、四个候选 Full 名额、560 步训练和 700 秒子进程预算。直接全训结果在两组运行结束后才加入剪枝审计。

| 指标 | 直接全训 | 多保真 |
| --- | ---: | ---: |
| L0 启动数 / 子进程秒 | 5 / 2.06 | 5 / 2.07 |
| L1 启动数 / 步数 / 子进程秒 | 0 / 0 / 0 | 4 / 8 / 64.89 |
| L2 启动数 / 步数 / 子进程秒 | 0 / 0 / 0 | 4 / 80 / 64.00 |
| L3 启动数（含基线） / 步数 / 子进程秒 | 5 / 400 / 85.07 | 3 / 240 / 52.72 |
| 候选 Full 次数 / 剪枝数 | 4 / 0 | 2 / 2 |
| 总训练步 / 样本更新量 | 400 / 409,600 | 328 / 266,368 |
| 总子进程秒 / 任务墙钟秒 | 87.13 / 88.22 | 183.68 / 185.53 |
| 最佳 Full accuracy / loss | 0.998046875 / 0.006302 | 0.998046875 / 0.006302 |

| 候选 | Proxy accuracy | Multi-Fidelity 决定 | 直接全训 accuracy |
| --- | ---: | --- | ---: |
| Tanh，学习率 0.08 | 0.994140625 | 晋级 | 0.998046875 |
| ReLU，学习率 0.05 | 0.99609375 | 晋级 | 0.998046875 |
| Tanh，学习率 0.003 | 0.349609375 | 剪枝 | 0.83984375 |
| 线性对照，学习率 0.03 | 0.728515625 | 剪枝 | 0.5 |

两组最佳权重 SHA-256 均为 `d8ba57c46f0ae27a07095aeab29b7179aacafd3d6a170a892aac1c9a6611e064`，本组没有错剪与最佳同分的候选。慢学习率候选被 Proxy 显著低估，说明筛选会对收敛速度敏感。剪枝避免 160 个 Full 步，扣除 88 个分级步骤后净省 72 步（18%），样本更新量减少约 35.0%。两次 Windows 对照的候选决策、分数和权重哈希一致。首轮墙钟为 87.37 / 161.19 秒（`wp04-qb2GXD` / `wp04-aITwQY`），重跑墙钟为 88.22 / 185.53 秒。短任务的独立启动与核验开销超过训练节省。证据见两组任务的 `experiments.json`、`commands/` 和各阶段 `runs/`。

## 真实模型反馈闭环

Windows 原生 RPC 使用隔离配置的 `deepseek/deepseek-flash`，关闭供应商自动重试。任务 `private/wp04-tjgib3/` 的基线 accuracy 为 0.5，loss 为 0.692906。提示只要求按工具反馈逐个自主提出三个候选，由模型选择网络和学习率。

| 候选 | 模型提出的假设与所引用反馈 | Proxy accuracy / loss | 宿主决策 | Full accuracy / loss |
| --- | --- | --- | --- | --- |
| `exp-1` | 线性基线接近随机，改用单层 8 单元 Tanh，继承学习率 0.03 | 0.96484375 / 0.337504 | 前两个 Proxy 保守晋级 | 0.998046875 / 0.013158 |
| `exp-2` | 引用首轮 Proxy 和 Full 分数，增加到两层 16 单元 ReLU，学习率 0.05，尝试降低 loss | 0.994140625 / 0.015251 | 保守晋级 | 0.998046875 / 0.005981 |
| `exp-3` | 观察到第二轮 Proxy 和 loss 改善但 Full accuracy 同分，结合其容量与首轮 Tanh，用 0.03 | 0.9921875 / 0.022367 | 落后参考分 0.001953125，处于保守区间，晋级 | 0.998046875 / 0.010852 |

本轮没有剪枝。历史最早的同分候选 `exp-1` 被交付，独立重载后 accuracy 和权重 SHA-256 `3e9a3e4c44895243b5611c77f259d103d35a52f5eee5a8274fa219078b1d3b3b` 一致。总预留 386 训练步，子进程耗时合计 160.71 秒。Pi 观察到 **5 次**请求、**23,513 Token**，Pi 估算 **USD 0.004361304**。请求和用量证据在 `private/wp062-live-1nQVcU/usage.json`。独立复验使用 `python examples/tiny-ml-eval/validate_only.py --run private/wp04-tjgib3/best`。

## 当前限制

生产分级适配器当前覆盖单机 Tiny CPU，实测平台为 Windows。顺序筛选对候选顺序与早期收敛速度敏感，同一固定池的单种子结果不足以推断其他任务的质量或耗时。较长任务是否具有端到端时间收益仍待实际对照。阶段执行后若缺少已提交的完整凭证，需要人工核对已执行的外部操作。

# WP-05 · Pi Durable 与 Tiny CPU 恢复

## 已验证的运行时边界

AXIOM 使用仓库固定版本的 Pi Durable 与 Node SQLite。原生 Pi CLI 继续提供交互、工具和模型调用。WP-05.1 验证了 Durable 任务重启和单写者保护，WP-05.2 通过 Durable 的原子文档提交保存实验账本，使用原生扩展命令恢复。原 Pi 会话 ID 作为审批证据随任务保存。

| 文件 | 职责 |
| --- | --- |
| `runtime.sqlite` | Pi Durable 存储。Tiny CPU 的领域账本与检查点写入单一版本化文档。 |
| `owner.sqlite` | 进程所有权。打开运行时前通过独立 SQLite 写锁取得独占权，运行时关闭后释放。进程被强制终止时，操作系统释放文件锁。 |
| `summary.json`、`experiments.json`、命令日志与训练产物 | 由运行生成的审计资料。恢复以 SQLite 账本为权威，并按该账本核验外部证据。 |

锁采用本地文件系统语义。同一目录的使用方都需通过 [AXIOM 运行时入口](../axiom/durable/task-runtime.ts)。本次测试验证单机进程崩溃恢复。

## WP-05.1 运行时探针

```powershell
node --test tests/axiom/durable-runtime.test.mjs
```

测试进程创建任务，写入预留 82 步的执行意图，触发一个可观测的文件写入，然后等待。竞争进程尝试打开同一目录时收到占用错误。测试强制终止原进程，随后在新进程用相同任务 ID 打开 SQLite。Pi Durable 重新调度任务，探针遇到旧执行意图后返回 `needs_reconciliation`，保留原步骤预留。文件写入以独占创建方式模拟重复调用，测试证实恢复分支没有再次触发该操作。

这条回归会由 `npm run test:ml` 自动发现。探针使用模拟外部副作用，未训练模型，也未调用模型 API。测试中使用任务的原生数字 ID，后续用户命令接收字符串 ID 时须先校验和转换。

本轮离线构建与 `npm run check` 通过。`npm run test:ml` 共通过 75 项，包括 18 项 Python、41 项 Node 和 16 项 Pi Session 集成测试。

## WP-05.2 的事务与恢复边界

1. Task ID 为私有工作目录名，Run ID 为 `baseline` 或 `exp-N`，操作以任务内的 Python 命令序号或模型请求序号标识。首次审批、TaskSpec、绝对截止时间、预算、实验状态、评估证据和交付记录均保存在 [实验账本](../axiom/durable/experiment-ledger.ts)。
2. [实验控制器](../packages/coding-agent/src/axiom/execution/task-controller.ts) 在实际请求或 Python 子进程前提交执行意图及相应预留。Python 操作记录超时上限，训练前同时持久化候选次数和步骤预留。确认结果后提交实际耗时、Token usage、退出状态或独立评估及产物摘要。SQLite 提交与外部执行之间仍存在崩溃窗口。
3. 恢复先取得本地所有权，再核对可信输入、候选源码、固定配置、命令记录、训练历史、权重、评分和交付副本。已提交且可核验的候选进入已有结构缓存；没有启动意图的候选可在原预算内继续执行。存在意图但缺少确认时进入 `needs_reconciliation` 并保留预留。产物损坏会返回完整性错误，现有权重或日志文件不能替代独立 validation。
4. Pi Durable 可以重启台账中的任务，原生工具也可声明安全重放。本实现只提交文档事务，训练和模型请求从未注册为这些可重放任务。模型请求由经典 Pi Session 发送，扩展在原生上下文钩子记录预算，并要求 `retry.provider.maxRetries: 0` 以避免传输层不经账本自动重试。用量和计费状态以 Pi 可观察的数据为限。

## WP-05.2 真实 Tiny CPU 跨进程验收

~~~powershell
npm run build:offline
npm run check
node --test tests/axiom/task-recovery.test.mjs tests/axiom/durable-runtime.test.mjs tests/axiom/extension-loader.test.mjs tests/axiom/launch-axiom.test.mjs
npm run test:ml
~~~

离线构建与静态检查通过。定向的 Durable、跨进程恢复和 CLI/RPC 用例通过，完整 `npm run test:ml` 共通过 79 项，包括 18 项 Python、44 项 Node 和 17 项 Pi Session 测试，无跳过。

测试使用人工固定候选和测试 Token 记录，Python 训练、独立评估和交付重载实际执行。没有付费模型请求。子进程完成基线和首轮训练及账本提交后向父进程报告同步点，父进程确认并发接管被拒绝，再强制结束子进程。第二个进程使用同一 Task ID 恢复。

| 观测点 | 恢复前 | 恢复后与最终状态 |
| --- | --- | --- |
| 任务、截止时间及规则 | 原任务 ID、原截止时间与用户批准的 TaskSpec | 同一 ID、同一截止时间、规则和预算沿用 |
| 实际 Python 训练启动 | `baseline`、`exp-1` | `exp-2` 为结构缓存命中，只新增训练 `exp-3`。原命令文件哈希不变 |
| 候选次数与训练步骤 | 1 次、162 步 | 恢复时不变，最终 2 次、244 步。再次恢复仍为预算耗尽 |
| Token | 1 次测试请求、123 Token，已结算 | 恢复及交付均为 123 Token，未增加请求 |
| 独立 validation 与交付 | 基线 accuracy 0.5，首轮 `exp-1` 为 0.998046875 | 较弱的 `exp-3` 未替换历史最佳。交付权重和独立重载的 Checkpoint 哈希一致 |

本地合成证据任务为 `wp04-GYxX8I`。训练启动分别写入命令 002、005、009，分别对应 `baseline`、`exp-1`、`exp-3`。缓存请求只写入审查命令 007。完整多轮共产生 10 条 Python 命令记录，终态为 `experiment_budget_exhausted`。独立复验只访问 validation。交付权重与独立重载记录的 SHA-256 均为 `3e9a3e4c44895243b5611c77f259d103d35a52f5eee5a8274fa219078b1d3b3b`。SQLite 文件、日志和模型权重留在本地忽略目录。

另验证了两类未确认操作。第一类是模型请求用量未结算，恢复仍保留 1,500 Token 预留，状态为 `needs_reconciliation`。第二类是 Python 已写出权重但账本未确认退出，恢复保留 80 步，既不承认该权重为合法基线，也不重新启动训练。修改已交付权重后尝试恢复会报证据损坏。

原生入口为 `/axiom-task-resume <任务 ID>`，任务 ID 取自原工作目录名。恢复命令本身只读取和核验证据。同一仓库和 Python 不变时可在新的 Pi 会话使用。正常退出或显式取消保持终态。旧任务没有 SQLite 账本则无法通过此命令恢复。该阶段覆盖同一机器的任务进程重启，训练步级续训、主机掉电、未知操作人工对账入口、GPU 作业和真实模型跨进程恢复均单独验收。

使用编译后的 CLI 执行 `node packages/coding-agent/dist/bundle/cli.js --offline --mode rpc --no-session --no-extensions -e axiom/extensions/axiom-tiny.ts`，通过 RPC `prompt` 执行 `/axiom-task-resume wp04-GYxX8I`，收到原终态 `budget_exhausted (experiment_budget_exhausted)`。另通过原生 Pi Session 的 faux provider 回归验证活跃任务恢复、恢复命令本身零模型请求以及传输重试配置不合规时的拒绝。

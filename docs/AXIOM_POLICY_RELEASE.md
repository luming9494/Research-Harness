# WP-09.2 · 策略晋升、留出评测与回滚

## 职责与数据边界

模型通过 WP-09.1 原生 Pi RPC 提出合法呈现变更。宿主冻结候选 ID、完整策略、父及基线 SHA-256、Case 和输入资产摘要。`development` 与 `holdout` 分别生成独立计划、计划计数及运行收据。`gate` 重新执行原独立 Benchmark 判题并核验实际任务账本中的策略摘要，`publish` 再做同样的复核。提案 RPC 无文件、Shell 或发布工具，策略字段也不会获得此类权限。

本轮 `T3-CTX-02` 作为开发集，`T3-REL-01` 作为新的公开可复验留出条件。后者使用浅层 Tanh 起点、学习率范围 `[0.02, 0.06]`、质量阈值 `0.98`。两组各自固定模型 `deepseek/deepseek-flash`、CPU 数据、批准预算、恢复同步点和两轴评分协议。任务 Goal 与允许范围供实验 Agent 工作。宿主独立评分及留出反馈不进入提案模型。冻结后完成开发复核才开始留出。`evolution/intake` 拒收 `split=holdout`。这里的隔离建立在 CLI、时间顺序和工具边界上，持有本地源码的操作者可以复验 Case。

## 发布门槛 v1

- `rejected` 表示已复核的任务失败、Harness 违规、重复执行、恢复失败或关键错误与修订退化。即使传统双轴仍通过，恢复时缺少已归档 AST 错误的具体原因仍构成回归。
- `inconclusive` 表示缺样本、证据不可用、批准基线未通过、两阶段之一的输入节省不足 5%，或该阶段的 Pi 估算费用高于基线。费用与 Token 分别判断。
- `eligible` 要求开发和留出各自至少两次匹配运行，双轴、权限、预算、修订与恢复全部合格，两个阶段均达到输入与成本门槛。这是进入发布的资格，小样本仅作描述性判断。
- `published` 需要把候选、独立收据摘要和审批一起提交到操作者明确选定的注册表。`rolled_back` 切回上一验收版本并保留历史。已执行的任务继续使用 Durable 保存的原策略。

## 操作者命令

```powershell
$source = 'private/axiom-evolution-wp091/eba3b4a5-812d-4838-8315-84f342cfcd86'
$sourceSha = (Get-FileHash "$source/result.json").Hash.ToLowerInvariant()
$root = 'private/axiom-wp092-compare'
node --conditions=source --experimental-strip-types axiom/release/evaluate-cli.ts --root $root --source $source --sha $sourceSha
$planSha = (Get-FileHash "$root/plan.json").Hash.ToLowerInvariant()
node --conditions=source --experimental-strip-types axiom/release/evaluate-cli.ts --root $root --sha $planSha --stage development
node --conditions=source --experimental-strip-types axiom/release/evaluate-cli.ts --root $root --sha $planSha --stage holdout
node --conditions=source --experimental-strip-types axiom/release/cli.ts gate --root $root --sha $planSha
```

两次重复的轮换为 `baseline → A → B`、`A → B → baseline`。`--repetitions 3` 追加以 B 起始的第三轮。更换 Bench 代码、资产或构建产物后应重新冻结并执行两阶段，旧成绩保留。源结果和计划摘要应从可信操作者记录取得。

`publish --root <dir> --sha <plan-sha> --candidate <id>` 默认仅预演。真正发布需额外指定 `--registry <sqlite> --apply`。应用侧通过 `AXIOM_POLICY_REGISTRY` 指向批准库，新任务才按当前指针加载。`AXIOM_CONTEXT=enhanced` 仍由宿主控制，策略发布本身不会开启增强工具。当前运行及恢复继续依据原账本。

`rollback --registry <sqlite> --expected <active-sha> --reason <说明> --apply` 为人工回滚。`monitor --registry <sqlite> --evidence <case-run-directory> --sha <manifest-sha> --apply` 为受控自动判定。后者重算可信 Case 和实际策略绑定，核实回归后原子回滚。默认预演。启动时检测到活动策略内容损坏也会触发 SQLite 内自动回滚。整个数据库不可读时，单个新任务可回退内置批准版并报错提示，该情况没有可写数据库供追加审计。

WP-10.1 后 Monitor 同时输出 `status` 与 `reasons`。`healthy` 要求独立评分和运行证据完整，`regressed` 表示已证实的退化，`inconclusive` 表示超时、中断、环境失败或证据不足。自动判定仅在 `regressed` 且明确指定 `--apply` 时触发回滚。归档校验失败时仍返回非零退出码。

SQLite 事务同时保存历史策略、Active/Previous 指针与事件。比较并切换使用预期 Active 摘要，旧部署的证据不能回滚已经替换的指针。失败或进程中断会回退未提交事务。当前由操作者或受信调度器调用监控 CLI，未安装常驻监控或生产发布服务。

## 重复对照结果

冻结计划 SHA-256 `306b393ef7a22b5bbb3591d181e43f6ec5096d97908635b681d1996d84bd8363`。原始收据和完整均值、范围保存在 `private/axiom-wp092-compare/release-report.json`。开发和留出各计划并执行 6 次，合计 12 次。每个组的 Task Success、Harness Correctness 和恢复均为 **2/2**。每个 Run 使用新任务和新 Pi Session，已核对 12 个独立任务及实际绑定。

| 阶段 / 策略 | 输入 Token 均值（范围） | 总 Token 均值（范围） | 请求合计 | Pi 估算 USD 合计 | Worker 秒均值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 开发 / 基线 | 19,413.5（17,341–21,486） | 20,640（18,693–22,587） | 13 | 0.012672468 | 58.28 |
| 开发 / A | 20,368.5（19,297–21,440） | 21,374.5（20,189–22,560） | 13 | 0.012716268 | 59.66 |
| 开发 / B | 16,857.5（14,899–18,816） | 17,932（15,957–19,907） | 11 | 0.011075124 | 62.70 |
| 留出 / 基线 | 21,561（21,538–21,584） | 22,668（22,508–22,828） | 14 | 0.013410744 | 68.99 |
| 留出 / A | 16,386（15,221–17,551） | 17,369（16,164–18,574） | 11 | 0.010572624 | 75.92 |
| 留出 / B | 21,198（21,152–21,244） | 22,284.5（22,096–22,473） | 14 | 0.013143744 | 77.82 |

A 为 `inconclusive`。其开发输入增加约 **4.9%**，费用也略增。B 为 `inconclusive`。其开发输入减少约 **13.2%**，留出输入只减少 **1.7%**，低于预设 5%。对 B 执行带 `--apply` 的隔离拒绝试验时，发布入口返回失败，目标注册表文件未创建。真实 A/B 均未发布。以上小样本不能支撑显著性或稳定性能结论。

## 负反馈修订与机制验收

预登记呈现退化夹具把 `error_detail` 设为 `category`。真实开发 Run `c1440307-908f-4bb0-bb05-31838146cc2d` 的恢复回执缺少 AST 拒绝原因，发布附加门槛识别 `recovered_error_reason`。两次提案的真实请求均保留。首次恢复为与批准版等价的配置，被通用候选去重拒绝。第二次在单独的修订实验仍提出最小修复 `category → reason`，作为夹具修复重新评测。Run `6b82b9dc-a4da-4945-be21-ec4a515c9160` 中原因恢复可见，两个真实评测的输入分别为 21,281、15,121 Token。夹具与修订的真实运行费用及两次提案独立计入本轮开销，夹具不作为真实 A/B 候选。

隔离测试库完成 `published → rolled_back`。Windows `REL-092-04` 的 Durable 任务 `wp04-mr74b2` 绑定原摘要 `e55abc24…9164d8`，发布后新任务 `wp04-rfmlAj` 绑定演练策略 `f8f5bb9a…55033`。两任务在提交后被强制退出，各自恢复为原身份。损坏 Active 内容触发回滚，下一任务 `wp04-t0mYth` 绑定内置版。其余回归覆盖事务中断、未核验发布、恶意日志、人工回滚和旧回滚请求拒绝。

另以隔离演练库登记确定性通过夹具，通过正式 `monitor` 入口回放上述真实负例。只读预演记录同一原因。执行获准的 `--apply` 后，审计记录从 `bbe6907e…7dd67` 切回 `e55abc24…9164d8`，触发证据 Manifest SHA-256 为 `6d3c8c8ccfb4669459281c9db3e1c3bd7292614bf61259bb9065e8ffcf694a7c`。快照重新打开后验证了回滚状态。演练分数不计入候选收益。

两阶段策略对照消耗 76 次请求、231,569 输入 Token、244,536 总 Token，Pi 估算 USD `0.073590972`。负例与修订链含首次被去重拒绝的提案，消耗 14 次请求、37,837 输入 Token、40,209 总 Token，Pi 估算 USD `0.012353532`。本轮合计 **90 次请求、269,406 输入 Token、284,745 总 Token、Pi 估算 USD 0.085944504**。

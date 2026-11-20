# WP-09.1 · 证据驱动的 Harness 策略进化

## 运行与信任边界

`axiom/evolution/cli.ts` 将已经归档的失败、两轮模型提案和固定开发评测串起来。运行目录含 `plan.json`、`failure-evidence.json`、`baseline.json`、`candidates/<id>/proposal.json`、`policy.json`、`evaluation.json` 和最终 `result.json`。注册和评测分开写入，原记录通过独占创建保护。同一候选的修订产生新 ID 与版本，父摘要留在注册记录中。

操作者提供源 Benchmark 目录和从可信运行取得的 Manifest SHA-256。入口只接受已完成的真实开发 Case，复用 `attributeArchive` 重算原评分及归因，再核验 Worker 审查回执的退出状态、账本身份和摘要。模型只能看到固定症状、Case/Run/Failure/Event ID、策略身份及回执摘要。原始日志、未经证实的根因和留出集答案不会进入提案。首版仅接受已证实的 Tiny XOR AST 拒绝；其他根因保留未知。

提案通过无工具的原生 Pi RPC 发出，使用固定 `deepseek/deepseek-flash`，每次新建 Session，关闭重试、自动压缩与缓存预热。每轮最多两次提案尝试，每次设置 768 输出 Token 上限和 90 秒时限。输出为单个 JSON 对象，字段为 `settings`、`hypothesis`、`target_metrics`。目标枚举是 `input_tokens`、`repair`、`error_visibility`、`recovery`、`task_success`。`settings` 仅可改 `prompt`、`window_tokens`、`priorities`、`feedback`、`experience_limit`、`error_detail`。宿主沿用 WP-08.2 完整 Schema，生成策略身份、基线和父摘要。理由是审计数据。策略写入只对本轮新的任务进程生效，已有任务从 Durable 账本读取原身份。

## 开发评测和筛选协议 v1

固定开发 Case `T3-CTX-02`，每组使用相同的 DeepSeek Flash、初始模型、训练和验证集、CPU 后端、TaskSpec、两轴评分与硬预算。上限为 120,000 Token、244 步、两次合法候选、300 秒 Worker 预算和 600 秒任务墙钟。每轮候选独立归档，复用 `verifyRun` 重算评分并核对实际绑定及运行环境。后续提案根据上一轮的独立评分、实际输入、错误可见性、修订和恢复反馈生成。

`rejected` 表示独立证据显示 Harness 违规、重复训练、任务失败或错误反馈、修订、恢复出现退化。缺少可靠评分、匹配环境、可核验回执或足够重复数时为 `inconclusive`。`eligible` 要求至少两次匹配运行无退化，汇总输入 Token 较基线至少减少 5%，并具备完整成本和计算证据。工件和总开销保留供复核。一次观察不能确认稳定收益。

```powershell
npm run build:offline
npm run bench:axiom -- --case T3-CTX-02 --out private/axiom-evolution-baseline
node --conditions=source --experimental-strip-types axiom/evolution/cli.ts --evidence private/axiom-bench-wp082/0516b2ac-77a7-46bc-9ce8-b8fbb946fd73/T3-GOV-01 --evidence-sha256 4153b865aa51e89212df4bd14097d0e59e13bf576b4ff7dc6c0ee2c0f58b315b --baseline private/axiom-evolution-baseline/46498c6a-f579-4145-a85f-5b1b6d85e065/T3-CTX-02 --out private/axiom-evolution-wp091
npm run bench:axiom -- --verify <case-run-directory>
node --conditions=source --experimental-strip-types --test tests/axiom/evolution.test.mjs
```

省略 `--baseline` 可让同一进程新建基线。`--repeats 2` 对每组执行两次。开发评测使用可信本地 Tiny CPU。WSL2 的固定容器执行独立验收。[Docker 验收记录](AXIOM_SANDBOX_OBSERVABILITY.md)

## 真实结果

归档 `private/axiom-evolution-wp091/eba3b4a5-812d-4838-8315-84f342cfcd86`。源 Failure ID 为 `78d1d1ca-3aff-42b3-b166-94828803224f:operation/4/end/failure/invalid_candidate`。基线和两轮模型策略各完成 1 次独立开发评测。

| 策略 | Run ID | 双轴评分 | 输入 / 总 Token | 请求数 | Pi 估算 USD | Worker / 墙钟秒 | 筛选 |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| 批准基线 | `201b389c-9a4b-46b7-8f25-7b4f13d0e26d` | 100 / 100 | 31,082 / 32,371 | 9 | 0.009479016 | 87.43 / 120.13 | 对照 |
| A | `53cd9e8f-6eed-4a27-ba75-9be565b4719c` | 100 / 100 | 19,205 / 20,202 | 6 | 0.006092364 | 81.81 / 108.81 | `inconclusive` |
| B | `16d2b98b-f7e3-45a6-ab44-32ee88c69ab4` | 100 / 100 | 26,897 / 28,214 | 8 | 0.008370012 | 81.31 / 108.93 | `inconclusive` |

三组的 AST 错误均可见且可执行修订，均成功跨进程恢复，启动 3 次真实训练、重复 0 次，最终独立 validation accuracy 均为 `0.998046875`。

**A。** 候选 `03303f19-42aa-4543-ab47-ea2950c6cf21`，SHA-256 `b40ac65e6279f94019de52fcb5ba5a8f578c63e7dfb6efa4543309b8bb4a221c`。模型将窗口从 1,600 改为 1,400，经验检索上限从 8 改为 6，将 recent/artifacts/experience/operations 优先级从 `40/30/20/10` 调成 `45/35/15/5`。本次 A 输入较基线减少 38.2%。一轮结果只能说明这个运行通过，无法确认稳定性或独立区分各字段贡献。

**反馈后 B。** 反馈包含 A 的 Run ID、结果摘要 `7106209545e049d3b912b63f34243fae5726fbbcf0b31cca0bf26d34a805a593`、19,205 输入 Token、修订和恢复证据。模型在第二轮借此提出进一步压缩假设。候选 `3014b0e3-f43f-4c91-8b7e-9f1dc5949661`，SHA-256 `5d71d7852cca4d8c7f83abfaa7c96260e32d1db4430a3d888097e456e13f76ae`。B 保留结构化反馈与 reason 级错误，启用 `evidence_first`，窗口改为 1,200，经验上限改为 4，优先级改为 `40/35/20/5`。实测 B 输入较基线少 13.5%，较 A 多 40.1%。再缩小窗口没有在该次运行中带来进一步下降。三组未配置经验归档，经验上限的独立作用未得到验证。

两轮提案共有 2 次调用，使用 2,541 Token，Pi 估算 USD `0.000872772`。连同开发评测共 **25 次真实请求、79,435 输入 Token、83,328 总 Token、Pi 估算 USD 0.024814164**。两个真实候选均待定，原因是 `insufficient_repetitions`。真实候选没有命中拒绝规则。确定性回归实际拒绝了越权配置、独立评分器修改、额外配额、重复训练、错误反馈退化、提前结束及恢复退化。测试夹具的判定不计入上表。

## 当前限制

仅覆盖一次匹配运行的 Tiny XOR 开发 Case，故意注入的 AST 错误用于验证修订行为，无法推断真实任务中的自然错误频率。这里同时调整了多个字段，模型行为和请求数有随机性。独立留出验证、正式发布和回滚属于后续阶段。

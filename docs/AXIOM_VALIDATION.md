# AXIOM 验收：WP-04、原生基座与真实 LLM 记录

## WP-06.2 分级评估验收

真实 DeepSeek Flash 经原生 Pi RPC 依次提出三个不同候选，并在第二、三轮引用此前的 Proxy 和 Full 反馈。三个候选均晋级，最终交付首个达到 0.998046875 Full accuracy 的候选，交付权重独立重载一致。Pi 记录 5 次请求、23,513 Token、估算费用 USD 0.004361304。固定候选池对照与故障回归单独运行。[WP-06.2 多保真验收记录](AXIOM_MULTI_FIDELITY.md)

固定池对照的两次运行均剪掉两个候选，候选 Full 次数从 4 降为 2，训练步数从 400 降为 328，最佳 Full accuracy 和权重哈希一致。Windows 重跑的墙钟从 88.22 秒增至 185.53 秒。跨进程用例确认已提交的 Proxy 与晋级记录可复用，第二轮 Full 授权不明时保留 80 步并停止。[对照和恢复证据](AXIOM_MULTI_FIDELITY.md)

Windows 上离线构建、静态检查、分级定向测试和全量 ML **94/94** 通过。真实模型验收与离线回归分别记账。

## WP-06.1 真实模型验收

原生 Pi CLI/RPC 以单候选、162 训练步和 60,000 Token 准入预算运行 `deepseek/deepseek-flash`，供应商自动重试关闭。模型按顺序调用 inspect、baseline、candidate，自行提出 8 单元 ReLU 隐层和审批范围内的 `learning_rate=0.05`。基线准确率 0.5，候选独立 validation 准确率 **0.998046875**，loss **0.004902488552033901**。达到候选上限后交付 `exp-1`，重新加载 `best/` 复验相同指标及权重 SHA-256 `3a2e1066e1780cdfd01afcce2155312def1eaa447fa30999b232d45217d53374`。

Pi 记录 **3 次**模型请求、**5,812 Token**、估计费用 **USD 0.00138156**，费用来源为 Pi 模型目录估算。两项改动同时发生，准确率增益不能单独归因于学习率。实验产物和用量证据分别保存在本地 `private/wp04-9blH21/`、`private/wp061-live-lO490A/usage.json`。固定候选学习率对照、合成第二适配器与原生故障注入分别验收。[WP-06.1 内核及用例](AXIOM_EXPERIMENT_ENGINE.md)

Windows 离线构建、静态检查及全量 ML **89/89** 通过。固定模型的学习率对照单独运行并复验两组指标。Pi Session 回归使用 faux provider，本段真实模型请求独立记录。Linux 运行待验收。

## WP-05 验收索引

本文保留 WP-04 及此前的真实 LLM 验收记录。后续 [WP-05.2 恢复验收](AXIOM_WP05_RUNTIME.md) 用人工固定候选和真实 Python 训练、独立评估验证了 Tiny CPU 任务跨进程恢复。测试 Token 为固定数据，未新增收费 API 调用。

WP-05.3 在同一基线上增加进程生命周期、事务失败、冻结终态、交付中断和产物损坏故障用例。稳定 Case ID、触发方式和验收结果见 [WP-05.3 故障用例记录](AXIOM_WP05_RUNTIME.md#故障用例记录)。

Windows 离线构建与静态检查通过，Durable 定向测试 9/9、全量 ML 回归 84/84。真实 CPU 训练完成一次参数更新后强制终止 AXIOM，Python 退出，重新打开账本保留 80 步预留且未重复训练。Linux 运行尚未验收，模型请求用量使用测试数据。

## 当前结论与边界

WP-04 的可信 Tiny CPU 多轮领域内核已从本地旧工程迁入，并接入固定 Pi 1.5.0。原生 Agent Loop 负责多轮 Tool Calling，AXIOM 程序负责预算、受控训练、独立验证、历史最佳与停止；没有另建 Session、聊天界面或模型调用框架。

**两阶段真实 LLM Tiny CPU 主流程已通过；不等于完整产品或所有故障分支验收。** 第一阶段完成自主单候选、真实训练/独立 validation 和达限交付。第二阶段在全新会话中完成两个自主候选：0.5 的 Baseline，经首轮 0.998046875 后，模型读取真实反馈再提出第二轮，达到 1.0 并交付历史最佳 `exp-2`；两候选上限后自动停止，独立重载与哈希一致。第二阶段为 4 次原生模型请求、10218 Token，Pi 估计费用 USD 0.001963764。首次 649 Token 的失败记录仍保留，历史人工/faux 测试不冒充真实模型结果。第二轮较差/平分/失败的回退仅有离线覆盖，未在这次真实轨迹出现。未升级 Pi、未新增依赖、未进入 WP-05。

## 启动与凭据隔离（无收费调用）

新增 `scripts/launch-axiom.mjs`；根 npm 命令 `axiom`、`axiom:login`、`axiom:logout` 均通过它启动仓库构建的原生 Pi CLI，不改 Agent Loop、AuthStorage、SessionManager、模型供应商或训练执行器。

- 开发工具 `pi` 仍使用默认 `%USERPROFILE%\.pi\agent`；启动器不修改全局安装、环境变量或凭据文件。
- Research-Harness 固定使用仓库外 `%LOCALAPPDATA%\Research-Harness\agent`；凭据为该目录的 `auth.json`，模型/用户设置和 `sessions/` 同样独立。仅修改 spawn 子进程环境，并覆盖继承的会话目录变量，避免意外沿用开发工具的会话路径。
- `npm run axiom` 默认 regular TUI，使用 `-ne -e` 只显式加载审核过的 AXIOM 入口。`npm run axiom:login` / `axiom:logout` 分别透传原生 `auth login deepseek --api-key` / `auth logout deepseek`，不加载实验扩展；没有新实现凭据存储/加密或模型请求。
- 不把 Key 写进命令、调试日志或仓库；不复制开发 Pi 的 Key。供应商环境凭据仍遵循 Pi 原生优先级，配置目录隔离不是环境/OS 沙箱。用户显式传入其他 session 路径也能改变原生会话选择，不能将这种主动覆盖称为隔离保证。
- 未构建、缺少扩展、缺失/相对 `LOCALAPPDATA`、配置目录落在仓库或被链接回仓库/全局配置时拒绝启动。脚本本身缺失时 Node 会给出含脚本路径的 `MODULE_NOT_FOUND`，应恢复脚本而非使用旧直连命令。
- Ctrl+C 由共享前台终端传给原生 Pi；启动器不重复发送，等待其退出并传递退出码。程序收到 SIGTERM 时转发给子进程。真实终端键盘/视觉及带真实 Key 的交互登录尚未做人工验收。

离线验证 `tests/axiom/launch-axiom.test.mjs`：独立目录/固定 cwd/参数与退出码透传、原生 AuthStorage 的假凭据保存及删除、开发凭据哨兵不变、其他供应商路由、缺构建/脚本/扩展和不安全路径错误，以及真实编译 CLI 经启动器离线 RPC 枚举 AXIOM 命令。假 CLI 仅用于证明参数路由；假 Key 不是真实供应商凭据，不把它当作真实交互登录验收。真实编译 CLI 另验证了临时隔离目录中的原生 logout，以及非交互 login 明确拒绝输入（不会提交真实 Key）。

本轮实际结果：`npm run build:offline` 完整 monorepo 离线构建通过；`npm run check` 通过；`npm run test:ml` **72/72** 通过、无跳过（Python 18、Node 40、Pi Session 14），保留原 63 项并新增上述 9 项。全局 `pi --version` 与 `npm run axiom -- --offline --version` 均为 **1.5.0**。没有修改全局 Pi 安装或配置，也没有执行真实收费验收。

启动与登录方法见 [README](../README.md#开发-pi-与-research-harness-的配置隔离)。凭据不是训练产物，不存进 `private/`；原有训练产物路径不变。本轮不调用收费模型 API。

## WP-04 真实 LLM 验收方案（2026-11-06；执行前准备记录）

本节记录首次执行前的准备与预算；“未调用”只描述准备时点。用户起初只批准第一阶段，后来授权同类 Tiny 直接执行并明确要求开始第二阶段；历次实际结果分别记录。不能将最初的模型状态/命令枚举检查解释为工具已正确暴露。

### 稳定版本与本次检查

- WP-04 内核已有本地提交 `49cde0d`；启动/认证隔离已本地提交为 `f3b7dc6`。没有推送。提交前工作区仅有隔离改动，明确暂存六个相关文件；`git diff --check` 通过。`private/`、`.venv/` 被忽略，未将本机凭据、环境文件或权重纳入提交；仓库既存的测试 fixture 不属于本机认证文件。
- 既有 72 项回归与 79 项 Agent 回归是此前结果，本次准备未重新运行完整回归。没有修改领域内核、Agent Loop、供应商实现、依赖或旧工程，不进入 WP-05。
- 本次仅检查隔离认证的 provider/type/是否存在 Key，不输出 Key；确认存在 DeepSeek API Key，未复制开发 Pi 凭据。检查时没有继承 `DEEPSEEK_API_KEY`，没有项目 `.pi/settings.json` 覆盖。
- 通过真实构建 CLI 的离线 `get_state` / `get_commands` 确认：`deepseek/deepseek-flash`、`https://api.deepseek.com`、输出上限 2048、thinking off，四个 AXIOM 命令均可用；没有提交自然语言推理 prompt。离线元数据检查不是供应商连接、额度有效性、Tool Calling 或自主优化验收。
- 只读取了官方公开文档，包括 [价格 Markdown](https://api-docs.deepseek.com/quick_start/pricing.md)，未请求鉴权接口或付费推理。当前公开名称 `deepseek-flash` 对应 DeepSeek-V4.1-Flash-1017。旧工程 `docs/WP02_VALIDATION.md` 记录同一官方 provider/model 的真实 Tool Calling，但不能代替本仓库迁移后的验收，也不能保证供应商别名背后的版本始终不变。

### 固定原生模型配置，不新增模型调用框架

仅在仓库外 `%LOCALAPPDATA%\Research-Harness\agent` 新建了原本不存在的两个原生配置文件，未修改 `auth.json`、全局 Pi 或项目配置：

- `settings.json`：`defaultProvider: deepseek`、`defaultModel: deepseek-flash`、`defaultThinkingLevel: off`、`enabledModels: [deepseek/deepseek-flash]`；`retry.enabled: false`、`retry.maxRetries: 0`、`retry.provider.maxRetries: 0`、`retry.provider.timeoutMs: 60000`；`cacheWarming: off`、`compaction.enabled: false`。
- `models.json`：只设置 `providers.deepseek.modelOverrides.deepseek-flash.maxTokens: 2048`，不添加 Key、端点、供应商或模型实现。Pi 原生模型覆盖已通过离线列表与 RPC state 验证；底层仍使用原有 `openai-completions`，原生 `maxTokens` 经 `buildBaseOptions` 写入请求的 `max_tokens`，不是 AXIOM 的估算余量代替输出上限。真实供应商返回/截断行为待验收。

执行时仍显式指定物理模型，不使用虚拟 router，不启用 NIM、Pro、OpenRouter 或其他供应商回退。内置目录中仍列有其他模型；`enabledModels` 不是安全隔离或删除这些模型。由固定启动参数、唯一审核扩展、无自动重试以及轨迹核对限定本次执行；出现鉴权、模型不可用、截断、网络错误或未知 usage 即停止，不自动换模型、补跑或提高预算。

**修正后的真实验收启动模板：** 原模板错误使用了 `--no-tools`，同时过滤动态领域工具；现改为 `--no-builtin-tools`，只禁用默认普通工具，保留扩展动态注册能力。每阶段使用全新 Session，不使用 `--continue` / `--resume`，也不加载历史人工候选、测试、参考实现或本验收文档：

```powershell
npm run axiom -- --offline --provider deepseek --model deepseek-flash --models deepseek/deepseek-flash --thinking off --no-builtin-tools --no-skills --no-prompt-templates --no-context-files --no-themes -na
```

新增免费 SDK/faux 回归确认审批前工具为空、审批后恰好四个领域工具、provider 上下文中含四个 Schema 且可原生执行 inspect、停止后恢复为空。扩展另在启动时检查实际激活工具；若被原生 allowlist 过滤，关闭任务并报出修正参数，不再发送“Task ready”。仅枚举 slash 命令不够。原生 TaskSpec 确认与工具门禁保留，没有重写 Agent Loop、供应商或领域内核。

`--offline` 仅禁止原生目录/更新等联网刷新，**不禁止模型推理，也不是免费运行开关**。启动器已有 `-ne -e`，只加载审核入口。`-na` 忽略需要项目信任批准的本地配置/资源；显式 `-e` 仍加载。隔离目录检查时没有 `SYSTEM.md` / `APPEND_SYSTEM.md`；执行前仍需复查，不能仅凭 `--no-context-files` 声称禁用了所有系统提示来源。这些选项是减少无关上下文和参考泄漏，不是 OS 沙箱。

可用原生 `--mode rpc` 记录事件并响应原生确认对话框；这只是 CLI 控制，不包装模型请求。准备阶段仅离线检查了状态与命令枚举；首次真实尝试随后通过了原生 TaskSpec 确认，但没有通过工具暴露与执行验收。自动 TUI 测试应按 `.pi/skills/interactive-testing.md` 使用 tmux；本机未发现 tmux，因此不能把 RPC 检查说成已通过键盘/视觉 TUI 验收。

### 两阶段实验与预算

两阶段相互独立，各重新运行 Baseline；均为单线程可信 Tiny CPU、固定 80 epochs，只允许 `model.py`，不改 config，不使用额外数据/预训练/网络，不使用 final-test。`target_accuracy: null` 避免提前达标掩盖两轮路径。

| 项目 | 第一阶段：单候选闭环 | 第二阶段：反馈驱动多轮 |
| --- | --- | --- |
| 候选训练启动上限 | 1 | 2 |
| 墙钟主动截止 | 180 秒 | 300 秒 |
| 原生 Token 准入预算 | 50,000 | 100,000 |
| 累计受控进程耗时 | 90 秒 | 150 秒 |
| 训练步骤预留 | 162 = 80 + 82 | 244 = 80 + 82 + 82 |
| 单次输出上限 / thinking | 2048 / off | 2048 / off |
| 预计原生模型请求 | 3–5 次 | 4–7 次 |
| 请求次数观察停止线，非硬门禁 | 第 6 次尝试 | 第 8 次尝试 |
| 预计输入 / 输出 Token | 6k–15k / 1k–3k | 12k–30k / 2k–5k |
| 按峰时、全部输入 cache miss 的预计费用 | USD 0.003–0.0081 | USD 0.006–0.015 |
| 金额观察停止线，非账单硬限 | USD 0.10 | USD 0.20 |

理想情况下每次响应只调用一个工具：第一阶段为 inspect → baseline → candidate，共 3 次模型请求；第二阶段增加读取首轮结果后生成 candidate，共 4 次。Schema 错误、空转、额外 inspect 或响应截断可能改变请求数，不能保证实际恰为 3/4 次。候选预算按实际训练启动计数，不是工具调用次数；AST 相同只复用，不算新的训练。测试要求新的合法架构，cache hit 不冒充真实候选训练；出现重复/多余提案则停止并如实记录，不静默增加验收轮数。

费用以 2026-11-06 官方公开峰时价估算：Flash 每百万输入 cache miss USD 0.30、cache hit USD 0.006、输出 USD 1.20；不依赖非峰折扣。两阶段预计合计 USD 0.009–0.0231，建议按 USD 0.03 的量级理解，并分别保留 USD 0.10 / 0.20 的操作余量。价格可能变化；Pi `usage.cost` 是估算，非供应商账单核对。

**金额/请求停止线不是硬上限。** 当前只有模型请求计数，没有 `max_model_requests` 的请求前硬门禁；`budget.model_requests` 计原生准入尝试，不等于经供应商确认的 HTTP/计费次数。达到观察线后通过原生取消与 `/axiom-task-stop` 停止；外部 RPC 观察、人工反应和 abort 有延迟，不能保证拦住紧邻的下一次网络发送，也不能撤销已发生的收费。Token 是估算准入、实际结算后阻止后续，不能保证绝对账单上限。若批准条件要求“绝不超过 N 次 HTTP 请求或 USD X”，当前准备不满足，不得开始；需另行批准最小请求前计数门禁或供应商侧确有保证的额度机制，不能靠 prompt 冒充硬限。本轮未增加此功能。

第一阶段完整 TaskSpec：

```text
/axiom-task {"version":1,"task":"tiny-xor-v1","goal":"Autonomously improve validation accuracy within the approved CPU budget","target_accuracy":null,"rules":{"pretrained_weights":false,"extra_data":false,"network":false,"editable":"model.py","evaluation":"validation"},"budget":{"max_experiments":1,"wall_seconds":180,"max_tokens":50000,"compute_process_seconds":90,"training_steps":162,"cpu_threads":1,"device":"cpu"}}
```

第二阶段完整 TaskSpec：

```text
/axiom-task {"version":1,"task":"tiny-xor-v1","goal":"Use independent validation feedback to choose successive candidates and deliver history best","target_accuracy":null,"rules":{"pretrained_weights":false,"extra_data":false,"network":false,"editable":"model.py","evaluation":"validation"},"budget":{"max_experiments":2,"wall_seconds":300,"max_tokens":100000,"compute_process_seconds":150,"training_steps":244,"cpu_threads":1,"device":"cpu"}}
```

阶段 prompt 不提供网络结构、层数、激活函数选择或历史实现，只要求：先 inspect 并等待结果，再 baseline 并等待独立 validation，随后在允许规则内自主提交完整候选和理由；每次 assistant 响应最多一个工具调用。第二阶段额外要求在收到首轮结果后的下一次模型请求中，引用真实 accuracy/loss 说明第二轮选择理由，再提出新的合法候选。第二轮不要求提升；不要轮询、改配置、读参考实现或自报指标。

“每轮一个工具”和“依据反馈”是验收要求，不是程序硬门禁。必须检查原生消息顺序：若候选与 baseline、或两个候选在同一 assistant 消息中预先生成，虽然 Pi 顺序执行工具，也不能宣称模型已读取前一结果并据此决策。保留真实轨迹，将反馈驱动项判为未通过，不人工替模型补源代码或理由。

**第一阶段的停止语义：** 第一个真实候选完成后即达到候选上限，Controller 自动取消 Agent turn。模型已读取的独立指标是 Baseline；候选指标由工具、程序与验收人读取。不会为让模型再解读一次候选指标而追加付费总结请求。第二阶段才覆盖模型读取第一候选独立指标后生成下一候选；第二个候选完成后同样不再调用模型作总结。

### 调用链、硬停止与验收判定

审查范围为 `axiom-task.ts`、TaskSpec/Budget/Controller/Executor 以及原有取消边界：

1. 用户确认 TaskSpec 后创建领域 Controller，不创建或替换 Pi Session。Pi 负责原生 Schema、Tool Calling 与 sequential 工具调度；任务中只开放四个工具，其他工具由 `tool_call` 拦截。
2. `context_with_system` 在 provider 前预留 Token；原有 Agent Loop 补丁检查已 aborted signal。`message_end` 记真实 usage；错误/中止保留部分消耗并标记不确定，禁止后续请求，不用工具次数冒充 Token。
3. Baseline 必须先完成；每个候选经 AST 审查/指纹去重后才原子预留候选次数与步骤，固定 CPU worker 做 Smoke/full，另进程独立 validation。候选工具同步等待，无 LLM 轮询。
4. 候选上限是确定性停止：第一阶段完成 1 次、第二阶段完成 2 次真实候选后关闭准入、abort 原生 Agent turn，不再总结、不启动下一训练。墙钟有主动 timer；进程 timeout 不超过剩余墙钟/累计进程预算；步骤在启动前预留。不保证 OS 取消零延迟，也不把累计进程耗时称作精确 CPU 用量。
5. 停止、错误或用户取消立即关闭排队准入，取消当前进程；只校验和复制已有独立证据、保留历史最佳。`/axiom-task-stop` 等待清理；若原生取消失效才强制终止受控进程树，并将该次验收记为异常，不能称作正常交付成功。
6. 最佳由独立 full validation 的严格 accuracy 改善决定；相同分保留既有最佳。第二轮更差也必须交付历史最佳，最终权重/源码/config/validation 哈希一致；没有合法 Baseline 就报告失败而非伪造权重。

第一阶段必须看到由本次真实 provider assistant 工具参数自主生成的候选、一次真实 Smoke/full、独立 validation 和可重载交付。流程闭环通过与指标提升分别报告；未提升可证明正确保留 Baseline，但不能宣称自主优化效果成功。

第二阶段只有在第一阶段证据完整、usage 可结算且获得第二阶段批准后执行。检查首轮反馈确实进入下一模型请求；若模型提前 finish、只提交重复架构或异常停止，保留产物并标为未覆盖完整两轮，不为了凑成功而人工修改候选。若实际第二轮更优，应交付第二轮；若更差/平分，应交付先前最佳。不能预设两轮的准确率或强迫模型故意变差。真实轨迹未出现的故障/较差候选路径仍仅由既有离线测试证明，不能升级为联网已覆盖。

### 批准后才保存的真实证据

每阶段保留独立原生 Session 与对应 `private/wp04-<id>/`，用验收索引关联；不混入此前人工 CPU 校准目录：

- 原生 Session 原文件保存在隔离目录 `sessions/`；将本次副本、原生 RPC 事件/工具参数与结果、assistant 原文、usage 保存为本地私有验收证据。若使用 TUI，则保留 Session 和终端记录；只有画面不够证明完整 Tool Calling。
- 保存脱敏启动参数、Pi 版本/提交、配置白名单摘要、TaskSpec/批准范围、模型 ID/官方 endpoint/output cap，以及请求尝试、已结算 usage、不确定 usage 的区别。禁止保存 auth.json、Authorization 头、Key 或完整继承环境。
- 领域目录已有 `sources/*/{model.py,config.json,proposal.json,patch.diff}`、`runs/` 真实训练历史/权重/独立 validation、`commands/*.json` 的 stdout/stderr/退出状态、`events.jsonl`、`summary.json`、`experiments.json`、`report.md`、最终 `patch.diff` / `best_model.pt` / `best/`。
- 停止后观察原生 settled/取消事件，核对最后的模型 usage 与命令时间线，不再用自然语言追问启动新模型请求；不得仅依据 `model_requests` 断言实际 HTTP 次数；区分停止后返回的在途中止结果、provider 前拒绝产生的 aborted 消息与真正的新请求。检查没有停止后的训练启动，真实 Token 总量与原生消息一致，保留错误/中止的未知账单风险。
- 每阶段最多额外执行一次人工固定 `validate_only.py --run <workspace>/best`，只重载独立验证、不训练、不调参，不访问 final-test；这是停止后的验收步骤，单独记录，不能冒充 Controller 在预算内新执行的工作。
- 公开文档只写脱敏结论、是否自主提出/改进/基于反馈、实际次数/usage/估计费用与未覆盖项；私有轨迹、权重、Key、研究数据均不提交。

**授权演进：** 准备时未批准收费执行；用户先以“是，我接受”批准第一阶段，随后明确要求修复后直接付费重跑，同类 Tiny Task 此后不必逐次申请、大任务再申请。当前常设授权范围见下方重跑记录；这不取消程序预算、原生 TaskSpec 确认或供应商固定要求。

## WP-04 真实第一阶段首次尝试（2026-11-06；历史失败）

用户批准后，通过仓库编译的原生 Pi CLI/RPC 启动全新 Session，显式固定官方 `deepseek/deepseek-flash`、2048 输出上限、thinking off；没有供应商回退、真实模型补跑、第二阶段或额外总结请求。控制脚本只发送原生 RPC 命令、响应已经获批的 TaskSpec 确认并记录事件，没有实现模型请求或凭据框架。候选提示不提供结构/实现，不加载历史会话、测试或参考实现。

| 实际观察项 | 结果 |
| --- | --- |
| 原生已准入请求 / 已结算 assistant 响应 | 1 / 1；不是供应商 HTTP 计费审计 |
| 原生输入 / 输出 / 缓存 Token | 627 / 22 / 0 |
| 原生 totalTokens | 649；Session stats 与领域账本一致 |
| Pi 估计费用 | USD 0.0002145；`totalFromProvider: false`，非账单核对 |
| 原生 Tool Call / tool_execution_start | 0 / 0 |
| Baseline / 候选 / Smoke/full / 独立 validation | 均未执行 |
| 训练步骤预留 / 累计受控进程耗时 | 0 / 0 |
| 最佳权重 / Diff / 外部重载 | 无；没有合法交付，因此未启动 Python 重载 |
| 任务终态 | `cancelled` / `user_cancelled`，由控制端执行停止命令清理 |
| 原生 CLI 退出码 / 专属 auth.json | 0 / 文件内容未改变；进程成功退出不代表验收通过 |

### 失败原因与准备阶段遗漏

原生 Session 的系统上下文为 `<tools> (none)`，没有四个 AXIOM 工具声明。模型输出了类似 `<axiom_task_inspect>` 的普通文本，assistant content 中没有 `toolCall`，也没有任何原生工具执行事件。不能把这段文字解释成 inspect 已执行，更不能声称训练、独立验证或自主优化通过。

问题在本次助手准备的启动参数，不是现有证据证明 DeepSeek 不支持工具调用：CLI `--no-tools` 映射 SDK `noTools: "all"`；`sdk.ts` 在没有显式工具列表时生成空 `allowedToolNames`，`AgentSession._isAllowedTool` / `_refreshToolRegistry` 因而过滤所有新注册的领域工具。扩展的 `pi.setActiveTools(names)` 只能激活仍在 registry 中的工具，无法绕过该过滤。这是原生参数语义，不应通过重写 Agent Loop 或移除权限门禁解决。

准备检查只验证了 `get_state` 和 `get_commands`，没有检查审批后的实际可调用工具与 Schema，这是此次无效收费请求本可避免的遗漏。修复时先免费验证原生工具选择参数及回归，再依据用户后续授权重跑；不能只改 prompt 要求模型“真的调用工具”，也不能将未执行视为零费用。

本次模型 turn 自然结束后，控制端执行原生 abort 和 `/axiom-task-stop` 关闭任务。因此 `user_cancelled` 不是用户实际键盘取消、预算超限、候选上限自动停止或训练进程取消的联网实测；这些路径仍只有此前离线证据。

### 本地证据与未覆盖项

- 原生事件、Session 副本、完整输入/批准范围、状态、usage/stats、执行原始结果和独立审计：`private/wp04-live-stage1-ARTJNb/`，验收判定为其中 `acceptance.json` 的 `failed`，不能以 `execution-result.json` 的进程退出码判成功。
- 领域 TaskSpec、usage 事件、summary 与确定性失败报告：`private/wp04-CwxAUv/`。没有命令日志、源码候选、训练或权重，不伪造这些证据。
- 本次 13 个文本证据文件检查未包含专属 Key；认证文件未复制入证据目录。证据目录被 Git 忽略，未提交私有会话/日志、Key 或权重；未提交或推送本轮文档。
- 本次只证明真实官方文本响应、原生认证/usage 记账和 RPC 确认/关闭链路；不证明真实 Tool Calling、模型自主架构、反馈决策、指标改善、历史最佳交付、预算超限停止、外部重载或视觉/键盘 TUI。
- 首次失败当时未修改产品源码、测试或配置，也未重跑完整回归；当时没有继续付费。后续修复与新授权下的重跑单独记录如下。

## WP-04 修复与真实第一阶段重跑（2026-11-06；通过）

### 修复与免费回归

只修正验收启动参数，并在 `axiom/extensions/axiom-task.ts` 添加四工具激活检查：原生过滤导致工具缺失时立即关闭 Controller、恢复 prior tools、清除截止 timer，报告 `--no-builtin-tools` 用法。没有移除原生工具 allowlist、TaskSpec 确认或执行门禁；没有改 Agent Loop、模型请求、训练/选优算法、依赖或全局 Pi 配置。

`packages/coding-agent/test/suite/axiom-task.test.ts` 新增两项实际 SDK 回归：旧 `--no-tools` 在任务启动阶段被拒绝、provider 调用为 0、usage 为 0；修正参数下检查四个声明的名字与候选 JSON Schema，faux 原生 inspect 调用成功，停止后工具恢复为空。首次测试误以为 slash handler 错误会向 `session.prompt` 抛出；现按 Pi 原生 `extensionRunner.onError` 接收并断言错误，不修改原生错误语义。

实际执行 `npm run build:offline`、`npm run check` 与最终完整 `npm run test:ml` 均通过。ML 回归 **74/74**，无跳过：Python 18、Node 40、Pi Session 16。包含新增两项；早先测试断言失败已修正并完整重跑，不把那次失败结果算通过。

### 真实来源、训练与交付

按第一阶段原预算启动新的原生 CLI/RPC Session；模型只拿到本次 prompt、固定工具/规则、原始 Baseline 与 config、实际工具结果，没有加载旧候选、历史会话、测试或参考实现。候选代码与理由逐字匹配本次真实 assistant `toolCall` 参数，不是助手在外部代写。

真实调用顺序为 inspect → 等待结果 → baseline → 等待独立 validation → candidate，每条 assistant 消息只有一次工具调用。模型在第三次请求中引用了 Baseline 的 accuracy 0.5000 / loss 0.6929，随后自主选择 `2 → 8 → 2`、Tanh 的 42 参数网络。该结构不主张新颖性；即使与人工校准结构相同，本次来源仍是独立原生调用轨迹，不能据相同结构反推读取过参考。

| 实际观察项 | 重跑结果 |
| --- | --- |
| 模型 / endpoint | 官方 `deepseek/deepseek-flash` / `https://api.deepseek.com` |
| 原生已准入请求 / assistant 响应 / Tool Call | 3 / 3 / 3，无总结请求、回退或额外重试 |
| 输入 / 缓存读取 / 输出 / 总 Token | 2246 / 2816 / 465 / **5527**；三方账本一致 |
| Pi 估计费用 | **USD 0.001248696**；非供应商账单核对 |
| Baseline 独立 validation | accuracy **0.5**，loss **0.6929060816764832** |
| 自主候选独立 validation | accuracy **0.998046875**，loss **0.013157988898456097** |
| 真实训练 | Baseline 80 epochs，候选 Smoke 2 + full 80 epochs；共预留 162 步 |
| 固定受控命令 | 6 个，全部成功；累计进程耗时约 **22.06 秒** |
| 任务墙钟 | 约 **27.45 秒**，低于 180 秒 |
| 自动停止 | `budget_exhausted` / `experiment_budget_exhausted`，1 次候选后停止 |
| 最终交付 | `exp-1`，源码/config/Diff/权重/独立证据齐全 |
| 外部独立重载 | 固定 `validate_only.py` 仅执行一次，退出 0；accuracy 与 checkpoint SHA-256 一致 |
| final-test / 供应商回退 / 第二阶段 | 均未使用或执行 |

领域 `task_stopped` 后没有新的进程启动或 usage 事件；原生 Session 总共三条 assistant 消息，不追加模型解读或轮询。停止后控制端仅关闭任务与保存证据，再单独执行一次固定只读重载验证，不把验收重载算进 Controller 训练预算。

重跑证据为 `private/wp04-live-stage1-hiXbmy/`（原生事件/Session、输入/授权/启动参数、修复 Diff、usage、外部重载、`acceptance.json`、`evidence-audit.json`）；真实训练/交付为 `private/wp04-J0LqWP/`。独立审计核对模型参数与落盘源码、Baseline 结果与后续候选的消息顺序、80/2/80 的执行记录，以及最终权重、来源权重和外部重载的 checkpoint 哈希。51 个文本证据文件检查未包含专属 Key，auth.json 文件内容未改变，私有轨迹/权重不提交。

首次失败与本次重跑合计观察到 4 个官方 assistant 响应、6176 Token，Pi 估计费用 USD **0.001463196**；首次失败没有被隐藏或归零。以上计数不是供应商侧 HTTP/账单审计。

### 当前授权与验收边界

用户已明确授权：修复后直接付费重跑，同等可信 Tiny Task 后续不逐次申请，大任务再申请。当前按固定官方 DeepSeek Flash、本地单线程 CPU、本文已经说明的 Tiny 预算及小额风险范围执行；不把授权扩展到新供应商/回退、更大数据/成本、任意仓库或远程 GPU。超出此范围先确认，不因常设授权关闭预算和证据门禁；原生 TaskSpec 确认仍保留，控制端可依据已有授权响应。

**第一阶段重跑只证明单候选闭环。** 模型不在达到上限后再分析候选结果；后续两轮反馈驱动的证据来自下方独立的第二阶段，不追溯增加第一阶段的覆盖范围。仍不宣称视觉/键盘 TUI、绝对请求/账单硬限、跨会话恢复、OS 沙箱、泛化性能或统计成功率。

## WP-04 真实第二阶段（2026-11-06；主流程通过）

用户明确要求“开始第二阶段”。采用已说明的第二阶段 TaskSpec：最多 2 次候选训练、300 秒墙钟、100000 Token 准入、150 秒累计受控进程耗时、244 步预留、CPU 单线程、`target_accuracy: null`。固定官方 DeepSeek Flash、thinking off、单次输出 2048，保持原生认证/Session/Tool Calling，无供应商回退或辅助总结请求。

### 自主反馈链与效果

新建原生 Session 和新的领域目录，重新训练 Baseline，不加载第一阶段对话、候选或参考实现；执行控制端只复用无架构提示的启动参数/TaskSpec 结构，不将旧结果发给模型。模型只通过本次四个领域工具接触任务和实际证据。

```text
请求 1：inspect → 等待规则、原始模型/config
请求 2：baseline → 等待真实训练与独立 validation
请求 3：candidate(exp-1) → 等待 Smoke/full 与独立 validation
请求 4：读取首轮 accuracy/loss 后，candidate(exp-2)
         → 等待独立 validation → 候选预算耗尽、程序交付并停止
```

每条 assistant 消息恰好一个原生 Tool Call。第二轮提案是在第一轮 toolResult 之后的另一条 assistant 消息中产生；其原始理由引用首轮 accuracy 0.998 / loss 0.0132，并提出改变激活函数和增加宽度的假设。两份候选源码及理由逐字匹配真实模型 Tool Call 参数，AST 指纹不同，均非 cache hit；没有人为替模型写候选或预先指定架构。

| 独立 full validation，512 样本 | 模型结构 | 参数量 | Accuracy | Loss |
| --- | --- | --- | --- | --- |
| Baseline | 原始线性模型 | 6 | 0.5 | 0.6929060816764832 |
| exp-1 | `2 → 8 → 2`，Tanh | 42 | 0.998046875 | 0.013157988898456097 |
| exp-2 | `2 → 32 → 2`，ReLU | 162 | **1.0** | **0.0033222108613699675** |

程序按独立 validation accuracy 的严格改善规则交付 `exp-2`，不是因为它恰好是最后一轮或模型自报最好。外部固定 `validate_only.py` 只额外执行一次，退出 0，重载 accuracy/loss 与候选独立验证一致；交付权重、`best/` 权重、`runs/exp-2/` 权重及重载证据的 checkpoint SHA-256 一致。交付源码、config、validation 哈希及可信输入也核对通过。

### 实际预算与停止

| 项目 | 第二阶段实际值 |
| --- | --- |
| 原生已准入请求 / assistant 响应 / 工具调用 | **4 / 4 / 4** |
| 输入 / 缓存读取 / 输出 / 总 Token | **3291 / 6144 / 783 / 10218** |
| Pi 估计费用 | **USD 0.001963764**，非供应商账单核对 |
| Baseline / 两候选训练 | 80 / (2 + 80) / (2 + 80) epochs，共预留 **244** 步 |
| 固定受控命令 | **9** 个，全部退出 0、无取消/超时 |
| 累计受控进程耗时 | 约 **33.43 秒**，低于 150 秒 |
| 任务墙钟 | 约 **44.97 秒**，低于 300 秒；不含停止后的人工重载 |
| 自动终态 | `budget_exhausted` / `experiment_budget_exhausted`，正常达到两候选上限 |
| 最终历史最佳 | **exp-2**，validation accuracy **1.0** |
| 未使用 | final-test、额外数据、预训练、GPU、供应商回退 |

原生消息 usage、Session stats、领域 `native_pi_usage` 和总账一致，usage 不确定标记为 false。`task_stopped` 后领域日志没有新的进程启动或 usage；第二次候选结果之后没有新的 assistant 消息、第三个候选或模型总结。停止后的外部重载是单独验收步骤，不属于 Controller 继续执行，也不混入训练预算。

### 证据、审计和边界

- 原生会话副本/事件、完整 prompt/授权/TaskSpec、配置白名单摘要、修复源码 Diff、usage、独立重载和原始运行结果：`private/wp04-live-stage2-yZ5uW5/`。最终判定以独立审计的 `acceptance.json` 为准；`execution-result.json` 中保留审计前的 provisional 状态，不事后改写原始记录。
- 真实源码/Diff、训练与 Smoke 历史、命令 stdout/stderr、独立 validation、程序报告及最终 `best_model.pt` / `best/`：`private/wp04-y9oU91/`。
- 独立审计检查了原生提案与保存源码一致、Baseline 反馈在首轮前、首轮独立反馈在第二轮前、第二轮理由引用实际指标、不同 AST、80/2/80/2/80 的真实执行、9 个固定命令成功、严格选优、达限后无新增领域工作、交付哈希、原始 config/可信输入未变。
- 专属 auth.json 内容未改变；67 个文本证据文件检查未包含专属 Key。凭据文件未复制入产物，私有日志/会话/权重均不提交。
- 连同首次失败和第一阶段重跑，三个实际会话共观察到 **8** 个官方 assistant 响应、**16394 Token**，Pi 估计费用合计 **USD 0.003426960**；不是供应商 HTTP 次数审计或实付账单证明。
- **本次第二轮更优。** 没有真实触发“第二轮较差、平分或失败仍保留首轮”的分支；不能用此次结果证明那些回退分支已经联网验收。它们仍依赖此前确定性领域与真实 CPU/faux 集成覆盖，不额外放宽两候选预算去凑故障结果。
- 结论仅为一个合成 Tiny Task、固定 seed 的反馈驱动流程通过；1.0 是这 512 个 validation 样本的准确率，不代表 final-test、泛化性能、架构新颖性或统计成功率。视觉/键盘 TUI、绝对请求/账单硬限、完整会话替换、跨会话恢复、OS 沙箱等仍未验收。

本轮未修改产品源码、测试或配置，未重跑构建/完整回归；74 项免费回归与构建/静态检查是上一轮修复后的结果。本轮只执行已批准的真实第二阶段及一次固定外部重载，然后对保存的证据作免费审计并更新本文档。未提交或推送 Git，未进入 WP-05。

## WP-04 实现范围与实际文件

旧源码实际位于 `D:\graduate_student\AXIOM\AXIOM`，已检查其 TaskSpec/Budget/Executor/Controller、旧 Agent/decision 包装及对应单元/CPU 测试。旧工程未修改。迁移与适配范围：

| 文件 | 实际职责 |
| --- | --- |
| `packages/coding-agent/src/axiom/execution/task-spec.ts` | 用户审批的严格完整 TaskSpec；禁止增加字段、放宽网络/数据/权重/编辑范围或使用 final-test |
| 同目录 `task-budget.ts` | 原子训练准入；候选次数、单调墙钟、步骤预留、累计子进程耗时；Token 请求前估算预留与请求后实际结算 |
| 同目录 `task-executor.ts` | 复用原受控进程；AST 结构和配置/可信输入联合指纹；Smoke/full 固定 worker、独立 validation、来源快照和交付完整性 |
| 同目录 `task-controller.ts` | 原生工具驱动的串行实验状态机；缓存、严格改进/平分保留、历史最佳、失败/取消回退、立即关闭后续准入、自动停止和确定性报告 |
| `examples/tiny-ml-eval/experiment.py` | 从旧工程迁入的固定可信审查及 Smoke/full 训练 worker；仍由 `validate_only.py` 另进程独立评估 |
| `axiom/extensions/axiom-task.ts` | 四个原生工具、用户审批、usage/生命周期桥接；与旧单候选模式互斥，不创建 Pi Session |
| `axiom/extensions/axiom-tiny.ts` | 原有显式入口调用新的桥接，保留单候选命令 |
| `packages/agent/src/agent-loop.ts` | 唯一基础循环改动：上下文/请求钩子取消后，在 provider 发出前检查 signal，返回原生 aborted 结果 |
| `tests/axiom/task-controller.test.mjs` | 确定性领域规则/预算/排队/证据测试，fake executor 不作真实训练证明 |
| `tests/axiom/task-cpu.test.mjs` | 真实 CPU 两轮、AST 去重、历史最佳独立重载和真实墙钟期限 |
| `packages/coding-agent/test/suite/axiom-task.test.ts` | 现有 harness/faux 的审批、工具参数/门禁、原生 usage、准入拒绝和三条真实训练取消路径，以及第二轮故障回退 |

Pi 原生提供 Session、TUI、模型配置、工具 JSON Schema、工具调度、事件、对话/上下文和真实 usage。本轮不迁旧 `task-agent.ts` / `task-decision.ts` 的 Session 工厂、readline、模型/凭据配置、streamFunction 或供应商回退。

## WP-04 程序规则与预算语义

- 默认最多 **2 次候选训练启动**，Baseline 不占候选次数，但计入墙钟、进程耗时和训练步骤。达到次数后立即停止；第三次请求被拒绝，LLM 不负责守住上限。
- 默认墙钟 600 秒，累计子进程耗时 300 秒；墙钟有主动 timer，也限制每个进程 timeout。该累计耗时包含 Python 启动、AST 审查和独立评估，不等于 CPU 核秒或 GPU 用量。
- 固定 80 epochs；Baseline 预留 80 步，候选在启动前预留 2 Smoke + 80 full 共 82 步，默认总预算 244。失败/取消不退已预留步骤；记录名为 `training_steps_reserved`，不是伪造实际完成步数。程序拒绝启动时不先扣候选次数。
- 架构按审查后的 AST 指纹去重，联合固定 config、协议、线程和可信输入身份；仅格式/注释不同也命中缓存。不重新训练/评估、不重复扣上一次真实执行的次数/步骤/耗时；本次 AST 审查的真实启动耗时仍如实计入预算。缓存有单独 `cache_hit/reused_from` 记录。
- 历史最佳只取独立 full validation，512 样本、固定协议、访问记录恰为 validation；只接受严格 accuracy 改进，平分保留先前最佳。第二轮更差或失败都不覆盖第一轮最佳。Baseline 前失败则没有合法权重，报告明确失败，不伪造交付。
- 候选工具内部串行等待完整工作，不让 LLM 轮询。停止立即取消当前子进程并关闭排队准入，再验证/复制既有证据；没有停止后的训练、评估或总结模型请求。
- 达到目标、任一预算、主动停止或执行失败均进入明确终态。重复提案还受 `2 * max_experiments` 提案上限约束，避免缓存空转。
- `summary.json`、`experiments.json`、`events.jsonl`、`report.md`、`trusted-inputs.json`、每轮源码/配置/理由/Diff、命令退出/取消/超时记录均落在 `private/wp04-*/`。合法最佳导出为 `model.py`、`config.json`、`best_model.pt` 及可独立重载的 `best/`；交付核对 checkpoint、源码、配置、元数据和 validation 哈希。

### Token：准入估算与真实消耗不是同一回事

- 在 Pi 原生 `context_with_system`（含系统上下文与工具声明）中估算本次请求余量：UTF-8 JSON 字节数 + 8192 framing + 2048 输出余量。它**不是**真实 tokenizer 计数、供应商 max-output 参数或数学上界。
- 在原生 `message_end` 以 assistant `usage.totalTokens` 结算，含输入/输出/缓存 Token，释放本次预留；`events.jsonl` 保存来源 `Pi message_end`、provider/model、原始 usage、请求序号及准入估算。工具调用次数、模型文字和训练日志均不作为实际 Token。
- 正常请求只结算一次。实际 usage 可能超过估算甚至预算，真实超出部分仍计账，然后停止进一步请求/训练；错误/中止时保留已报告的部分 usage，同时标记结算不确定并保守停止，不能丢弃已有消耗或宣称零费用。
- 暂停任务期间的缓存预热、compaction 和树导航，避免对应辅助模型请求绕过任务计账；用户主动 Shell、其他受信任扩展自发调用及供应商未报告的内部重试/计费不在此保证中。
- **尚无供应商绝对 Token/金额硬上限**。这不妨碍程序对可观察 usage 执行后续准入，但不能把估算说成实际费用保证；此处领域内核回归未调用收费 API。

## WP-04 启动与交付

沿用下方安装/构建命令，进入 `npm run axiom -- --tui-mode regular` 后：

```text
/axiom-task
```

审批后要求 Pi 检查规则、运行 Baseline、根据真实 validation 反馈迭代候选。四个工具为 `axiom_task_inspect`、`axiom_task_baseline`、`axiom_task_candidate`、`axiom_task_finish`。预算/目标触发时自动停止；`/axiom-task-stop` 等待取消并恢复之前的工具。切换 `/axiom-tiny` 前先停止当前模式。

用户可用 `/axiom-task <完整 TaskSpec JSON>` 自定义规则允许范围内的预算，例如：

```json
{"version":1,"task":"tiny-xor-v1","goal":"Improve validation accuracy within approved CPU budgets","target_accuracy":null,"rules":{"pretrained_weights":false,"extra_data":false,"network":false,"editable":"model.py","evaluation":"validation"},"budget":{"max_experiments":2,"wall_seconds":600,"max_tokens":100000,"compute_process_seconds":300,"training_steps":244,"cpu_threads":1,"device":"cpu"}}
```

允许整数范围：候选数 1–3、墙钟 10–1800 秒、Token 1–500000、进程累计耗时 1–1200 秒、步骤预留 1–1000。模型工具不能修改已审批 TaskSpec、训练 config 或 split。

停止后的独立人工重载验证（不是 Controller 继续训练）：

```powershell
.\.venv\Scripts\python.exe examples\tiny-ml-eval\validate_only.py --run private\wp04-<id>\best
```

## WP-04 领域内核离线/CPU 验收（历史）

最终执行完整构建、静态检查与 `npm run test:ml`，保留原 42 项并扩展为 **63 项**：Python 18、Node 31（新增 12 项领域 + 2 项真实 CPU）、Pi Session 14（原 7 + 新 7）。全部通过，无跳过。另定向运行 `packages/agent/test/agent-loop.test.ts` 和 `agent.test.ts`，**79/79** 通过，检查基础取消边界变更的回归。未运行收费 API 或全仓 e2e。

覆盖：两次合法后第三次拒绝；第一优于第二仍交付第一；第二轮真实 worker 失败仍交付第一；AST 相同结构复用；不重复扣训练预算；取消阻止队列；墙钟主动截止；只使用非 final-test 指标；实际 usage 与原生消息总和一致；准入失败 provider 调用次数为零；用量不确定阻止重试。

最终完整回归的真实 CPU 校准示例 `private/wp04-sV58xi/`：Baseline **0.5**，人工 8 隐层 Tanh 候选 **0.998046875**，注释变化候选命中 AST 缓存，第二个独立候选 **0.5**，程序最终仍导出 `exp-1`。两次训练共预留 244 步；外部独立重载 `best/` 指标及哈希一致。该测试没有 LLM 请求，Token 正确记为 0，不把训练当模型用量。另有原生 Session/faux + 真实 CPU 的第二轮故障回退和三种训练取消验收。

未实现/未验证：真实供应商自主提出候选、真实账单/Tokenizer 校准、实际键盘/视觉 TUI、完整 `/reload`/`new`/`resume` 端到端替换、跨会话/重启恢复、POSIX 取消实测、OS 沙箱、任意仓库、远程 GPU、NIM 自动回退。落盘不等于可恢复 Controller；AST 检查不等于 OS 沙箱。

## WP-01～03 历史验收：环境与命令

- Node.js 22.21.0，npm 10.9.4，满足 Node >=22.19.0。
- `npm ci --ignore-scripts` 从既有锁文件安装；未修改 npm 依赖版本/锁文件，未执行安装生命周期脚本。
- Python 3.11.9，`python -m venv .venv` 创建独立环境，不继承全局 site-packages。
- `.venv` 内安装 torch 2.2.0、NumPy 1.26.4。首次安装被命令超时中断导致 Torch 文件不完整；在该虚拟环境重新安装后恢复，不属于训练代码问题。补充固定 NumPy 以避免缺失接口警告和 NumPy 2 不兼容。

```powershell
npm ci --ignore-scripts
npm run build
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r examples\tiny-ml-eval\requirements-cpu.txt
npm run check
npm run test:ml
npm run axiom -- --tui-mode regular
```

已有 `.venv` 时不重复创建。可通过 `AXIOM_PYTHON` 指定受信任 Python 的绝对路径。`test:ml` 要求先构建，不调用真实模型；缺少 Python 时测试入口直接失败，不把跳过训练当作完整通过。

## WP-01～03 历史架构问题与修复

1. **启动耦合**：原 `.pi/extensions/axiom-tiny.ts` 自动发现后立即导入仓库 `dist/`，未构建时会产生扩展加载错误。现迁至 `axiom/extensions/axiom-tiny.ts`，由 `npm run axiom` 显式加载；全局 `pi` 保持开发用途。启动的 Agent 是当前仓库编译出的 Pi，领域 TypeScript 由 Pi 自带加载器加载，未增加第二个聊天终端。
2. **检查配置不兼容**：首次 `npm run build` 已成功，但 `npm run check` 拒绝迁入模块的相对 `.js` 源码导入，并发现格式/模板字面量诊断。现使用 `.ts` 源码导入，由原构建配置转换输出；没有关闭检查或删减业务逻辑。
3. **取消生命周期不完整**：原停止命令仅切换工具。现合并 Pi Tool AbortSignal 与任务级取消信号，在停止和 `session_shutdown` 时中止并等待执行器结束，再恢复之前的工具选择。显式停止还中止当前 Pi Agent turn，避免其继续调用恢复后的普通工具。
4. **Smoke 证据接口错误**：原优化模式返回未注册的 `read_smoke_result` 工具提示；现由 Controller 内部调用既有独立重载路径，直接把真实 Smoke 证据返回原工具。
5. **Smoke 失败无交付出口**：单候选只能改一次、Smoke 只能尝试一次，但失败后原先无法进入结果/决策。现记录候选失败、禁止继续训练，并允许重验和交付合法 Baseline。
6. **产物寻址**：每次扩展工具结果均携带实际工作目录，配合相对 artifact 路径寻址，不让模型猜测文件位置。

Pi 已提供 TUI、Agent Loop、工具调度、JSON Schema 校验、动态注册、Session、模型配置与事件，WP-01～03 阶段均直接复用，未改底层循环；WP-04 新增的唯一取消边界补丁见上方。AXIOM 保留实验级串行化、候选/动作白名单及训练进程封装：这些是固定 ML 工作流规则；Pi 通用 `exec` 不提供本流程要求的最小化子进程环境和同等进程树终止策略，因此没有直接替换受控执行器。AST 检查和环境精简均不构成 OS 安全沙箱。

## WP-01～03 历史执行结果

以下为之前基座验收记录和当时耗时，不代替上方 WP-04 本轮结果。最终连续执行 `npm run build && npm run check && npm run test:ml` 成功：

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 完整 monorepo build | 通过 | 全部既有构建步骤和 Pi CLI bundle |
| 完整 `npm run check` | 通过，无剩余诊断 | Biome、依赖约束、相对导入、入口图、install-lock、两组 TypeScript 和浏览器 smoke 检查 |
| Python unittest | 18/18，通过，约 19 秒 | Baseline/人工参考真实训练、数据切分、Smoke/Proxy、独立重载、哈希/范围篡改、防覆盖、validation-only |
| Node `tests/axiom/*.test.mjs` | 17/17，通过，约 2.8 秒 | 决策/权限、参数与顺序、失败回退、进程取消/超时/输出限制、原生扩展加载及编译后 CLI 离线 RPC |
| Pi Session 集成 `test/suite/axiom-tiny.test.ts` | 7/7，通过，无跳过，约 223 秒（含加载） | 审批、动态注册、原生参数校验、普通工具拦截/恢复、三种取消路径、真实 Smoke 故障后的 Baseline 导出、完整真实训练与 keep |
| `pi --version` / `npm run axiom -- --version` | 均为 1.5.0 | 开发工具和仓库入口版本检查 |

构建保留 Pi 原有公开模型目录抓取步骤；这不是模型推理请求，没有 API 推理费用，也未升级 Pi。`npm run check` 会自动格式化迁入文件，已检查产生的变更范围。

真实训练集成结果：固定线性 Baseline validation accuracy 为 **0.5**，人工 16 隐层 Tanh 候选为 **0.998046875**，确定性规则选择 `keep`。流程只评估 validation；Python 独立测试中的 final-test 检验不向优化控制器反馈。该结果是单种子 Tiny Task 的流程校准，不是 LLM 自主优化成功率或泛化性能证明。

完整集成产物保留在本地忽略的 `private/wp03-*/`，包括 `baseline/`、`smoke/`、`candidate-run/`、`selected/`、`decision.json`、`patch.diff` 和命令日志。故障回退使用真实文件目录冲突使 Python 训练失败，并确认所导出的 Checkpoint 与 Baseline 一致；不是伪造训练结果。

## WP-01～03 历史验证范围

已验证：

- 编译后 Pi CLI 可离线通过 RPC 枚举 AXIOM 命令；原生加载器能加载显式扩展；开发工具不再自动发现 AXIOM。
- 原生 Session 中正确注册九个工具；未审批不启用，工具参数不合法时由 Pi 拒绝，非 AXIOM 工具调用由扩展门禁阻断。
- Baseline、单次候选修改、L0/Smoke、完整训练、独立重载验证、客观 keep/revert 和真实 selected 导出。
- 进程层取消/超时；扩展层 Tool AbortSignal、`/axiom-stop` 和 `session_shutdown` 的取消传递及工具恢复（本机 Windows）。
- ML 状态仍在独立 Controller/工作目录中，开始任务不创建或替换 Pi 对话 Session。

尚未验证或未实现：

- 实际终端 TUI 的键盘操作、确认对话框和视觉呈现，真实供应商 Tool Calling、模型自主提出候选；没有批准就不进行收费调用。
- 整个真实 Pi `/reload`、`/new`、`/resume` 替换流程的 AXIOM 端到端验收；本轮测试的是其 `session_shutdown` 清理钩子。没有实验跨 Session/重启恢复，不应从对话历史推断已恢复任务。
- POSIX 上的本地进程树取消实测、恶意脱离进程树场景、OS 沙箱、远程任务取消。
- 此处历史验收未覆盖 WP-04；本轮新增范围和现存限制见上方 WP-04 章节。NIM 自动回退仍未迁入。

## 后续审批与可靠性工作

启动参数问题已修复，两阶段真实 Tiny 主流程与证据审计通过。两轮中的较差/平分/失败回退仍只有离线覆盖，不将本次成功轨迹外推为所有故障路径、完整产品或泛化性能验收；本轮不进入 WP-05 或扩展 GPU、跨会话恢复、供应商包装。

按用户最新常设授权，同等 Tiny 任务不再逐次申请付费执行；扩大成本、数据、资源或供应商范围的大任务仍先确认。Token 仍是估算准入、实际 usage 结算后阻止后续，不保证绝对账单或 HTTP 请求硬上限。

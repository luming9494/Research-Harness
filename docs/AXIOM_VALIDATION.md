# AXIOM 本地验收：WP-04 与原生基座

## 本轮结论与边界

WP-04 的可信 Tiny CPU 多轮领域内核已从本地旧工程迁入，并接入固定 Pi 1.5.0。原生 Agent Loop 负责多轮 Tool Calling，AXIOM 程序负责预算、受控训练、独立验证、历史最佳与停止；没有另建 Session、聊天界面或模型调用框架。

**这不是完整产品或真实模型自主优化验收。** 所有候选是人工校准输入，Session 使用 Pi 现有 faux provider。CPU 训练、Checkpoint、独立验证和最终交付为真实产物；faux usage 只证明原生记账路径，不代表供应商账单验收。未调用收费模型 API，未升级 Pi，未新增依赖。

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
- **尚无供应商绝对 Token/金额硬上限**。这不妨碍程序对可观察 usage 执行后续准入，但不能把估算说成实际费用保证。本轮不调用收费 API。

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

## WP-04 实际验收

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

WP-04 本地领域内核不再因缺失旧源码而阻塞。下一步是单独批准后的真实 API/TUI 验收，以及任务跨会话/重启恢复协议；不因此扩展远程 GPU 或迁入旧供应商包装。

真实 API/TUI 验收仍作为独立审批项：一个 Tiny Task、一个已配置供应商、明确候选数量和价格风险，无 GPU。先确认可接受的 Token/金额范围；当前请求前为估算准入、请求后为实际 usage 停止，不能保证供应商绝对账单上限，未经批准不执行。

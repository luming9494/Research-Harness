# AXIOM → Research-Harness 迁移记录

> 2026-11-06 · 此文区分**已提交代码**与**已在新工程验证的功能**。  
> 来源：旧公开仓库 [luming9494/AXIOM](https://github.com/luming9494/AXIOM)。目标：完整 Pi 源码仓库 [Research-Harness](https://github.com/luming9494/Research-Harness)。

## 1. 原则

- **新仓库以下载的 Pi 源码为 Git 根**，不再嵌套 vendor/pi submodule；不得将旧 AXIOM 的独立 CLI/SDK 封装复制成另一个 Agent 产品。
- Pi 1.5.0 的模型配置、Session、TUI、Agent Loop、Extensions、Compaction 和 Skills 为主要基础能力。
- AXIOM 仅迁移机器学习业务所需代码：实验约束、受控候选、Python Runner 接口、独立评估、指标与产物。
- 所有未发表研究、真实日志/权重、凭据和本机私有目录严格不进入公开仓库。
- **不可将“代码已复制”与“端到端已验收通过”混为一谈**。

## 2. 已迁入的独立部分（不表示本轮已 Git commit）

| 原 AXIOM 模块 | 新工程路径 | 说明 |
| --- | --- | --- |
| `src/execution/process.ts` | `packages/coding-agent/src/axiom/execution/process.ts` | 进程/输出/超时的受控执行逻辑 |
| `src/execution/smoke-workspace.ts` | `packages/coding-agent/src/axiom/execution/smoke-workspace.ts` | 可信 Tiny Task 私有候选、路径校验、固定训练动作 |
| `src/execution/single-optimize.ts` | `packages/coding-agent/src/axiom/execution/single-optimize.ts` | 单候选训练、独立指标验证、程序决定 keep/revert |
| `src/research.ts` 与 `src/table.ts` | `packages/coding-agent/src/axiom/` | 实验清单和数据表输出 |
| `examples/tiny-ml-*` | 根目录 `examples/tiny-ml-*` | PyTorch 合成任务、评估/审查脚本 |
| `tests/python` / `tests/fixtures` | 根目录对应路径 | Python 回归与合成参考结构 |
| 原 Agent 工具编排 | `axiom/extensions/axiom-tiny.ts` | 由 AXIOM 启动器显式加载的 Pi 原生桥接，避免被开发用 Pi 自动发现 |
| 新版 Node 策略测试 | `tests/axiom/decision.test.mjs` | 单轮决策确定性测试 |
| 本地 `src/execution/task-spec.ts`、`task-budget.ts` | `packages/coding-agent/src/axiom/execution/task-{spec,budget}.ts` | 固定 TaskSpec、原子训练预算准入、原生 usage 结算 |
| 本地 `task-executor.ts`、`task-controller.ts` | `packages/coding-agent/src/axiom/execution/task-{executor,controller}.ts` | 可信 CPU worker、AST 去重、独立验证、历史最佳、串行取消和确定性交付；Controller 改为原生工具驱动，不迁旧 propose/模型循环 |
| 本地 `examples/tiny-ml-eval/experiment.py` | 同名路径 | 固定 AST 审查、Smoke/full 训练 worker，继续用现有 `validate_only.py` 独立评估 |
| 本地 WP-04 测试中的场景 | `tests/axiom/task-{controller,cpu}.test.mjs`、`packages/coding-agent/test/suite/axiom-task.test.ts` | 领域单测、真实 CPU 多轮、原生 Pi/faux 工具及 usage/取消集成 |
| 原 WP-04 Agent 编排 | `axiom/extensions/axiom-task.ts` | 新写 Extension，接现有 Session 与四个领域工具，不复制旧 `task-agent.ts` / `task-decision.ts` |

由于 Pi 的 TypeScript 配置采用 `erasableSyntaxOnly`，迁入的两处构造器参数属性已改写为普通字段初始化。源码相对导入现已统一为 `.ts`，由构建转换为 `.js`，并修复迁入模块的格式与检查诊断。

## 3. 未迁移，不要误判为已经恢复

- WP-04 的旧独立 Agent/模型请求包装：**刻意不迁移**。已迁入多轮 TaskSpec、预算、CPU 执行与历史最佳机制，并通过 Pi 原生 RPC 完成可信 Tiny CPU 的真实模型自主优化主流程验收。
- **NVIDIA NIM** 多轮 Function Calling 与 **NIM → DeepSeek** 供应商回退代码：本地版本尚未推送。本次不重写 Pi 的模型配置/路由。
- 旧 `src/agent/smoke-agent.ts`、`optimize-agent.ts`、`src/cli.ts`、`src/agent.ts` 的 Session 初始化、事件订阅、readline 与供应商封装：**刻意不迁移**，避免重复实现 Pi。
- 原来的 React Web 离线前端：暂缓，不属于新的 CLI 主线。
- 远程 GPU、真正 OS 沙箱、完整 Reproduce/Ablate：仍未实现。

## 4. 新入口的明确能力边界

`/axiom-tiny`：在通过 `npm run axiom` 启动的 Pi 原生会话中，通过人工同意创建受控 Tiny Task，暂时只开放九个 namespaced ML 工具；自动禁用普通 Pi 工具以便不绕过限定的任务动作。

**仍不是 OS 沙箱**：Pi 扩展/用户账号具备本地进程权限，不能用这套 Tiny 安全策略运行来源不明的训练仓库。训练与来源 SHA、AST 策略适用于固定可信任务。

`/axiom-task`：用户审批不可由模型修改的 TaskSpec，仅开放四个多轮 ML 工具。候选同步等待训练，不持续请求模型轮询；按原生 Pi usage 结算 Token。程序执行次数、墙钟、训练步骤与进程累计耗时预算、结构去重和历史最佳交付。请求前 Token 估算不是供应商绝对硬限额。

`/axiom-task-stop`：取消多轮任务、阻止排队下一轮、交付已验证历史最佳，再恢复先前工具。与单候选模式互斥；达到预算或目标后由程序停止，不要求模型主动调用 finish。任务期间暂停自动/手工 compaction、树导航和缓存预热，避免相应辅助请求绕过任务 usage 路径。

`/axiom-stop`：中止当前受控执行器和 Pi Agent turn，等待结束后恢复原工具选择；`session_shutdown` 同样取消待执行/运行中的任务。没有远程 GPU Job 取消能力，也没有跨会话恢复实验控制器的能力。扩展放在自动发现目录以外，仅 `npm run axiom` 显式加载，开发工具 `pi` 不依赖 AXIOM 构建。

## 5. 新仓库本地验收

~~~powershell
npm ci --ignore-scripts
npm run build
npm run check
npm run test:ml
npm run axiom -- --tui-mode regular
~~~

进入原生 Pi：

~~~text
/axiom-tiny
~~~

确认出现 Tiny Task 工作目录，要求 Agent 先读取 model.py 和 baseline，再提交单个方案，训练并交付 `selected/`、`decision.json` 与 `patch.diff`。用系统生成文件作为真实依据，不以 LLM 自述为验收结论。

本地 Windows 已通过构建、静态检查、Python 真实训练、Node 策略和 Pi Session 集成回归，以及编译后 CLI 的离线 RPC 命令发现。离线集成使用 faux provider 与人工候选。随后单独通过原生 RPC 完成两阶段真实 LLM Tiny 主流程验收。终端 TUI 的键盘与视觉交互待验收。测试范围与真实产物说明见 [AXIOM_VALIDATION.md](AXIOM_VALIDATION.md)。

## 6. WP-04 本地源码核对与适配

本轮实际检查了 `D:\graduate_student\AXIOM\AXIOM`，读取其 `src/execution/task-{spec,budget,executor,controller}.ts`、`src/agent/task-{agent,decision}.ts`、WP-04 单元/CPU 集成测试和固定 `experiment.py`。旧目录未删除、未改写；不是根据旧公开 GitHub 或文档臆造功能。

保留独立领域规则：严格 TaskSpec、CPU 预算、AST 架构指纹与配置/可信输入联合去重、独立 validation 选择、历史最佳哈希校验和无模型交付。适配内容：

- 旧同步 `executeTask(propose)` 改成串行 `TaskController.invoke`，由现有 Pi Agent Loop 自然进行多轮工具调用；取消立即关闭准入，再等待当前 worker。
- 原子预留一次完整训练的实验次数和步骤，失败不退预留；拒绝启动时不先消耗实验次数。
- 不迁旧 `piDecision` 的 Session 创建、消息拼装、模型/凭据注册及供应商 fallback。Token 直接接 Pi 上下文事件准入和 `message_end` usage，不以工具次数冒充 Token。
- Pi 原生请求路径增加已取消 signal 的发出前检查，避免扩展取消准入后仍调用 provider；其余 Session/TUI/模型配置不另写。

此迁移阶段使用无费用回归和真实 CPU 校准。后续真实模型验收另见上节。跨会话恢复、远程 GPU 和 NIM 回退仍待实现。

## 7. Source licensing

Pi 上游的 MIT LICENSE 与原作者版权必须保留；新 README 明确指出本项目为 Pi 源码衍生项目。对于没有重新编译和测试的源码，不得标注已验证。

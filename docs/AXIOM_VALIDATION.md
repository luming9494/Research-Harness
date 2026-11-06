# AXIOM 原生基座本地验收

## 结论与边界

本轮在 Windows 本地完成完整构建、静态检查和 42 项无 API 费用回归。Tiny Task 可通过 Pi 原生 Session、工具调用和扩展机制执行真实 CPU 训练、独立验证及模型选择。

**这不是完整产品或真实模型自主优化验收。** 集成测试使用 Pi 现有 faux provider 发出确定性工具调用，候选为人工编写；训练、Checkpoint、独立验证、代码 Diff 和最终文件均为真实程序产物。未调用收费模型 API，没有远程 GPU 或任意仓库支持。

## 环境与命令

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

## 架构问题与修复

1. **启动耦合**：原 `.pi/extensions/axiom-tiny.ts` 自动发现后立即导入仓库 `dist/`，未构建时会产生扩展加载错误。现迁至 `axiom/extensions/axiom-tiny.ts`，由 `npm run axiom` 显式加载；全局 `pi` 保持开发用途。启动的 Agent 是当前仓库编译出的 Pi，领域 TypeScript 由 Pi 自带加载器加载，未增加第二个聊天终端。
2. **检查配置不兼容**：首次 `npm run build` 已成功，但 `npm run check` 拒绝迁入模块的相对 `.js` 源码导入，并发现格式/模板字面量诊断。现使用 `.ts` 源码导入，由原构建配置转换输出；没有关闭检查或删减业务逻辑。
3. **取消生命周期不完整**：原停止命令仅切换工具。现合并 Pi Tool AbortSignal 与任务级取消信号，在停止和 `session_shutdown` 时中止并等待执行器结束，再恢复之前的工具选择。显式停止还中止当前 Pi Agent turn，避免其继续调用恢复后的普通工具。
4. **Smoke 证据接口错误**：原优化模式返回未注册的 `read_smoke_result` 工具提示；现由 Controller 内部调用既有独立重载路径，直接把真实 Smoke 证据返回原工具。
5. **Smoke 失败无交付出口**：单候选只能改一次、Smoke 只能尝试一次，但失败后原先无法进入结果/决策。现记录候选失败、禁止继续训练，并允许重验和交付合法 Baseline。
6. **产物寻址**：每次扩展工具结果均携带实际工作目录，配合相对 artifact 路径寻址，不让模型猜测文件位置。

Pi 已提供 TUI、Agent Loop、工具调度、JSON Schema 校验、动态注册、Session、模型配置与事件，本轮均直接复用，未改底层循环。AXIOM 保留实验级串行化、候选/动作白名单及训练进程封装：这些是固定 ML 工作流规则；Pi 通用 `exec` 不提供本流程要求的最小化子进程环境和同等进程树终止策略，因此没有直接替换受控执行器。AST 检查和环境精简均不构成 OS 安全沙箱。

## 实际执行结果

最终连续执行 `npm run build && npm run check && npm run test:ml` 成功：

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

## 已验证与尚未验证

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
- WP-04 多轮 TaskSpec、Token/时间/计算预算和持久最佳模型管理；NIM 自动回退旧代码不在当前仓库中。

## WP-04 进入条件与最小下一步

**可以开始迁移 WP-04 的纯领域内核，不应把完整产品/真实模型验收标为完成。** 先取得旧本地源码或备份并核对，不根据文档臆造旧功能。不要迁入旧 readline、Session 工厂或模型请求/回退包装。

最小下一片：只迁入不可由模型修改的 TaskSpec 与实验次数/墙钟预算门禁，接当前受控执行器，暂不加远程 GPU 或供应商回退。

验收标准：

1. 同一任务最多执行两次合法候选；达到次数/墙钟上限后，代码阻止第三次训练。
2. 第二轮失败仍能导出历史最佳合法模型，不信任模型自报指标。
3. 取消后不启动队列中下一轮；固定训练/评估权限不扩大。
4. 继续通过本轮 42 项回归，并新增确定性预算单测及一次真实 CPU 两轮验收。
5. Token 门禁接 Pi 原生 usage/event 时再单独验收，不以工具次数替代 Token 预算。

真实 API/TUI 验收作为独立审批项：仅一个 Tiny Task、一个候选、一个已配置供应商，无 GPU。先确认模型价格和可接受的 Token/金额上限；当前没有硬性 Token/费用门禁，工具操作上限不能保证美元上限，故未经批准不执行。

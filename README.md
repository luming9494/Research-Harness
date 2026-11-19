# Research Harness · AXIOM

**AXIOM 是基于固定版本 Pi 1.5.0 开发、面向自主科研的自进化 Agent Harness。** 机器学习是首个落地场景，长期覆盖模型优化、论文复现、消融实验与 RAG 检索策略优化。

> **当前状态：WP-04 的可信 Tiny CPU 优化已通过两阶段真实 LLM 主流程验收。** 第二阶段通过原生 Pi RPC 完成两轮自主候选，独立 validation accuracy 从 0.5 提升至 1.0，并交付可独立重载的最佳模型。候选较差、平分或失败后的回退覆盖来自离线测试。终端键盘与视觉交互仍待验收。详见 [验收记录](docs/AXIOM_VALIDATION.md)。

> **WP-05 已通过运行时验证。** Pi Durable + SQLite 的测试在强制结束进程后恢复了同一任务及预留记录，并阻止状态不明的操作重复启动。Tiny CPU 实验账本与原生 CLI 恢复尚待接入。[WP-05 验证](docs/AXIOM_WP05_RUNTIME.md)

## 为什么重新基于 Pi 源码开发？

旧 AXIOM 通过 Pi SDK 自行实现了一层 CLI、Session 工厂、日志订阅和供应商回退。这与 Pi 已经存在的 TUI、Agent Loop、Extensions、模型目录和上下文机制部分重复。

**Pi 提供 Agent 底座，AXIOM 负责 AI 任务的执行与验证。** 当前扩展用 ML TaskSpec、候选审查、训练、独立评估和最佳模型交付跑通这条链路。后续用训练之外的任务检验预算、执行、证据与交付机制能否复用。

- **Pi 提供**模型与凭据配置、Agent Loop、工具调度、会话、通用上下文管理和 TUI。Pi Durable 还提供持久任务、检查点及重启调度。
- **AXIOM 负责**科研 TaskSpec、领域预算、候选实验、独立评分和证据交付。外部作业对账及策略评测与发布属于后续目标。
- **版本策略**：以当前下载的 Pi 1.5.0 源码为固定底座，**不自动追踪上游更新**。AXIOM 与 Pi 原作者没有从属或官方合作关系。

## 双闭环与应用场景

- **实验内环**在同一评估协议和预算下提出假设、筛选候选、执行实验并依据结果迭代。WP-04 已在可信 Tiny CPU 上验收多轮流程，多保真剪枝与 Pareto 多目标搜索是后续目标。
- **策略外环**从历史轨迹发现可重复失败，提出受限策略变更，经对照和独立留出评测后发布或拒绝。已发布版本可回滚。首版计划开放 Prompt、白名单 Skill、工具输出和上下文策略配置。

| 目标模式 | 典型输入 | 最终交付 | 状态 |
| --- | --- | --- | --- |
| **Optimize** 模型改进与课程打榜 | 基线代码、规则、训练数据、指标、预算 | 合法模型代码、权重、独立验证、实验总结 | 可信 Tiny Task 单候选及多轮预算内核已迁入 |
| **Reproduce** 论文复现 | 论文、GitHub 仓库、数据及复现协议 | Run / Evaluate / Train 复现级别、指标差距 | 规划中 |
| **Ablate** 消融实验 | 基线、模块组合、已有实验和预算 | 消融组合、真实结果、配置和报告 | 规划中 |
| **RAG 检索优化** | 固定语料、查询集、相关性标注、检索基线 | 检索配置、独立指标与查询级对照 | 规划中，复用实验内环 |

目标交互是：**自然语言任务 → 检查规则 → 规划候选 → 改代码 → 真训练/评估 → 根据客观结果迭代 → 按预算停止 → 交付模型与报告**。

当前支持 **WP-01～04 的可信 Tiny CPU 流程**，不声称可以接管任意第三方训练仓库。WP-04 已从本机旧源码抽取领域实现，未迁入旧 Session 工厂、readline、模型请求或供应商回退包装。

## 新源码在哪里？

~~~text
Research-Harness/
├── packages/                   # 原 Pi monorepo（基本保持原样）
│   └── coding-agent/
│       └── src/
│           └── axiom/
│               ├── execution/
│               │   ├── process.ts           # 受控进程执行与输出限制
│               │   ├── smoke-workspace.ts   # 隔离候选、白名单、AST 检查入口
│               │   ├── single-optimize.ts  # 单轮优化、客观 keep/revert
│               │   ├── task-spec.ts         # 用户审批的固定规则与预算
│               │   ├── task-budget.ts       # 实验/墙钟/步骤/进程耗时/Token
│               │   ├── task-controller.ts   # 多轮、去重、历史最佳、停止与报告
│               │   └── task-executor.ts     # 可信 CPU worker 与交付完整性
│               ├── research.ts             # 实验清单/指标来源校验
│               └── table.ts                # Markdown/CSV/LaTeX 导出
├── axiom/extensions/
│   ├── axiom-tiny.ts           # 显式入口，保留单候选命令
│   └── axiom-task.ts           # 原生多轮工具、usage 与生命周期桥接
├── axiom/durable/
│   └── task-runtime.ts         # Pi Durable 运行时与单写者保护
├── examples/
│   ├── tiny-ml-task/           # 固定合成基线模型
│   ├── tiny-ml-eval/           # 训练、验证、判题与源码审查
│   └── synthetic-experiment/  # 公开合成实验记录
├── tests/
│   ├── python/                # 原 AXIOM Python 回归测试
│   ├── fixtures/              # 人工参考结构，仅用于离线校准与测试
│   └── axiom/decision.test.mjs # 新仓库的确定性 Node.js 验证
└── docs/
    ├── AXIOM_MIGRATION.md     # 迁移完成/缺失项与核验步骤
    └── AXIOM_ROADMAP.md       # 下一步开发重点
~~~

扩展入口**不创建新的 Pi Session、readline 或模型流包装**。单候选和多轮 ML 领域状态在 AXIOM 自己的 Controller 中；Pi 仍保存真正的会话。

## 开发用 Pi 与本仓库 AXIOM 完全分开启动

在本仓库目录执行裸命令 `pi`，运行的是你在系统 PATH 中安装的**开发工具 Pi**（可通过 Windows `where.exe pi` 查询），不代表正在运行本仓库的 Pi 源码。

- **开发工具**：直接 `pi`，使用全局安装版本；AXIOM 扩展已移出自动发现的 `.pi/extensions/`，不会因为没有构建本仓库而触发加载错误。
- **AXIOM 项目**：在仓库根目录 `npm run axiom`，使用**本仓库编译出的 Pi CLI**，显式加载 `axiom/extensions/axiom-tiny.ts`，并启用 `regular` 终端模式。
- **无扩展排查**：`pi -ne` 禁用开发工具的自动扩展；`npm run build` 负责产生 `packages/coding-agent/dist/axiom/` 下的 AXIOM 模块。

开发工具和 AXIOM 启动器默认使用各自的持久配置与会话目录，具体路径见下方配置表。两者在同一工作目录启动时仍访问同一份源码，请用 Git 管理文件变更。

## 在 Windows / VS Code 中体验（Tiny Task）

要求：Node.js >=22.19，Python 虚拟环境含 PyTorch（CPU 即可）。Research-Harness 的凭据使用下述独立登录命令配置，不复用全局开发 Pi 的凭据文件。

~~~powershell
git clone https://github.com/luming9494/Research-Harness.git
cd Research-Harness
npm ci --ignore-scripts
npm run build

py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r examples\tiny-ml-eval\requirements-cpu.txt

# 无需 API/GPU：Python、Node 控制器和 Pi Session 集成回归
npm run test:ml

# 一次性保存 Research-Harness 专属的 DeepSeek Key（提示中输入，不写进命令）
npm run axiom:login

# 仓库自己的 Pi，默认 regular TUI；无需手动设置环境变量
npm run axiom
~~~

### 开发 Pi 与 Research-Harness 的配置隔离

| 用途 | 命令 | 用户配置目录 |
| --- | --- | --- |
| 全局开发工具 | `pi` | 默认 `%USERPROFILE%\.pi\agent`，保持原样 |
| Research-Harness | `npm run axiom` | `%LOCALAPPDATA%\Research-Harness\agent`，在仓库外 |
| 项目专属 DeepSeek 登录 | `npm run axiom:login` | 同上，Pi 原生隐藏输入并持久保存 `auth.json` |
| 项目专属 DeepSeek 退出 | `npm run axiom:logout` | 同上，不删除开发 Pi 的 Key |

`auth.json`、`settings.json`、`models.json` 和 `sessions/` 均使用 Research-Harness 的独立目录。登录一次后，后续启动自动读取，不需要每次填 Key。不会复制或修改全局 Pi 的安装和配置；不要将 Key 存放在仓库的 `private/`、`.env` 或 `.pi/` 中。Pi 的 `auth.json` 是本机明文文件，依赖系统账户权限保护，不是加密密码库。

`scripts/launch-axiom.mjs` 仅在子进程环境设置 `PI_CODING_AGENT_DIR` 和独立的 `PI_CODING_AGENT_SESSION_DIR`，工作目录固定为仓库，执行仓库编译的 CLI。正常启动使用 `-ne -e axiom/extensions/axiom-tiny.ts --tui-mode regular`，禁用扩展自动发现；登录/退出直接传给原生 `auth`，不加载 AXIOM 实验扩展。Ctrl+C 交由共享前台终端中的 Pi 处理，启动器等待退出，不再重复转发 Ctrl+C 打断其清理。

其他供应商仍走原生认证，无需新增请求包装：

```powershell
node scripts/launch-axiom.mjs auth login <provider> --api-key
node scripts/launch-axiom.mjs auth logout <provider>
```

CLI 参数可以透传，例如 `npm run axiom -- --offline --version`、`npm run axiom -- --continue`。只有用户显式指定其他 session 路径时才可能越过默认会话隔离，勿指向开发 Pi 的会话。原生环境凭据的解析优先级不变：父进程中的供应商 Key 环境变量仍可被 Pi 使用；本改造隔离的是持久配置文件，不是进程权限/环境沙箱。专属 Key 应通过 `axiom:login` 保存，不依赖开发工具的环境 Key。

未构建时会明确提示 `npm run build`；若提示找不到 `scripts/launch-axiom.mjs`，请确认当前检出包含该脚本，不要改用会共享配置的旧直连命令。`LOCALAPPDATA` 缺失、不是绝对路径或最终目录指向仓库/全局 Pi 配置时会拒绝启动，不回退到仓库。本启动方案面向 Windows。

全局 `pi` 继续用于开发，不自动加载 AXIOM。项目 `.pi` 指令、Skills 等仍遵循 Pi 原生规则，不等于 OS 隔离。领域源码使用 Pi 自带 TypeScript 加载器；修改后仍应重新构建并跑测试。

进入 AXIOM 启动的 Pi 后输入：

~~~text
/axiom-tiny
~~~

确认允许运行本地受控训练，再输入自然语言，例如：

> 检查这个 Tiny ML 分类任务，先评估线性 Baseline，自己提出一个合法模型改动，做 L0 和 Smoke Test，执行一次完整候选训练，根据独立 validation 指标决定 keep 或 revert，最后展示代码 Diff 和产物路径。

如要退出受控模式，输入：

~~~text
/axiom-stop
~~~

所有候选和训练产物写入本地忽略的 `private/`。**执行会调用你在 Pi 中选定的模型 API，并可能收费；训练会使用本机 CPU。**

### WP-04 多轮任务

在同一入口启动后输入 `/axiom-task`，审批默认规则：最多 **2 次独立候选训练**、墙钟 **600 秒**、训练步骤预留 **244**（Baseline 80 + 两次候选各 82）、受控子进程累计耗时 **300 秒**、Token 预算 **100000**、单线程 CPU。

然后输入：

> 检查任务规则和预算，运行 Baseline，根据独立 validation 反馈提出候选并迭代。训练时等待工具完成，不轮询。按预算停止，交付历史最佳的模型代码、权重、配置和真实验证报告。

- `/axiom-task-stop`：取消训练与 Agent turn，等待进程结束、交付已有合法最佳，再恢复原工具。两个 AXIOM 模式互斥；切换前先停止。
- 自定义预算：`/axiom-task <完整 TaskSpec JSON>`，只能由用户在命令中设置并审批；完整格式和范围见 [验收文档](docs/AXIOM_VALIDATION.md)。模型工具不能放宽规则或更改配置。
- 只有四个原生领域工具：`axiom_task_inspect`、`axiom_task_baseline`、`axiom_task_candidate`、`axiom_task_finish`。一次候选工具内部完成审查、去重、Smoke、完整训练和独立验证，不另建 Agent Loop。
- 每次任务的 `private/wp04-*/` 保存 `summary.json`、`experiments.json`、`events.jsonl`、`report.md`、源码 Diff、命令记录及历史最佳 `model.py`、`config.json`、`best_model.pt`、可独立重载的 `best/`。
- Token 按 Pi 原生 assistant usage 实际结算，包括缓存 Token；请求前只是估算准入，**不是供应商输出 Token 硬限制或绝对金额上限**。实际消耗可能超出估算，随后停止进一步请求。没有批准就不做收费 API 验收。

### 重要限制

- `/axiom-tiny` 保留单候选流程；`/axiom-task` 支持多轮预算流程。两者都只支持固定可信合成任务，不支持任意课程作业/论文仓库。
- 工具层限制路径、命令与候选语法；原生 Pi TUI 的插件机制仍运行在用户系统权限下，**不能把它当作 OS 安全沙箱**。
- Tiny 模式期间会禁用其他模型工具并拦截非 AXIOM Tool Calls；退出模式后恢复之前的工具选择。其他扩展自身的执行和用户主动运行的 Shell 不在此保证范围内。
- 不能通过最终测试集反复调参；程序独立验证 validation 指标。
- API Key、未发表论文、真实实验结果和模型权重不得上传到公开仓库。

## 下一步开发重点

1. **P0**：将 WP-05 持久运行时接入 Tiny CPU 实验账本与恢复入口。用 AXIOM-Bench 验证故障恢复，并对照多保真搜索与现有完整训练策略。
2. **P1**：完成四层上下文、工具治理与实验证据链，再验证一次受控策略提案、评测、发布与回滚。
3. **P2–P3**：接入 RAG、消融、分级复现和 Slurm GPU 作业。账本与报告稳定后增加管理界面。

审阅时先看[完整开发计划](docs/AXIOM_DEVELOPMENT_PLAN.md)与[开发路线](docs/AXIOM_ROADMAP.md)，再对照[产品需求](docs/PRODUCT_REQUIREMENTS.md)、[评测设计](docs/EVALUATION.md)、[简历目标稿](docs/AXIOM_RESUME.md)和上述两份验收记录。Pi 复用与领域模块迁移见[迁移说明](docs/AXIOM_MIGRATION.md)。

## Pi 来源和许可

本仓库以 [earendil-works/pi](https://github.com/earendil-works/pi) 的 Pi 1.5.0 代码为主体。原 Pi 子包和文档可从 [packages/coding-agent](packages/coding-agent/README.md) 继续阅读。**原有 MIT LICENSE 和版权声明保留不变。** 本项目是独立的衍生开发，不是 Pi 官方版本。

---

**Research Harness / AXIOM · From Task to Experiment, From Experiment to Evidence.**

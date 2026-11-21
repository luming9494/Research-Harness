# Research Harness · AXIOM

**AXIOM 是基于固定版本 Pi 1.5.0 开发、面向自主科研的自进化 Agent Harness。** 机器学习是首个落地场景，长期覆盖模型优化、论文复现、消融实验与 RAG 检索策略优化。

**当前可用场景包括 Tiny CPU 模型优化、SciFact 检索优化、科研消融和分级复验。** 项目可从论文原文定位追溯到冻结计划、原生账本、独立指标和最终结论。通过 [最终工程与 Demo](docs/AXIOM_FINAL_ENGINEERING.md)、[验收记录](docs/AXIOM_VALIDATION.md) 和 [简历证据映射](docs/AXIOM_RESUME_EVIDENCE.md) 核对实现和适用范围。

## 为什么重新基于 Pi 源码开发？

旧 AXIOM 通过 Pi SDK 自行实现了一层 CLI、Session 工厂、日志订阅和供应商回退。这与 Pi 已经存在的 TUI、Agent Loop、Extensions、模型目录和上下文机制部分重复。

**Pi 提供 Agent 底座，AXIOM 负责科研任务的执行与验证。** Tiny CPU 和 SciFact 共享预算、去重、执行、取证与交付。科研工作区把原生运行链接到计划和结论。

- **Pi 提供**模型与凭据配置、Agent Loop、工具调度、会话、通用上下文管理和 TUI。Pi Durable 还提供持久任务、检查点及重启调度。
- **AXIOM 负责**科研 TaskSpec、领域预算、候选实验、独立评分、外部作业对账和策略治理。
- **版本策略**：以当前下载的 Pi 1.5.0 源码为固定底座，**不自动追踪上游更新**。AXIOM 与 Pi 原作者没有从属或官方合作关系。

## 双闭环与应用场景

- **实验内环**在同一评估协议和预算下提出假设、筛选候选、执行实验并依据结果迭代。Tiny CPU 已验收多保真、Pareto 和多种子统计，SciFact 已验收混合检索与独立重放。
- **策略外环**从历史轨迹发现可重复的失败，提出受限呈现策略，经开发对照、独立留出和固定门槛决定晋升、拒绝或待定。注册表通过事务保存发布与回滚事件。

| 目标模式 | 典型输入 | 最终交付 | 状态 |
| --- | --- | --- | --- |
| **Optimize** 模型改进与课程打榜 | 基线代码、规则、训练数据、指标、预算 | 合法模型代码、权重、独立验证、实验总结 | 可信 Tiny Task 单候选及多轮预算内核已迁入 |
| **Reproduce** 固定协议复验 | 论文资料、工件与冻结计划 | Run / Evaluate / Train 级别和证据图 | Tiny 训练复验与 SciFact 排名重放已验证 |
| **Ablate** 消融实验 | 基线、控制条件与预算 | 配对差值、多种子统计和报告 | Tiny CPU、SciFact 已实跑 |
| **RAG 检索优化** | 固定语料、查询集、相关性标注、检索基线 | 检索配置、独立指标与查询级对照 | SciFact BM25 / Dense / RRF 已实跑 |

目标交互是：**自然语言任务 → 检查规则 → 规划候选 → 改代码 → 真训练/评估 → 根据客观结果迭代 → 按预算停止 → 交付模型与报告**。

当前运行范围为可信 Tiny 和 SciFact 实验入口。正常 Pi 会话可读取经过范围校验的 Qdrant 历史经验，训练和独立评分仍由宿主执行。

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
│   ├── task-runtime.ts         # Pi Durable 运行时与单写者保护
│   └── experiment-ledger.ts    # 权威任务快照与原子提交
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
npm run build:offline

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

- 新建的 `/axiom-task` 会保存 SQLite 实验账本。进程异常退出后，在同一仓库和 Python 环境运行 `/axiom-task-resume <任务 ID>`。任务 ID 是工作目录名（例如 `wp04-ABC123`）。从账本恢复原批准规则、预算、截止时间和历史最佳。正常停止或显式取消保持终态，旧的纯 JSON 任务记录继续用于查看。
- 多轮模式发起模型请求前，Pi 配置中须显式设置 `retry.provider.maxRetries: 0`。在项目独立的 Pi `settings.json` 中合并 `{"retry":{"provider":{"maxRetries":0}}}`，保留其他设置。训练调用和恢复命令本身无需模型请求。

- `/axiom-tiny` 保留单候选流程；`/axiom-task` 支持多轮预算流程。两者都只支持固定可信合成任务，不支持任意课程作业/论文仓库。
- 工具层限制路径、命令与候选语法；原生 Pi TUI 的插件机制仍运行在用户系统权限下，**不能把它当作 OS 安全沙箱**。
- Tiny 模式期间会禁用其他模型工具并拦截非 AXIOM Tool Calls；退出模式后恢复之前的工具选择。其他扩展自身的执行和用户主动运行的 Shell 不在此保证范围内。
- 不能通过最终测试集反复调参；程序独立验证 validation 指标。
- API Key、未发表论文、真实实验结果和模型权重不得上传到公开仓库。

## Docker、Benchmark 与验收边界

固定摘要镜像和 Docker 启动参数见 [统一执行](docs/AXIOM_UNIFIED_EXECUTION.md)。本机观测服务用 [科研平台](docs/AXIOM_RESEARCH_PLATFORM.md) 的固定版本启动。

使用 `npm run bench:axiom -- --verify CASE_DIR` 复核已有记录，使用 `npm run suite:axiom -- ...` 核对跨领域证据。模型任务达成和 Harness 正确性保持独立评分。完整命令和真实对照见 [最终工程与 Demo](docs/AXIOM_FINAL_ENGINEERING.md)。

Slurm 已有离线对账、防重与取消验收，真实 GPU 仍需获授权集群。正式 Dropout/MNIST 留待独立复现挑战。参见 [开发路线](docs/AXIOM_ROADMAP.md)、[评测设计](docs/EVALUATION.md) 与 [简历目标稿](docs/AXIOM_RESUME.md)。

## Pi 来源和许可

本仓库以 [earendil-works/pi](https://github.com/earendil-works/pi) 的 Pi 1.5.0 代码为主体。原 Pi 子包和文档可从 [packages/coding-agent](packages/coding-agent/README.md) 继续阅读。**原有 MIT LICENSE 和版权声明保留不变。** 本项目是独立的衍生开发，不是 Pi 官方版本。

---

**Research Harness / AXIOM · From Task to Experiment, From Experiment to Evidence.**

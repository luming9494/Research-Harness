# Research Harness · AXIOM

**基于固定版本 Pi 1.5.0 源码开发的自主机器学习工程 Agent。**

> **当前状态：迁移中的开发版本。** 新仓库以完整 Pi 源码为基础，已迁入原 AXIOM 公开仓库的 Tiny PyTorch 任务、真实训练与独立验证、候选代码审查、单轮模型优化及基础实验数据处理。新增原生 Pi Extension 入口，但**尚未在新仓库完成本地构建、模型 API 或端到端重新验收**。之前 WP-04 的多轮预算/NIM 功能主要在旧电脑本地且未推送，**目前不在这个仓库中**。

## 为什么重新基于 Pi 源码开发？

旧 AXIOM 通过 Pi SDK 自行实现了一层 CLI、Session 工厂、日志订阅和供应商回退。这与 Pi 已经存在的 TUI、Agent Loop、Extensions、模型目录和上下文机制部分重复。

**新原则：Pi 就是 Agent 主体，AXIOM 只负责机器学习业务。** 直接保留 Pi 的原生 TUI、会话、模型、工具调度和上下文；将 ML TaskSpec、候选改动、训练执行、预算、独立评估、历史最佳和交付集成为它的领域扩展。

- **Pi 负责**：聊天与编码能力、模型/凭据配置、Agent Loop、工具事件、会话与上下文。
- **AXIOM 负责**：机器学习任务规则、受控候选代码、训练/Smoke/Proxy/Full、独立指标检验、实验循环与产物。
- **不会做**：再次开发简易聊天界面、重复实现基础模型调用、自研另一套 Pi Session/TUI。
- **版本策略**：以当前下载的 Pi 1.5.0 源码为固定底座，**不自动追踪上游更新**。AXIOM 与 Pi 原作者没有从属或官方合作关系。

## 核心目标：三类 ML 任务

| 目标模式 | 典型输入 | 最终交付 | 状态 |
| --- | --- | --- | --- |
| **Optimize** 模型改进与课程打榜 | 基线代码、规则、训练数据、指标、预算 | 合法模型代码、权重、独立验证、实验总结 | Tiny Task 单候选已迁移，多轮尚未迁移 |
| **Reproduce** 论文复现 | 论文、GitHub 仓库、数据及复现协议 | Run / Evaluate / Train 复现级别、指标差距 | 规划中 |
| **Ablate** 消融实验 | 基线、模块组合、已有实验和预算 | 消融组合、真实结果、配置和报告 | 规划中 |

目标交互是：**自然语言任务 → 检查规则 → 规划候选 → 改代码 → 真训练/评估 → 根据客观结果迭代 → 按预算停止 → 交付模型与报告**。

当前新仓库只迁移了 **WP-01～03 的公共代码**，不声称已经可以接管任意第三方训练仓库。原本在本地通过的 WP-04 多轮流程还需单独导入和移除重复 Pi 包装。

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
│               │   └── single-optimize.ts  # 单轮优化、客观 keep/revert
│               ├── research.ts             # 实验清单/指标来源校验
│               └── table.ts                # Markdown/CSV/LaTeX 导出
├── .pi/extensions/
│   └── axiom-tiny.ts           # Pi 原生 Tiny Task 命令与工具桥接
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

扩展入口**不创建新的 Pi Session、readline 或模型流包装**。单候选 ML 领域状态在 AXIOM 自己的 Controller 中；Pi 仍保存真正的会话。

## 在 Windows / VS Code 中体验（Tiny Task）

要求：Node.js >=22.19，Python 虚拟环境含 PyTorch（CPU 即可），本地 Pi 配置好有效模型凭据。

~~~powershell
git clone https://github.com/luming9494/Research-Harness.git
cd Research-Harness
npm ci
npm run build

py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r examples\tiny-ml-eval\requirements-cpu.txt

# 无需 LLM/GPU 的测试：先验证任务底座
.\.venv\Scripts\python.exe -m unittest discover -s tests\python -v
node --test tests\axiom\decision.test.mjs

# 使用 Pi 原生终端，regular 模式方便回看历史输出
node packages\coding-agent\dist\bundle\cli.js --tui-mode regular
~~~

进入 Pi 后输入：

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

### 重要限制

- `/axiom-tiny` 只支持**一个**固定合成 Tiny Task 和**一个候选**；不是旧 WP-04 的多轮优化，也不是任意课程作业/论文仓库。
- 工具层限制路径、命令与候选语法；原生 Pi TUI 的插件机制仍运行在用户系统权限下，**不能把它当作 OS 安全沙箱**。
- Tiny 模式期间会禁用其他模型工具并拦截非 AXIOM Tool Calls；退出模式后恢复之前的工具选择。其他扩展自身的执行和用户主动运行的 Shell 不在此保证范围内。
- 不能通过最终测试集反复调参；程序独立验证 validation 指标。
- API Key、未发表论文、真实实验结果和模型权重不得上传到公开仓库。

## 下一步开发重点

1. **先重新跑通新仓库的完整构建与无模型回归**，修复 Pi Monorepo 内的 TypeScript/扩展兼容问题；
2. **验收原生 Pi TUI → AXIOM 工具 → 真实 Python 训练 → 结果交付**；
3. 从旧电脑本地按模块恢复尚未推送的 WP-04 **多轮 Experiment Loop、预算控制与任务交付**，不迁移旧 readline/Session/模型路由包装；
4. 使用 Pi 原生模型目录配置 NIM / DeepSeek；不直接恢复旧的自定义 streamFunction 回退；
5. 完善取消、恢复、失败交付与 T1/T2 评测，再扩展 Ablate / Reproduce / GPU Runner。

详见 [迁移说明](docs/AXIOM_MIGRATION.md) 和 [开发路线](docs/AXIOM_ROADMAP.md)。

## Pi 来源和许可

本仓库以 [earendil-works/pi](https://github.com/earendil-works/pi) 的 Pi 1.5.0 代码为主体。原 Pi 子包和文档可从 [packages/coding-agent](packages/coding-agent/README.md) 继续阅读。**原有 MIT LICENSE 和版权声明保留不变。** 本项目是独立的衍生开发，不是 Pi 官方版本。

---

**Research Harness / AXIOM · From Task to Experiment, From Experiment to Evidence.**

# AXIOM → Research-Harness 迁移记录

> 2026-11-06 · 此文区分**已提交代码**与**已在新工程验证的功能**。  
> 来源：旧公开仓库 [luming9494/AXIOM](https://github.com/luming9494/AXIOM)。目标：完整 Pi 源码仓库 [Research-Harness](https://github.com/luming9494/Research-Harness)。

## 1. 原则

- **新仓库以下载的 Pi 源码为 Git 根**，不再嵌套 vendor/pi submodule；不得将旧 AXIOM 的独立 CLI/SDK 封装复制成另一个 Agent 产品。
- Pi 1.5.0 的模型配置、Session、TUI、Agent Loop、Extensions、Compaction 和 Skills 为主要基础能力。
- AXIOM 仅迁移机器学习业务所需代码：实验约束、受控候选、Python Runner 接口、独立评估、指标与产物。
- 所有未发表研究、真实日志/权重、凭据和本机私有目录严格不进入公开仓库。
- **不可将“代码已复制”与“端到端已验收通过”混为一谈**。

## 2. 已提交的独立部分

| 原 AXIOM 模块 | 新工程路径 | 说明 |
| --- | --- | --- |
| `src/execution/process.ts` | `packages/coding-agent/src/axiom/execution/process.ts` | 进程/输出/超时的受控执行逻辑 |
| `src/execution/smoke-workspace.ts` | `packages/coding-agent/src/axiom/execution/smoke-workspace.ts` | 可信 Tiny Task 私有候选、路径校验、固定训练动作 |
| `src/execution/single-optimize.ts` | `packages/coding-agent/src/axiom/execution/single-optimize.ts` | 单候选训练、独立指标验证、程序决定 keep/revert |
| `src/research.ts` 与 `src/table.ts` | `packages/coding-agent/src/axiom/` | 实验清单和数据表输出 |
| `examples/tiny-ml-*` | 根目录 `examples/tiny-ml-*` | PyTorch 合成任务、评估/审查脚本 |
| `tests/python` / `tests/fixtures` | 根目录对应路径 | Python 回归与合成参考结构 |
| 原 Agent 工具编排 | `.pi/extensions/axiom-tiny.ts` | **新写的 Pi 原生桥接**，未复制重复 SDK 初始化 |
| 新版 Node 策略测试 | `tests/axiom/decision.test.mjs` | 单轮决策确定性测试 |

由于 Pi 的 TypeScript 配置采用 `erasableSyntaxOnly`，迁入的两处构造器参数属性已改写为普通字段初始化；业务规则与训练决策不应因此改变。

## 3. 未迁移，不要误判为已经恢复

- 旧 AXIOM 的 **WP-04 多轮候选、TaskSpec、预算控制、交付整合**：最新版本仍停留在用户本地、尚未进入旧公开 GitHub。
- **NVIDIA NIM** 多轮 Function Calling 与 **NIM → DeepSeek** 供应商回退代码：本地版本尚未推送。本次不重写 Pi 的模型配置/路由。
- 旧 `src/agent/smoke-agent.ts`、`optimize-agent.ts`、`src/cli.ts`、`src/agent.ts` 的 Session 初始化、事件订阅、readline 与供应商封装：**刻意不迁移**，避免重复实现 Pi。
- 原来的 React Web 离线前端：暂缓，不属于新的 CLI 主线。
- 远程 GPU、真正 OS 沙箱、完整 Reproduce/Ablate：仍未实现。

## 4. 新入口的明确能力边界

`/axiom-tiny`：在 Pi 原生会话中，通过人工同意创建受控 Tiny Task，暂时只开放九个 namespaced ML 工具；自动禁用普通 Pi 工具以便不绕过限定的任务动作。

**仍不是 OS 沙箱**：Pi 扩展/用户账号具备本地进程权限，不能用这套 Tiny 安全策略运行来源不明的训练仓库。训练与来源 SHA、AST 策略适用于固定可信任务。

`/axiom-stop`：退出 Tiny 模式，恢复 Pi 原本工具选择；不会把已运行的长时外部 GPU Job 当作已取消。

## 5. 新仓库验收清单（尚未在本次远端操作中实际运行）

~~~powershell
npm ci
npm run build
.\.venv\Scripts\python.exe -m unittest discover -s tests\python -v
node --test tests\axiom\decision.test.mjs tests\axiom\single-optimize.test.mjs tests\axiom\smoke-permissions.test.mjs
node packages\coding-agent\dist\bundle\cli.js --tui-mode regular
~~~

进入原生 Pi：

~~~text
/axiom-tiny
~~~

确认出现 Tiny Task 工作目录，要求 Agent 先读取 model.py 和 baseline，再提交单个方案，训练并交付 `selected/`、`decision.json` 与 `patch.diff`。用系统生成文件作为真实依据，不以 LLM 自述为验收结论。

由于本次操作通过 GitHub API 迁移、无法访问你的 Windows 项目环境，**上述测试与模型请求并未实际执行**。首次本地运行应按实际错误修正代码。

## 6. WP-04 本地代码以后怎么导入？

建议在旧项目先提交/备份未保存工作，然后**只迁移独立的 ML 业务实现**，而不是整个旧 `src/agent`。重点查找：

- 多轮 Experiment Controller、预算/Token/计算时间/实验次数；
- 最佳候选选择、实验去重、结果目录/报告；
- 对应 Python/Node 回归与真实验收材料。

在新项目以当前 `packages/coding-agent/src/axiom/` 为承载位置，继续使用 Pi 原生 TUI 和模型配置。先迁移可测试的纯领域函数，再迁移工具交互，最后做模型供应商真实调用验证。

**不能仅从旧 GitHub 重建本地未提交的 WP-04 实现。** 旧代码必须先从你的电脑以提交或文件包形式提供，才可能完成逐函数迁移。

## 7. Source licensing

Pi 上游的 MIT LICENSE 与原作者版权必须保留；新 README 明确指出本项目为 Pi 源码衍生项目。对于没有重新编译和测试的源码，不得标注已验证。

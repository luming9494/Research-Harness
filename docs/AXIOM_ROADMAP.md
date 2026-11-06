# Research Harness / AXIOM · CLI-first 路线

> 以已固定的 Pi 1.5.0 源码为主体；不主动同步上游。新架构优先复用已有 Pi 机制，不重复造 TUI、Session 和基础 Agent Loop。

## 当前里程碑

| 阶段 | 现状 | 接下来的判定标准 |
| --- | --- | --- |
| 新底座 | **Pi 源码已存在**，AXIOM Tiny 领域源码和 Python 例子已迁入 | `npm ci`、`npm run build`、原生 Pi TUI 正常 |
| WP-01 | 已迁入任务和评估器代码；旧仓库曾通过 | 在新仓库 CPU 上重新训练与独立评价 |
| WP-02 | 原生 Pi Tiny Extension 已编写；新仓库未验收 | 实际模型 Tool Calling、隔离编辑、Smoke、拒绝越界 |
| WP-03 | 单轮优化 Controller 已迁入；新仓库未验收 | Agent 自主提出候选、训练、Validation keep/revert |
| WP-04 | **旧本地版本未推送，尚未迁移** | 基于原生 Pi 的多轮 TaskSpec、Budget、最佳模型交付 |
| WP-05 | 未完成 | 取消、失败交付、状态恢复、系统评测 |
| 后续 | 未完成 | Ablate、Reproduce、远程 GPU Runner |

## 最近优先级

1. **P0：本地可编译**。验证新 Pi 源码与 AXIOM TS/Python 完全兼容；消除接口和构建错误。
2. **P0：原生 Pi 入口**。从 TUI 的 `/axiom-tiny` 跑通首次 Tool Calling，而不是重新写 readline。
3. **P0：业务回归**。独立评估和决策不能退化；不允许通过测试集作弊。
4. **P1：补齐 WP-04 源码**。获取旧本地未推送版本，抽出领域内核、不要复制 Pi 已有的模型回退和 Session 管理。
5. **P1：预算与恢复可靠性**。停止条件由代码执行，模型只决策候选；仅使用可信 Tiny Task 做 CPU 验收。
6. **P2：更多 ML 模式**。先 Ablate 小型实验，再 Reproduce 运行/评估复现，最后 GPU 长任务。

## 新代码原则

新增模块前回答：

- Pi 当前源码是否已有对应能力？
- 是否能通过原生 Extension、Skill 或少量修改解决？
- 剩余问题是否确实属于 ML 实验领域？

不为了“二开深度”而修改 Pi 底层 Agent Loop；只有明确的功能缺口和可复验的技术理由才动底层。

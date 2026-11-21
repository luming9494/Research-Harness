# WP-12 · 统一 Docker 与 Slurm 执行

## 任务入口与审批

普通 `/axiom-task` 和 `/axiom-task-resume` 继续使用 Pi Session、TaskController、Tiny AST 审查、TaskBudget 和 Pi Durable。TaskSpec v2 增加可选 `backend`，省略时保持可信本地执行。选择外部后端时，宿主以 `AXIOM_EXECUTION_PROFILE` 读取操作者批准的绝对配置文件。TaskSpec 绑定 `{"type":"docker|slurm","profile_sha256":"…"}`。缺少配置、配置摘要变化或适配器不匹配时拒绝执行。

```powershell
$env:AXIOM_EXECUTION_PROFILE = (Resolve-Path private/profile.json).Path
$spec = (Resolve-Path private/task.json).Path
npm run execute:axiom -- create --spec $spec --sha (Get-FileHash $spec).Hash --baseline
npm run execute:axiom -- resume --task TASK_ID --finish
npm run execute:axiom -- cancel --task TASK_ID
```

该入口仅执行已批准的 TaskSpec。真实训练会占用原任务的 compute 和训练步预算。`--finish` 使用原独立选优及交付逻辑。TaskSpec 和连接配置不得放入模型上下文。操作者的 SSH 配置、密钥和原始工件位于本地私有目录。

## 生命周期与不确定性

| 工作点 | 权威状态与恢复动作 |
| --- | --- |
| 预留与意图 | TaskController 原生操作提交任务 ID、操作 ID、候选指纹、TaskSpec/配置 SHA-256、原绝对截止时间、资源预留和稳定令牌。提交许可前崩溃可证明未启动。 |
| 提交许可 | 后端调用前将本地操作置为待核对。该写入与外部副作用之间无法用同一个事务覆盖。 |
| 提交与监控 | 成功返回容器 ID 或 Job ID。队列状态记录 `submitted`、`queued` 或 `running`。恢复入口只有查询、取消及收集路径。 |
| 终态 | 身份匹配后记录 `completed`、`failed` 或 `cancelled`、实际退出码、资源、用量和工件摘要。主机独立验证正式指标后才参与选优。 |
| 状态未知 | 响应丢失、查询失败、任务不存在、身份冲突或重复记录均保留 `unknown`，持续占用预留。不以负查询结果推导未提交。 |

AXIOM 在同一操作身份下仅有一次自动提交许可。只有原账本能证明许可未发出，才允许原生准入重新尝试。Slurm 没有跨 SQLite 与控制器的原子提交，部分调度历史延迟或过期时，只能由操作者核对。作业恢复继续监控原进程，训练步级 checkpoint 续跑另有独立要求。

## Docker

Windows 使用明确的 WSL2 发行版和发行版内的 Docker Unix Socket。程序通过 `wsl --exec` 传递固定参数。Linux 宿主可使用同一 Unix Socket。配置包括 `type`、`transport`、绝对 `executable`、可选 `distribution`、`engine` daemon ID 和预装的 digest `image`。连接的 daemon ID 必须匹配。宿主授权配置只用于受控 CLI，容器和模型都没有 Docker Socket。

使用固定 Tiny `experiment.py`。宿主先做 AST 审查，容器以 UID/GID `65532` 执行，使用 `network=none`、只读根、空 capability 集、`no-new-privileges`、独立 IPC、1 CPU、1 GiB 内存且无额外 swap、64 PID、有限 `/tmp` 和 GNU `timeout`。输入仅挂载固定脚本与已审查候选，输出使用独立目录。环境只显式传递固定线程、Python 和 HOME 值。进程恢复先核验容器名称、原 ID、digest 引用、身份标签、挂载和限制。收到确认终态、归档日志和计费收据后清理所属容器。[Docker container create](https://docs.docker.com/reference/cli/docker/container/create/)

宿主从受限文件集合核对源码和配置字节、checkpoint、历史和训练元数据，复用 `validate_only.py` 独立验证。仅用于可信 Tiny 模型和固定 Python 入口。禁止把任意第三方代码、任意 checkpoint 或未知镜像投入此模式。

## Slurm

配置固定 `host`、`user`、`cluster`、`partition`、`account` 与 POSIX 绝对 `remote_root`、`python`。配置还包括绝对 SSH `executable`、`known_hosts`、可选 `identity_file`，固定 `workload=tiny-xor-gpu-v1`、`evaluator=tiny-validation-v1`、`dataset_sha256`、`workload_sha256`、`gpus=1`、`cpu=1`、`memory_mib`、`min_vram_mib`、整分钟 `seconds` 和 `cancel=on_deadline_or_operator_request`。将宿主批准的 `task.json` 和 `gpu_train.py` SHA-256 分别写入数据及工作负载字段。远端工作根目录需预先存在并对该账号开放。评分 Python 与 GPU 训练的 PyTorch 版本和构建后缀需要一致，评价仍在宿主 CPU 执行。

SSH 强制 host key 校验和批处理模式，关闭转发，不走 SSH 默认配置。操作只能访问明确的单一批准端点。`sinfo` 与 `sacctmgr` 预检分区及账户。固定脚本与已审查候选写入独占远端目录，`sbatch --parsable` 使用稳定 job name、身份 comment、`--no-requeue`、资源上限及绝对 deadline。脚本自身验证 GPU 数量与显存并使用 `timeout` 限制进程。缺少配置或 GPU 时拒绝运行。[SchedMD sbatch](https://slurm.schedmd.com/sbatch.html)

状态查询要求 `squeue` 与 `sacct` 两路都可读。活动作业通过 `scontrol` 交叉核对目录和 comment。历史终态核对作业名、用量、退出码、账号、分区、集群、时间与工作目录。单一确认身份后才允许 `scancel`。取消与自然完成竞争时以最终会计记录为准。远端只读取固定日志尾部与五类 Tiny 训练工件。远端科研文件保持留存。会计系统延迟、查询权限、时钟同步、短周期资源计量以及集群配置差异仍会影响对账能力。[SchedMD squeue](https://slurm.schedmd.com/squeue.html) · [SchedMD sacct](https://slurm.schedmd.com/sacct.html)

当前环境未配置明确获授权的 Slurm 端点，无可核验真实 Job ID。真实 GPU 验收标记 **`pending_external_validation`**。离线测试中的 Job `731` 为脚本化回执。

## 执行记录

Windows 11 控制进程通过 WSL2 Ubuntu 24.04 Docker Engine 实跑。Windows 物理内存 16 GiB，WSL2 上限 3 GiB。固定镜像 `docker.io/library/axiom-sandbox-cpu@sha256:dd2a9834278de1a43146ce3fc02435a94ba6a30573234cb89daeffa589b926e8`。实际训练均有限制 CPU、RAM、PID、禁网及只读根。Pi 使用 faux provider，付费模型请求为 0。

| 实验 | 真实证据 | 结算 |
| --- | --- | --- |
| 普通 TaskController | `wp04-KMQdGh`，直接创建、训练、独立评分并交付。 | 容器 6.503 秒，任务 compute 14.767 秒。 |
| 强杀后接回原容器 | `wp04-nuY83Y`，容器 `97216787407d2189f941b8b96088c6d5f38c30b371afa7bf222144ac5b1fc051`。提交 ID 落盘后强杀，新的 Pi Session 通过 `/axiom-task-resume` 恢复，原截止时间、唯一操作和容器 ID 相同。 | 容器 9.347 秒，任务 compute 19.337 秒，512 个样本准确率 `0.990234375`，checkpoint SHA-256 `656f54e103dc1d88df0f5e9cef2c34aeb50f208cf17d759f52339acf92c3654f`。 |
| 强杀后取消 | `wp04-7zokxT`，同一容器 `f445686356c2e67177db16a2fdc7d98cc93fa881d7f469baf3c21f406860884c`。确认 exit 137 后清理。 | 容器 6.206 秒，任务 compute 6.838 秒。保留已授权训练预留，无成功评分。 |
| 预算拒绝 | `wp04-F2O2q1`，79 步额度不足以启动 80 步基线。 | `training_step_budget_exhausted`，无外部提交及训练预留。 |

原始 SHA-256 清单、预算与命令收据见 `private/wp12/docker-cross-process.json`、`docker-cancel.json`、`docker-budget.log` 及对应 `private/wp04-*/commands`。首次 Docker 调试暴露出 WSL 参数转义、日志压缩配置和恢复定时器整数边界问题，修复后两个真实验收均通过。

最终源码再跑两个真实验收均通过，记录在 `private/wp12/final-live` 和 `docker-live-recheck.log`。任务 `wp04-PPfFub` 原容器 `794dc532d7a954ff4e5055afbcad2cc82947076c3682ac178a55b02f743d4df0` 完成，容器 8.482 秒，任务 compute 18.851 秒。任务 `wp04-6zcyay` 原容器 `295a12f4d5f79f862bafb09695f8292f079d0562fb03edeb228879f97de3daba` 取消，exit 137，容器 7.029 秒，任务 compute 7.485 秒。最终按操作 label 查询无验收容器残留。

8 项离线专项覆盖配置、配额、确认与冲突、提交掉包、排队与运行断连、历史终态、取消竞态、认证超时、日志及 checkpoint 丢失。两个跨进程 Slurm 实验共享真实 Durable 账本，提交许可前强杀记录 0 个 `sbatch` 调用，响应丢失且模拟作业完成后恢复记录 1 个调用，并结算模拟会计记录中的 8 秒。Docker 专项同时断言固定隔离参数，并拒绝身份不匹配的容器。

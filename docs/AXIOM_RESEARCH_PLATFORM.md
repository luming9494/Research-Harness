# AXIOM WP-13 科研记忆与可观测性平台

Pi 提供原生会话、模型事件和工具调用。TaskController、Pi Durable 与 SQLite 继续保存审批、预算、执行身份和独立评分。WP-13 将已核验的事实投影到 Qdrant、OpenTelemetry 和 MLflow。原矩阵恢复和训练调度沿用既有入口。

## 可信科研记忆

同步先核验冻结计划摘要、原始命令记录、独立评分和产物。允许从指定的开发 Bench 归档导入已复验失败经验。Tiny 学习率经验由固定模板及数值生成。BGE 复用 WP-10.2 的本地固定模型和分词器。Qdrant 集合由本地目录内容定址，点键由运行身份确定。重复写入覆盖同一个点。通过元数据过滤任务条件和已复验状态。索引可从原证据重建。

Qdrant 保存向量及任务键、运行键、条件、摘要和核验状态。检索时以本地固定摘要的目录重新核对每个点，模型只收到本地来源的结构化经验。外部载荷文字、原始日志、留出标签、原始私有路径和凭据均在投影白名单之外。Enhanced Context 将验证结果并入 Experience Memory。无向量服务时继续使用现有 `AXIOM_CONTEXT_EXPERIENCE` 提供的已核验本地经验。

## 轨迹与实验跟踪

- **OTLP。** 用标准 OTLP/HTTP JSON 向本机 Collector 发送 Span。原生 Pi 记录 Session 和模型准入、结算及工具调用。Bench 与账本投影补充操作、后端状态、恢复、独立评价及交付证据。输出仅包含稳定 ID、时间、受控事件类型、状态和摘要。正常会话退出时集中导出，强杀前仅存在于内存的会话事件可能缺失。已提交的操作可以通过归档补导。
- **MLflow。** 同步创建固定 Experiment，按 `axiom.run_id` 查找逻辑运行。写入已核验的 seed、学习率、epoch、独立验证指标、实际计算时间和训练曲线。上传 `axiom-manifest.json`，其中含 checkpoint 摘要及实验、证据和操作身份。权重以摘要引用，保存在原任务目录。冻结科研结果仍以原账本及独立评分为准。
- **对账。** MLflow 创建前独占写入意图。响应丢失时重新查运行标签，对账仍不明确时保留原意图。同步重跑应复用同一 `--out` 回执目录。OTLP 成功后记录 payload 摘要，丢失响应时重发使用同一 Trace/Span ID。Collector 文件可能留下重复原始记录，下游可用这两个 ID 去重。服务错误仅改变投影状态，训练预算和结果照常按 Durable 结算。

## 执行

在本机运行 Qdrant 1.13.6、Collector Contrib 0.119.0 和 MLflow 3.5.1。Qdrant 使用 6333，OTLP HTTP 使用 4318，MLflow 使用 5000，端口均绑定回环。Collector 启用 `otlp.protocols.http` 接收器和 `file` Trace exporter。MLflow 使用单 worker、SQLite 和代理 Artifact 服务。配置 BGE 缓存目录与 Linux 解释器。Windows 上通过 Ubuntu-24.04 WSL 启动固定编码入口。

在 WSL Bash 中，从 AXIOM 仓库根目录创建 Collector 归档目录及配置文件，再启动服务。

```bash
mkdir -p private/wp13/collector
docker run -d --name axiom-wp13-memory --memory 384m --cpus 0.75 \
  -p 127.0.0.1:6333:6333 -e QDRANT__TELEMETRY_DISABLED=true \
  -v axiom-wp13-qdrant:/qdrant/storage \
  qdrant/qdrant@sha256:bd67306b6cc77c98122cada2321eb60b20d00b19d26cb61c86681e7bd5951498
docker run -d --name axiom-wp13-otel --memory 192m --cpus 0.5 \
  -p 127.0.0.1:4318:4318 \
  -v "$PWD/private/wp13/collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  -v "$PWD/private/wp13/collector:/evidence" \
  otel/opentelemetry-collector-contrib@sha256:36c35cc213c0f3b64d6e8a3e844dc90822f00725e0e518eaed5b08bcc2231e72
docker run -d --name axiom-wp13-mlflow --memory 768m --cpus 1 \
  -p 127.0.0.1:5000:5000 -v axiom-wp13-mlflow:/mlflow/data \
  ghcr.io/mlflow/mlflow@sha256:7a8c21cd553b84227391ad7daa39c029dab64328da7607c372370cfa07ef43d9 \
  mlflow server --host 0.0.0.0 --workers 1 --backend-store-uri sqlite:////mlflow/data/tracking.db \
  --serve-artifacts --artifacts-destination /mlflow/data/artifacts
```

`private/wp13/collector.yaml` 内容如下。归档目录需允许容器用户写入。

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  file:
    path: /evidence/collector-traces.jsonl
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file]
```

```powershell
$env:AXIOM_BGE_MODEL = (Resolve-Path private/wp102/bge).Path
$env:AXIOM_BGE_PYTHON = '/absolute/path/to/bge/venv/bin/python'
$plan = 'private/wp112/tiny/plan-3GvDqR'
$sha = '0da3458070c4475d13fdebbc1aa532ade564b340f6ee946b93c81f30a542f272'
$bench = 'private/axiom-bench-wp081/155cb99c-b6aa-4379-b9c4-e899e1fa6335/T3-CTX-02'
$benchSha = '8ab4617ab808af373a22f45a2171303338c91beded1b2b93d4525b1034f65594'
npm run platform:axiom -- sync --plan $plan --sha $sha --bench $bench --bench-sha $benchSha --execution-task wp04-PPfFub --out private/wp13/sync
$env:AXIOM_OTLP_ENDPOINT = 'http://127.0.0.1:4318'
npm run platform:axiom -- compare --paid --plan $plan --sha $sha --bench $bench --bench-sha $benchSha --out private/wp13/agent-v2
```

运行 Enhanced Context 时由操作者设置 `AXIOM_MEMORY_CATALOG` 为绝对路径，`AXIOM_MEMORY_CATALOG_SHA` 为 `sync.json` 中的 `catalogSha`，`AXIOM_QDRANT_ENDPOINT` 为本地地址。三个服务端点可由相应环境变量覆盖，且必须为无凭据的本机 HTTP Origin。操作方负责隔离服务和归档目录。

每轮付费对照使用新的输出目录，运行前先写请求意图。服务可用 `docker start axiom-wp13-memory axiom-wp13-otel axiom-wp13-mlflow` 重新启动。停机时使用同一组容器名执行 `docker stop`，保留数据库、向量和已归档结果。

## 真实验收

在 Windows 11 与 WSL2 Docker Engine 上，三项服务用固定摘要镜像运行。以下资源值为实际同步期间的单次 Docker 采样。

| 服务 | 镜像摘要 | 内存实测 / 上限 | CPU 上限 |
| --- | --- | --- | --- |
| Qdrant 1.13.6 | `sha256:bd67306b6cc77c98122cada2321eb60b20d00b19d26cb61c86681e7bd5951498` | 34.62 / 384 MiB | 0.75 |
| OTLP Collector Contrib 0.119.0 | `sha256:36c35cc213c0f3b64d6e8a3e844dc90822f00725e0e518eaed5b08bcc2231e72` | 57.61 / 192 MiB | 0.5 |
| MLflow 3.5.1 | `sha256:7a8c21cd553b84227391ad7daa39c029dab64328da7607c372370cfa07ef43d9` | 333.9 / 768 MiB | 1 |

Qdrant 写入 10 个点，来源为 WP-11.2 的九个真实训练结果及一个已复验 AST 拒绝案例。MLflow Experiment 1 接收九个完整 Run。Collector 收到真实 Pi Bench 的模型及工具 Span。历史 Docker 任务 `wp04-PPfFub` 的 Trace `3575524e73f5c9686d6b40c6b41e1724` 含四个后端状态、Durable 对账、独立评价和交付。该 Trace 使用 WP-12 的实际容器回执、归档状态及经过 SHA-256 复核的交付，WP-13 同步未重新启动训练。

| 实际三端关联 | 标识 |
| --- | --- |
| SQLite 任务与操作 | `wp04-F2ZBwe`，操作 1、2、3 |
| AXIOM Run | `a3aa96d23fd3f1065079b5e01e50d81347ccd216249525707c4ff302a17aee13` |
| OTLP Trace | `57ae92bb5bf0e5442fc44f39cf5ee621` |
| MLflow Run | `64e63f5319734fd0bd8fd31cdf72b8a1` |
| Qdrant Evidence | `6d6d7ae3-558f-564d-8ec5-08381ca1ff78` |
| 工件清单 SHA-256 | `b2655b14188def62a0187836ce2b9dc419745c7adfd712e77f53cdbb1ab957d8` |

实际回读了 Qdrant 点、Collector 文件、MLflow Tag、MLflow Artifact 内容及 80 个训练曲线点。该 Run 独立验证 accuracy 为 0.705078125，loss 为 0.4490974545478821，原命令累计计算 23.416 秒。终态任务恢复使用 `npm run execute:axiom -- resume --task wp04-F2ZBwe`，原九条操作依然是三次审查、三次训练、三次独立验证。重复同步复用九个 MLflow Run，集合仍为 10 点。

### 真实 Pi 经验检索对照

每组取三条证据，比较原始记录顺序与语义排序。真实 Pi 使用 `deepseek/deepseek-flash`。第二轮把问题收敛为从 seed 43 的三条事实中选择最低验证 loss 的学习率。按冻结指标和 Evidence ID 判题，证据缺失时允许明确弃答。

| 轮次及方式 | 相关召回 | 输入 / 总 Token | Pi 估计 USD | 结果 |
| --- | ---: | ---: | ---: | --- |
| 初试，记录顺序 | 0/3 | 874 / 885 | 0.000237768 | 正确弃答 |
| 初试，语义检索 | 3/3 | 891 / 906 | 0.000210036 | 缺少合格引用 |
| 定向选优，记录顺序 | 0/3 | 879 / 890 | 0.000239268 | 正确弃答 |
| 定向选优，语义检索 | 3/3 | 896 / 934 | 0.000239136 | 正确引用 `82aedc86-74ee-5f45-8e4e-52eab240c5a2` |

每组证据序列化为 1,393 字节。四次供应商请求合计输入 3,540 Token、总计 3,615 Token，Pi 估计 USD 0.000926208，实际账单未知。定向选优运行的真实模型与记忆 Span 已加入被引用实验的 Trace。这是一组小规模证据选择对照，语义检索两轮均增加 17 个输入 Token，任务效果还受模型引用能力影响。

## 验收证据与限制

原始回读、故障与重启结果存于 Git 忽略目录 `private/wp13`。使用 `identity-check.json`、`collector-traces.jsonl`、`sync-first.log`、`sync-outage.log`、`sync-recovered.log`、`agent*/` 和 `resource.log` 复核。四项专项用例覆盖端点和脱敏、伪造向量载荷、OTLP 不可用 / 部分拒绝、MLflow 创建回执丢失及冻结摘要冲突。

三项实际服务停机时，Qdrant 查询退回原本地经验，得到 1 条已核验记录。MLflow 投影的 9 条写入记录不可用，未发送过的 OTLP 请求报告连接失败。重启后复用 9 条 MLflow 运行，Qdrant 点数仍为 10。验收用 Collector 文件在重启时截断，使用独立回执目录重放历史 Trace 后重新核验 89 条 Span。原目录保留成功回执，用于正常去重。计划摘要不匹配时，CLI 在写入外部服务前退出。

当前投影支持已核验的 Tiny CPU 科研矩阵及指定开发失败案例。SciFact 的任务内核沿用原实现。真实 Slurm 集群观测仍为 `pending_external_validation`。本机回环部署及术语检索对照属于当前验收范围。

Windows `npm run check` 通过，`node --test tests/axiom/research-platform.test.mjs` 4/4。WSL2 `npm run build:offline` 通过，`AXIOM_ML_TEST_CONCURRENCY=1 npm run test:ml` 164/164。

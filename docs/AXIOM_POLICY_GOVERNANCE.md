# WP-08.2 · Harness 策略治理

## 契约

Harness Policy Schema v1 包含 `id`、`version`、`schema_version`、`created_at`、`source`、批准基线 SHA-256 和 `settings`。内置 `axiom-approved@1` 是批准基线。操作者版本沿用基线 ID，版本必须大于 1，并引用内置对象的 SHA-256。哈希使用递归排序的 JSON 键，配置身份由 ID、版本和 SHA-256 共同确定。

| 白名单字段 | 作用 |
| --- | --- |
| `prompt` | 选择平衡或证据优先的固定提示片段 |
| `window_tokens`、`priorities` | 调整窗口目标、可裁剪区域顺序 |
| `feedback` | 摘要或结构化工具反馈 |
| `experience_limit` | 限制已复核经验上限 |
| `error_detail` | 调整已解决错误的展示粒度，未解决关键错误保留 |

Schema 逐层拒绝额外字段。控制器继续决定 TaskSpec、硬预算、工具权限、文件访问、训练与评分、恢复与防重。提示片段采用枚举，策略文件里的自由指令不会成为系统提示。原始 Goal 保留在 TaskSpec 和 inspect 数据中，系统窗口和压缩详情只保留其 SHA-256。

## 绑定与回退

新任务在创建阶段读取 `AXIOM_HARNESS_POLICY`。合法配置和 Context 模式随任务审批进入 Durable 账本。文件缺失、损坏、越界或不兼容时，宿主明确告知新任务使用内置批准版本。既有任务从原账本读取和校验策略，无须读取操作者的当前文件。篡改或丢失原身份的绑定会拒绝接管。WP-08.1 及更早账本没有策略字段，可继续按旧入口打开。

可以用源码的 `approvedPolicy(true)` 取得完整基线配置与摘要，再按以下例子创建候选文件。操作者将 `AXIOM_HARNESS_POLICY` 指向文件，并通过 `AXIOM_CONTEXT=enhanced` 启用增强呈现。评测用例也可以选定此文件。

```powershell
node --experimental-strip-types --input-type=module -e "import {mkdirSync,writeFileSync} from 'node:fs'; import {approvedPolicy} from './packages/coding-agent/src/axiom/execution/harness-policy.ts'; const b=approvedPolicy(true); mkdirSync('private',{recursive:true}); writeFileSync('private/policy-v2.json',JSON.stringify({...b.config, version:2, source:'operator', created_at:new Date().toISOString(), baseline_sha256:b.sha256, settings:{...b.config.settings, prompt:'evidence_first', window_tokens:1900}},null,2));"
$env:AXIOM_HARNESS_POLICY = (Resolve-Path private/policy-v2.json).Path
$env:AXIOM_CONTEXT = 'enhanced'
npm run axiom
```

定向回归使用真实 SQLite 任务账本验证。操作者文件从版本 2 换成版本 3 后，原持锁任务和重新打开的任务都使用版本 2，新任务使用版本 3。覆盖额外字段、错误继承、无效版本、匹配摘要与新任务安全回退。

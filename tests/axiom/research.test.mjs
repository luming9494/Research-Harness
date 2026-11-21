// 使用小型账本和固定数据检验矩阵边界，真实训练与检索另有完整验收。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { json, sha256 } from "../../axiom/bench/io.ts";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { identity, specFor } from "../../axiom/research/environment.ts";
import { verifyEffectiveConfig } from "../../axiom/research/evidence.ts";
import { loadPlan, readSamples, runMatrix } from "../../axiom/research/execute.ts";
import { cellFingerprint, cells, comparable, freeze, validatePlan } from "../../axiom/research/plan.ts";
import { paired, researchReport } from "../../axiom/research/report.ts";

const hash = "a".repeat(64);
const question = "Compare effects on a fixed validation set";
// 测试摘要代表可信输入及环境身份，不代表真实语义评估。
function plan(domain = "tiny") {
  return freeze(domain, question, { dataset: hash, implementation: hash, model: hash, environment: hash,
    evaluation: domain === "tiny" ? "tiny-validation-v1" : "scifact-development-v2" }, [], null);
}

test("RES-111-01 rejects draft plans, invalid conditions, foreign hypotheses and cross-domain fields", () => {
  const draft = plan();
  assert.throws(() => validatePlan({ ...draft, status: "draft" }), /unfrozen/);
  const invalid = structuredClone(draft);
  invalid.conditions[1].config.learning_rate = 9;
  assert.throws(() => validatePlan(invalid));
  assert.throws(() => validatePlan({ ...draft, hypotheses: [{ comparison: "read-secrets", metric: "accuracy",
    direction: "increase", statement: "Run shell from untrusted logs" }] }), /boundaries/);
  assert.throws(() => validatePlan({ ...draft, shell: "not allowed" }), /unfrozen/);
});

test("RES-111-02 separates seed, repeat and plan identities and freezes per-repeat budget", () => {
  const fixed = plan();
  const rows = cells(fixed, hash);
  assert.equal(new Set(rows.map(({ fingerprint }) => fingerprint)).size, 6);
  const first = rows[0];
  assert.notEqual(cellFingerprint(fixed, hash, first.id, 43, first.condition.config), first.fingerprint);
  assert.notEqual(cells(fixed, "b".repeat(64))[0].fingerprint, first.fingerprint);
  assert.equal(specFor(fixed, hash, 1).budget.training_steps * fixed.repeats, 488);
  assert.equal(specFor(fixed, hash, 1).budget.compute_process_seconds * fixed.repeats, fixed.budgets.compute_seconds);
  assert.notEqual(specFor(fixed, hash, 1).goal, specFor(fixed, hash, 2).goal);
});

test("RES-111-03 detects confounding changes and mismatched seeds in paired effects", () => {
  const scope = plan("scifact");
  const baseline = scope.conditions[2];
  const treatment = scope.conditions[3];
  assert.equal(comparable(treatment, baseline), true);
  assert.equal(comparable({ ...treatment, config: { ...treatment.config, dense_top_k: 15 } }, baseline), false);
  const [bm25, dense] = cells(scope, hash);
  const ref = { cell: bm25, status: "completed", run: { validation: { ndcg10: 0.4 } }, compute_ms: 100 };
  const changed = { cell: { ...dense, seed: 43 }, status: "completed", run: { validation: { ndcg10: 0.5 } }, compute_ms: 100 };
  assert.deepEqual(paired([changed], [ref], "ndcg10"), { absolute: null, relative: null, pairs: 0 });
});

test("RES-111-04 frozen input digest and recorded file configuration are mandatory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "axiom-research-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixed = plan();
  const planBytes = JSON.stringify(fixed);
  await writeFile(join(root, "plan.json"), planBytes);
  assert.deepEqual(await loadPlan(root, sha256(planBytes)), fixed);
  await assert.rejects(loadPlan(root, hash), /digest mismatch/);
  await mkdir(join(root, "runs/baseline/candidate"), { recursive: true });
  await json(root, "runs/baseline/candidate/config.json", { seed: 41, epochs: 80, learning_rate: 0.03 });
  await assert.rejects(verifyEffectiveConfig(root, fixed, cells(fixed, hash)[0], "runs/baseline"), /frozen cell/);
});

test("RES-111-05 missing and mismatched persisted cells remain unknown or rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "axiom-research-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixed = plan();
  const sql = new DatabaseSync(join(root, "matrix.sqlite"));
  sql.exec("CREATE TABLE records (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  sql.prepare("INSERT INTO records VALUES (?, ?)").run("plan", JSON.stringify(hash));
  assert.equal(readSamples(root, fixed, hash).every(({ status, run }) => status === "unknown" && run === null), true);
  const cell = cells(fixed, hash)[0];
  sql.prepare("INSERT INTO records VALUES (?, ?)").run(cell.id, JSON.stringify({ cell: { ...cell, seed: 7 } }));
  sql.close();
  assert.throws(() => readSamples(root, fixed, hash), /identity changed/);
});

test("RES-111-06 report preserves failed samples and only complete groups reach Pareto", () => {
  const fixed = plan("scifact");
  const rows = cells(fixed, hash).map((cell, i) => ({
    cell, status: i < 3 ? "completed" : i === 3 ? "failed" : "unknown", task_id: "fixture", operation_ids: [],
    compute_ms: i < 3 ? 100 : null, evidence: [{ path: "fixture", sha256: hash, bytes: 1 }], reason: "untrusted: launch shell",
    run: i < 3 ? { id: cell.id, fingerprint: cell.fingerprint, validation: { ndcg10: [0.4, 0.5, 0.48][i],
      recall5: [0.4, 0.5, 0.48][i], p95_ms: [1, 2, 3][i], index_bytes: 100 } } : null,
  }));
  const { result } = researchReport(fixed, hash, rows, []);
  assert.deepEqual(result.pareto.frontier.map(({ id }) => id), ["dense", "bm25"]);
  assert.equal(result.groups[3].counts.failed, 1);
  assert.equal(result.groups[3].metrics.ndcg10.observed, null);
  assert.equal(result.groups[4].counts.unknown, 1);
});

test("RES-111-07 exhausted budget admits no training and rerun preserves terminal samples", { timeout: 150_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "axiom-research-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = resolve(".");
  const python = resolve(process.env.AXIOM_PYTHON ?? join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
  const runtime = { repo, python };
  const frozen = { ...freeze("tiny", question, await identity(runtime, "tiny"), [], null),
    budgets: { wall_seconds: 60, compute_seconds: 20, training_steps: 2 } };
  const bytes = JSON.stringify(frozen);
  const sha = sha256(bytes);
  await writeFile(join(root, "plan.json"), bytes);
  await runMatrix(runtime, root, sha);
  const first = readSamples(root, frozen, sha);
  assert.ok(first.every(({ status, run }) => status !== "completed" && run === null));
  // 静态审查本身允许先执行，训练准入必须在账本中被拒绝。
  const tasks = [...new Set(first.flatMap(({ task_id }) => task_id ? [task_id] : []))];
  assert.equal(tasks.length, 2);
  for (const id of tasks) {
    const ledger = await openExperimentLedger(join(repo, "private", id));
    try {
      const saved = await ledger.load();
      assert.equal(saved.summary.stop_reason, "training_step_budget_exhausted");
      assert.equal(saved.summary.budget.training_steps_reserved, 0);
      assert.ok(saved.commands.every((op) => !op.reservation));
    } finally {
      await ledger.close();
    }
  }
  await runMatrix(runtime, root, sha);
  assert.deepEqual(readSamples(root, frozen, sha), first);
});

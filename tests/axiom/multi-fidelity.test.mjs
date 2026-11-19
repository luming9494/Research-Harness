// WP-06.2 策略、真实 CPU 对照和跨进程故障验收。测试不调用模型 API。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { promisify } from "node:util";
import { decidePromotion } from "../../packages/coding-agent/dist/axiom/execution/fidelity-policy.js";
import { chooseBest, TaskController } from "../../packages/coding-agent/dist/axiom/execution/task-controller.js";
import { DEFAULT_BUDGET, TASK_RULES } from "../../packages/coding-agent/dist/axiom/execution/task-spec.js";

const args = ["--conditions=source", "--experimental-strip-types", "tests/fixtures/axiom-fidelity-worker.ts"];
const exec = promisify(execFile);
const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

async function run(action, id = "") {
  const reply = await exec(process.execPath, [...args, action, id], { timeout: 420_000 });
  return JSON.parse(reply.stdout);
}

async function interrupt(t, action, id = "") {
  const child = spawn(process.execPath, [...args, action, id], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", value => { errors += value; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; lines.close(); });
  const [line] = await Promise.race([
    once(lines, "line", { signal: AbortSignal.timeout(180_000) }),
    exited.then(() => { throw new Error(`Worker exited before interruption: ${errors}`); }),
  ]);
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  return JSON.parse(line);
}

const starts = (commands, id) => commands.filter(op => op.runId === id && op.reservation && op.status !== "not_started");

test("MF-062-01 warmup, exact margins, direction, rank and Full cap", () => {
  assert.equal(decidePromotion(0.3, [0.9], "maximize", true).reason, "warmup");
  assert.equal(decidePromotion(0.85, [0.9, 0.88], "maximize", true).action, "promoted");
  assert.equal(decidePromotion(0.849, [0.9, 0.88], "maximize", true).reason, "trailing_proxy");
  assert.equal(decidePromotion(0.1, [0.03, 0.05], "minimize", true).rank, 3);
  assert.equal(decidePromotion(1, [], "maximize", false).reason, "full_budget");
  assert.throws(() => chooseBest(undefined, { validation: { protocol: "tiny-xor-v1", level: "proxy" } }), /independent validation/);
});

test("MF-062-02 v2 inherited rate stays fixed outside the approved override range", async t => {
  const spec = { task: "tiny-xor-v1", version: 2, goal: "Verify inherited default", rules: TASK_RULES, budget: DEFAULT_BUDGET,
    objective: { metric: "accuracy", direction: "maximize", target: null }, max_revisions: 0,
    parameters: { learning_rate: { min: 0.06, max: 0.08 } } };
  const task = await TaskController.create(resolve("."), python, spec, () => {});
  t.after(() => task.closeLedger());
  const signal = AbortSignal.timeout(30_000);
  const prepared = await task.executor.prepare("exp-1", task.executor.original, "Inherit default", signal);
  assert.equal(prepared.config, undefined);
  const config = JSON.parse(await readFile(join(task.root, "sources/exp-1/config.json"), "utf8"));
  assert.equal(config.learning_rate, 0.03);
  await assert.rejects(task.executor.prepare("exp-2", task.executor.original, "Explicit override", signal, { learning_rate: 0.03 }), /outside approved range/);
  assert.equal(task.budget.trainingSteps, 0);
});

test("MF-062-03 staged CPU comparison uses the same pool and audits each prune against Full", { timeout: 600_000 }, async () => {
  const control = await run("fixed-full");
  const screen = await run("fixed-staged");
  const a = control.snapshot;
  const b = screen.snapshot;
  assert.deepEqual(a.task.budget, b.task.budget);
  assert.deepEqual(a.experiments.map(row => row.fingerprint), b.experiments.map(row => row.fingerprint));
  assert.equal(a.fidelity.full_candidates_started, 4);
  assert.ok(b.fidelity.pruned > 0);
  assert.equal(b.fidelity.full_candidates_started + b.fidelity.pruned, 4);
  assert.equal(a.fidelity.stages.proxy.starts, 0);
  assert.equal(b.fidelity.stages.smoke.starts, 4);
  assert.equal(b.fidelity.stages.proxy.starts, 4);
  const pruned = b.experiments.filter(row => row.status === "pruned");
  const audit = [];
  for (const row of b.experiments) {
    const reference = a.experiments.find(other => other.fingerprint === row.fingerprint);
    assert.equal(reference.validation.level, "full");
    if (row.status === "pruned") {
      assert.equal(row.validation, undefined);
      assert.equal(row.staged.full, undefined);
      assert.equal(row.staged.decision.reason, "trailing_proxy");
      assert.deepEqual(starts(screen.commands, row.id).map(op => op.stage), ["smoke", "proxy"]);
    } else {
      assert.equal(row.validation.accuracy, reference.validation.accuracy);
      assert.equal(row.validation.checkpoint_sha256, reference.validation.checkpoint_sha256);
    }
    audit.push({ id: row.id, proxy: row.staged.proxy.result.validation.accuracy, proxyLoss: row.staged.proxy.result.validation.loss,
      action: row.staged.decision.action, rank: row.staged.decision.rank, full: reference.validation.accuracy, fullLoss: reference.validation.loss });
  }
  const restored = await run("probe", b.task_id);
  assert.deepEqual(restored.commands, screen.commands);
  assert.deepEqual(restored.snapshot.fidelity, b.fidelity);
  assert.equal(restored.snapshot.delivery.best_id, b.best.id);
  assert.deepEqual(restored.snapshot.experiments.filter(row => row.status === "pruned").map(row => row.id), pruned.map(row => row.id));
  console.log(`MF-062-03 ${JSON.stringify({ full: { task: a.task_id, stages: a.fidelity, budget: a.budget, best: a.best.validation },
    multi: { task: b.task_id, stages: b.fidelity, budget: b.budget, best: b.best.validation }, audit })}`);
});

test("MF-062-04 reopens committed Proxy and promotion, then refuses an ambiguous Full launch", { timeout: 320_000 }, async t => {
  const proxy = await interrupt(t, "hold-proxy");
  const decision = await interrupt(t, "hold-decision", proxy.taskId);
  assert.equal(decision.row.staged.proxy.key, proxy.row.staged.proxy.key);
  assert.equal(decision.row.staged.decision.action, "promoted");
  assert.deepEqual(decision.summary.fidelity.stages, proxy.summary.fidelity.stages);
  const unknown = await interrupt(t, "hold-full", proxy.taskId);
  assert.equal(unknown.operation.stage, "full");
  assert.equal(unknown.operation.status, "started");
  const reopened = await run("probe", proxy.taskId);
  assert.equal(reopened.snapshot.status, "needs_reconciliation");
  assert.equal(reopened.snapshot.unconfirmed_training_steps, 80);
  assert.deepEqual(starts(reopened.commands, "exp-1").map(op => op.stage), ["smoke", "proxy", "full"]);
  assert.deepEqual(starts(reopened.commands, "exp-2").map(op => op.status), ["completed", "completed", "unknown"]);
  assert.equal(reopened.snapshot.experiments[1].validation, undefined);
  assert.equal(reopened.snapshot.delivery.best_id, "exp-1");
  const again = await run("probe", proxy.taskId);
  assert.deepEqual(again.commands, reopened.commands);
  assert.deepEqual(again.snapshot.fidelity, reopened.snapshot.fidelity);
  console.log(`MF-062-04 ${proxy.taskId}: Proxy resumed, promotion resumed, unknown Full 80 steps retained`);
});

test("MF-062-05 stage step exhaustion and independent Full quota charge only admitted stages", { timeout: 230_000 }, async () => {
  const { snapshot: steps } = await run("step-budget");
  assert.equal(steps.stop_reason, "training_step_budget_exhausted");
  assert.equal(steps.fidelity.stages.smoke.starts, 0);
  assert.equal(steps.budget.training_steps_reserved, 80);
  const { snapshot: quota, commands } = await run("full-quota");
  assert.equal(quota.fidelity.full_candidates_started, 1);
  assert.equal(quota.experiments[1].staged.decision.reason, "full_budget");
  assert.equal(quota.experiments[1].validation, undefined);
  assert.deepEqual(starts(commands, "exp-2").map(op => op.stage), ["smoke", "proxy"]);
  assert.equal(quota.budget.training_steps_reserved, 204);
  // 重开后相同剪枝候选只复用淘汰记录，既不重新启动阶段，也不进入正式候选集。
  const duplicate = await run("quota-repeat", quota.task_id);
  assert.equal(duplicate.snapshot.experiments[2].status, "pruned");
  assert.equal(duplicate.snapshot.experiments[2].reused_from, "exp-2");
  assert.equal(duplicate.snapshot.experiments[2].validation, undefined);
  assert.deepEqual(starts(duplicate.commands, "exp-3"), []);
  assert.equal(duplicate.snapshot.budget.training_steps_reserved, 204);
  assert.equal(duplicate.snapshot.fidelity.pruned, 1);
});

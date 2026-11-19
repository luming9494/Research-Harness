// Deterministic WP-04 control tests. Fake executor metrics are not real model-optimization evidence.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskBudget } from "../../packages/coding-agent/dist/axiom/execution/task-budget.js";
import { TaskController, chooseBest } from "../../packages/coding-agent/dist/axiom/execution/task-controller.js";
import { tinyEvaluation } from "../../packages/coding-agent/dist/axiom/execution/task-executor.js";
import { DEFAULT_BUDGET, TASK_RULES, validateTaskSpec } from "../../packages/coding-agent/dist/axiom/execution/task-spec.js";

const spec = () => validateTaskSpec({ version: 1, task: "tiny-xor-v1", goal: "Offline test fixture", target_accuracy: null, rules: TASK_RULES, budget: DEFAULT_BUDGET });
const validation = accuracy => ({ split: "validation", level: "full", protocol: "tiny-xor-v1", samples: 512, accuracy, loss: 1 - accuracy, dataset_access_log: ["validation"] });
async function create(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "axiom-task-"));
  const input = spec();
  if (options.target !== undefined) input.target_accuracy = options.target;
  const budget = new TaskBudget(input, options.now);
  options.advance?.();
  const launched = [];
  let deliveries = 0;
  const executor = {
    original: "baseline", config: '{"epochs":80}',
    evaluation: tinyEvaluation(input.target_accuracy), reportNotes: [],
    trainingSteps: role => role === "baseline" ? 80 : 82,
    async verifyEvaluated() {},
    async prepare(id, content, rationale) { return { id, content, rationale, fingerprint: content.trim() }; },
    async run(prepared, role, signal) {
      signal.throwIfAborted();
      launched.push(prepared.id);
      if (prepared.content === "fail") throw new Error("Injected worker failure");
      if (prepared.content === "wait") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return { id: prepared.id, fingerprint: prepared.fingerprint, model: prepared.content, run: prepared.id, validation: validation(prepared.content === "first" ? 0.9 : prepared.content === "second" ? 0.6 : 0.5) };
    },
    async deliver(best) { deliveries++; await writeFile(join(root, "best.fixture"), best.id); return { best_id: best.id }; },
  };
  const task = new TaskController(root, input, budget, executor);
  await task.initialize();
  t.after(async () => { await task.stop("user_cancelled"); await rm(root, { recursive: true, force: true }); });
  return { task, budget, launched, root, deliveries: () => deliveries };
}
const candidate = (task, content, signal) => task.invoke("candidate", { content, rationale: "Scripted fixture; not an autonomous model proposal" }, signal);

test("TaskSpec rejects rule relaxation, unknown fields and invalid budgets", () => {
  for (const value of [0, 4, Infinity, 1.5]) { const input = spec(); input.budget.max_experiments = value; assert.throws(() => validateTaskSpec(input)); }
  const input = spec(); input.rules.evaluation = "final-test";
  assert.throws(() => validateTaskSpec(input), /cannot relax/);
  assert.throws(() => validateTaskSpec({ ...spec(), shell: true }), /exact fields/);
  const original = spec(); const copied = validateTaskSpec(original); original.budget.max_experiments = 3;
  assert.equal(copied.budget.max_experiments, 2);
});

test("launch admission is atomic and failed launches cannot consume extra attempts", () => {
  const input = spec(); input.budget.training_steps = 81;
  const budget = new TaskBudget(input);
  budget.launch("baseline", 80);
  assert.throws(() => budget.launch("candidate", 82), /training_step_budget_exhausted/);
  assert.equal(budget.experiments, 0); assert.equal(budget.trainingSteps, 80);
});

test("Pi usage settles once, releases estimates, includes actual overrun and stops later admission", () => {
  const input = spec(); input.budget.max_tokens = 200;
  const budget = new TaskBudget(input);
  budget.reserveTokens(150); budget.settleTokens(190); budget.settleTokens(190);
  assert.equal(budget.tokens, 190); assert.equal(budget.requests, 1);
  assert.throws(() => budget.reserveTokens(11), /token_budget_exhausted/);
  budget.reserveTokens(10); budget.settleTokens(50);
  assert.equal(budget.tokens, 240);
  assert.throws(() => budget.reserveTokens(1), /token_budget_exhausted/);
  const unknown = new TaskBudget(spec()); unknown.reserveTokens(10); unknown.settleTokens(undefined);
  assert.equal(unknown.uncertain, true); assert.throws(() => unknown.reserveTokens(1), /token_usage_uncertain/);
});

test("two legal experiments reject a third and deliver the first history best, not the last", async t => {
  const { task, budget, launched, root } = await create(t);
  await task.invoke("baseline", {}); await candidate(task, "first"); const final = await candidate(task, "second");
  assert.equal(final.stop_reason, "experiment_budget_exhausted"); assert.equal(final.best.id, "exp-1");
  assert.equal(final.delivery.best_id, "exp-1"); assert.equal(final.final_test_used, false);
  assert.equal(budget.experiments, 2); assert.equal(budget.trainingSteps, 244);
  await assert.rejects(candidate(task, "third"), /Task stopped/);
  assert.deepEqual(launched, ["baseline", "exp-1", "exp-2"]);
  assert.equal(await readFile(join(root, "best.fixture"), "utf8"), "exp-1");
});

test("duplicate structure reuses independent evidence without recharging prior execution", async t => {
  const { task, budget, launched } = await create(t);
  await task.invoke("baseline", {}); await candidate(task, "first");
  const before = budget.snapshot(); const cached = await candidate(task, " first ");
  assert.deepEqual(budget.snapshot().experiments, before.experiments);
  assert.equal(budget.trainingSteps, before.training_steps_reserved);
  assert.equal(budget.computeMs, 0); assert.deepEqual(launched, ["baseline", "exp-1"]);
  assert.equal(cached.experiments[1].status, "cache_hit"); assert.equal(cached.experiments[1].reused_from, "exp-1");
  const final = await candidate(task, "second"); assert.equal(final.delivery.best_id, "exp-1");
});

test("second experiment failure preserves first success, failed row, budget and deterministic report", async t => {
  const { task, budget, root } = await create(t);
  await task.invoke("baseline", {}); await candidate(task, "first"); const result = await candidate(task, "fail");
  assert.equal(result.stop_reason, "execution_failure"); assert.equal(result.delivery.best_id, "exp-1");
  assert.equal(result.experiments[1].status, "failed"); assert.equal(budget.experiments, 2);
  const report = await readFile(join(root, "report.md"), "utf8");
  assert.match(report, /failed/); assert.match(report, /\|\n\|/);
});

test("cancel aborts in-flight experiment and prevents already queued next experiment", async t => {
  const { task, launched, deliveries } = await create(t);
  await task.invoke("baseline", {}); await candidate(task, "first");
  const running = candidate(task, "wait");
  while (launched.length < 3) await new Promise(resolve => setTimeout(resolve, 1));
  const queued = candidate(task, "second");
  const rejection = assert.rejects(queued, /Task stopped/);
  const stopped = task.stop("user_cancelled"); await running; await rejection;
  const result = await stopped;
  assert.equal(result.status, "cancelled"); assert.equal(result.delivery.best_id, "exp-1");
  assert.deepEqual(launched, ["baseline", "exp-1", "exp-2"]); assert.equal(deliveries(), 1);
});

test("wall exhaustion rejects later work and still delivers prior baseline", async t => {
  let now = 0;
  const { task, launched } = await create(t, { now: () => now });
  await task.invoke("baseline", {}); now = 600_001;
  const result = await candidate(task, "first");
  assert.equal(result.stop_reason, "wall_budget_exhausted"); assert.equal(result.delivery.best_id, "baseline");
  assert.deepEqual(launched, ["baseline"]);
});

test("deadline actively aborts work without requiring polling or a further tool request", async t => {
  let now = 0;
  const { task, launched } = await create(t, { now: () => now, advance: () => { now = 599_980; } });
  // The injected clock leaves 20ms until the real deadline timer fires.
  const result = await task.invoke("baseline", {});
  if (!task.stopped) {
    const pending = candidate(task, "wait");
    await pending;
  }
  const final = task.snapshot();
  assert.equal(final.stop_reason, "wall_budget_exhausted");
  assert.ok(launched.length <= 2); assert.equal(result.final_test_used, false);
});

test("configured validation target terminates without a model deciding to finish", async t => {
  const { task, launched } = await create(t, { target: 0.8 });
  await task.invoke("baseline", {}); const result = await candidate(task, "first");
  assert.equal(result.stop_reason, "validation_target_reached"); assert.equal(result.delivery.best_id, "exp-1");
  await assert.rejects(candidate(task, "second"), /Task stopped/); assert.equal(launched.length, 2);
});

test("final-test, invalid evidence and ties cannot replace validated history best", () => {
  const current = { id: "a", validation: validation(0.8) };
  assert.equal(chooseBest(current, { id: "tie", validation: validation(0.8) }).id, "a");
  for (const patch of [{ split: "final-test" }, { accuracy: NaN }, { dataset_access_log: ["train", "validation"] }]) assert.throws(() => chooseBest(current, { validation: { ...validation(0.9), ...patch } }), /independent validation/);
});

test("model tool inputs cannot override the approved task or training config", async t => {
  const { task } = await create(t);
  await assert.rejects(task.invoke("baseline", { max_experiments: 20 }), /Permission denied/);
  await assert.rejects(task.invoke("candidate", { content: "first", rationale: "x", split: "final-test" }), /Permission denied/);
  assert.equal(task.budget.experiments, 0);
});

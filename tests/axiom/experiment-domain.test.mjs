// 用延迟最小化测试适配器验证通用内核，不将合成结果当成科研验收。
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { ExperimentFailure } from "../../packages/coding-agent/dist/axiom/execution/experiment-domain.js";
import { TaskController } from "../../packages/coding-agent/dist/axiom/execution/task-controller.js";
import { DEFAULT_BUDGET, TASK_RULES, validateTaskSpec } from "../../packages/coding-agent/dist/axiom/execution/task-spec.js";

const evidence = Type.Object({ method: Type.Literal("fixture-latency"), latency_ms: Type.Number({ minimum: 0, maximum: 100 }) }, { additionalProperties: false });
const spec = { version: 1, task: "latency-fixture", goal: "Minimize measured fixture latency", budget: DEFAULT_BUDGET, max_revisions: 1 };
const taskSchema = Type.Literal(spec.task);
const repo = resolve(".");
const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

async function fixture(t, taskSpec = spec) {
  let state;
  const launched = [];
  const open = async () => ({
    async load() { return structuredClone(state); },
    async save(value) { state = structuredClone(value); },
    async close() {},
  });
  const domain = {
    id: spec.task, version: 1,
    validateSpec(value) {
      assert.ok(Check(taskSchema, value.task));
      return structuredClone(taskSpec);
    },
    acceptsLegacy: () => false,
    async open({ root, saved }) {
      const adapter = {
        original: "50", config: "latency fixture",
        evaluation: {
          objectives: [{ metric: "latency_ms", direction: "minimize", min: 0, max: 100, target: 20 }],
          validate(value) {
            if (!Check(evidence, value)) throw new ExperimentFailure("evidence_integrity", "Invalid latency evidence");
            return value;
          },
        },
        reportNotes: ["Synthetic latency fixture"],
        trainingSteps: () => 1,
        async prepare(id, content, rationale) {
          if (content === "policy") throw new ExperimentFailure("permission_violation", "Resource denied");
          return { id, content, rationale, fingerprint: content.trim() };
        },
        async run(candidate) {
          launched.push(candidate.id);
          // 受信适配器已确认没有未结算的外部操作，允许一次新候选修订。
          if (candidate.content === "retry") throw new ExperimentFailure("domain_execution", "Confirmed fixture refusal");
          if (candidate.content === "unknown") throw new ExperimentFailure("external_unknown", "Fixture has no completed receipt");
          if (candidate.content === "unexpected") throw new Error("Unexpected fixture error");
          const validation = { method: "fixture-latency", latency_ms: Number(candidate.content) };
          adapter.evaluation.validate(validation);
          const run = join(root, candidate.id);
          await writeFile(run, JSON.stringify(validation));
          return { id: candidate.id, fingerprint: candidate.fingerprint, run, validation };
        },
        async deliver(best) {
          await adapter.verifyEvaluated(best);
          return { best_id: best.id };
        },
        async verifyEvaluated(run) {
          assert.deepEqual(JSON.parse(await readFile(run.run, "utf8")), run.validation);
        },
        async verifyDelivery(best, manifest) { assert.equal(manifest.best_id, best.id); },
        isReadOnly() { return false; },
        checkpoint() { return { fixture: "latency" }; },
      };
      if (saved) assert.deepEqual(saved, adapter.checkpoint());
      return adapter;
    },
  };
  const task = await TaskController.create(repo, process.execPath, taskSpec, () => {}, {
    open, approval: { approvedAt: new Date().toISOString(), sessionId: "latency-fixture" },
  }, domain);
  t.after(() => task.closeLedger());
  return { task, domain, open, launched };
}

const submit = (task, content) => task.invoke("candidate", { content, rationale: "Synthetic acceptance fixture" });

test("EXP-061-02 a second adapter minimizes its own metric after typed failure and resume", async t => {
  const { task, domain, open, launched } = await fixture(t);
  await task.invoke("baseline", {});
  const retry = await submit(task, "retry");
  assert.equal(retry.status, "running");
  assert.equal(retry.failure_category, "domain_execution");
  assert.equal(retry.revisions_used, 1);
  await task.closeLedger();
  const options = [repo, process.execPath, retry.task_id, open, () => {}];
  await assert.rejects(TaskController.resume(...options, { ...domain, version: 2 }), /Incompatible experiment adapter/);
  const restored = await TaskController.resume(...options, domain);
  t.after(() => restored.closeLedger());
  const result = await submit(restored, "10");
  assert.equal(result.stop_reason, "validation_target_reached");
  assert.equal(result.best.validation.latency_ms, 10);
  assert.equal(result.delivery.best_id, "exp-2");
  assert.deepEqual(launched, ["baseline", "exp-1", "exp-2"]);
  assert.match(await readFile(join(task.root, "report.md"), "utf8"), /latency_ms/);
});

test("EXP-061-03 permission, unknown side effects, invalid evidence and unexpected errors must stop", async t => {
  for (const [content, category] of [["policy", "permission_violation"], ["unknown", "external_unknown"], ["101", "evidence_integrity"], ["unexpected", "domain_execution"]]) {
    const { task } = await fixture(t);
    await task.invoke("baseline", {});
    const result = await submit(task, content);
    assert.equal(result.failure_category, category);
    assert.equal(task.stopped, true);
    assert.equal(result.revisions_used, 0);
    await assert.rejects(submit(task, "10"), /Task stopped/);
  }
  // 已知失败不会因重开账本而重新训练。同样的指纹也不消耗新的实验额度。
  const failed = await fixture(t);
  await failed.task.invoke("baseline", {});
  const before = await submit(failed.task, "retry");
  await failed.task.closeLedger();
  const restored = await TaskController.resume(repo, process.execPath, before.task_id, failed.open, () => {}, failed.domain);
  t.after(() => restored.closeLedger());
  const repeat = await submit(restored, "retry");
  assert.equal(repeat.failure_category, "invalid_candidate");
  assert.equal(repeat.budget.experiments, 1);
  assert.deepEqual(failed.launched, ["baseline", "exp-1"]);
  // 额度虽准许一次修订，训练步耗尽仍必须停止。
  const exhausted = await fixture(t, { ...spec, budget: { ...spec.budget, training_steps: 2 } });
  await exhausted.task.invoke("baseline", {});
  const stopped = await submit(exhausted.task, "retry");
  assert.equal(stopped.stop_reason, "training_step_budget_exhausted");
  assert.equal(stopped.revisions_used, 0);
});

test("EXP-061-04 v1 cannot gain learning-rate permissions and v2 rejects unapproved fields", async t => {
  const legacy = { version: 1, task: "tiny-xor-v1", target_accuracy: null, goal: "Policy boundary", rules: TASK_RULES, budget: DEFAULT_BUDGET };
  const current = { version: 2, task: legacy.task, objective: { metric: "accuracy", direction: "maximize", target: null },
    goal: legacy.goal, rules: TASK_RULES, budget: DEFAULT_BUDGET, max_revisions: 1,
    parameters: { learning_rate: { min: 0.01, max: 0.08 } } };
  assert.throws(() => validateTaskSpec({ ...legacy, parameters: current.parameters }), /exact fields/);
  assert.throws(() => validateTaskSpec({ ...current, parameters: { learning_rate: { min: 0.08, max: 0.01 } } }), /range/);
  assert.throws(() => validateTaskSpec({ ...current, parameters: { seed: { min: 1, max: 2 } } }), /exact fields/);
  for (const [spec, parameters] of [[legacy, { learning_rate: 0.03 }], [current, { seed: 42 }]]) {
    const task = await TaskController.create(repo, python, spec, () => {});
    t.after(() => task.closeLedger());
    // 直接从适配器入口验证策略发生在结构审查及训练进程之前。
    await assert.rejects(
      task.executor.prepare("exp-1", task.executor.original, "Unauthorized parameter", AbortSignal.timeout(5000), parameters),
      error => error.category === "permission_violation",
    );
    assert.equal(task.budget.experiments, 0);
    await assert.rejects(readFile(join(task.root, "events.jsonl")), { code: "ENOENT" });
  }
});

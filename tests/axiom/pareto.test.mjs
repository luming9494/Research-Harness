// 确定性算法和真实 CPU 对照，使用原生 Durable 跨进程恢复。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { promisify } from "node:util";
import { chooseParetoDelivery, paretoFrontier, paretoPoint } from "../../packages/coding-agent/dist/axiom/execution/pareto.js";
import { DEFAULT_BUDGET, TASK_RULES, validateTaskSpec } from "../../packages/coding-agent/dist/axiom/execution/task-spec.js";

const objectives = [
  { metric: "accuracy", direction: "maximize", min: 0, max: 1, target: null, resolution: 1e-12 },
  { metric: "parameters", direction: "minimize", min: 1, max: 1024, target: null, integer: true },
];
const protocol = { objectives, validate: value => value };
const point = (id, accuracy, parameters) => ({ id, fingerprint: id, metrics: { accuracy, parameters } });
const [a, b, c, d] = [point("a", 0.9, 100), point("b", 0.8, 50), point("c", 0.7, 75), point("d", 0.90000000000001, 100)];
const fixture = ["--conditions=source", "--experimental-strip-types", "tests/fixtures/axiom-pareto-worker.ts"];
const exec = promisify(execFile);
const run = (mode, id) => exec(process.execPath, [...fixture, mode, id], { timeout: 180_000 }).then(({ stdout }) => JSON.parse(stdout));

test("PF-063-01 mixed dominance, quantized equality and permutation invariance", () => {
  for (const order of [[a, b, c, d], [d, c, b, a], [b, d, a, c]]) {
    assert.deepEqual(paretoFrontier(order, objectives), [a, b]);
  }
  const loss = { metric: "loss", direction: "minimize", min: 0, max: 1e6, target: null, resolution: 1e-9 };
  const larger = { ...a, metrics: { ...a.metrics, loss: 0.02 } };
  const smaller = { ...b, metrics: { ...b.metrics, loss: 0.04 } };
  assert.deepEqual(paretoFrontier([smaller, larger], [...objectives, loss]), [larger, smaller]);
});

test("PF-063-02 invalid or missing objectives and Proxy cannot enter the formal set", () => {
  const valid = { id: "a", fingerprint: "a", run: "a", validation: { level: "full", accuracy: 0.9, parameters: 100 } };
  assert.deepEqual(paretoPoint(valid, protocol), a);
  assert.throws(() => paretoPoint({ ...valid, validation: { ...valid.validation, level: "proxy" } }, protocol), /Full/);
  for (const patch of [{ accuracy: 1.01 }, { accuracy: Infinity }, { accuracy: NaN }, { parameters: undefined }, { parameters: 0 }, { parameters: 1.5 }])
    assert.throws(() => paretoPoint({ ...valid, validation: { ...valid.validation, ...patch } }, protocol), /Invalid Pareto metric/);
});

test("PF-063-03 delivery policies, strict floor and v4 approval boundaries", () => {
  assert.equal(chooseParetoDelivery([a, b], objectives, { strategy: "quality" }).primary, "a");
  assert.equal(chooseParetoDelivery([a, b], objectives, { strategy: "lightweight" }).primary, "b");
  assert.equal(chooseParetoDelivery([a, b], objectives, { strategy: "minimum_accuracy", minimum_accuracy: 0.85 }).primary, "a");
  assert.equal(chooseParetoDelivery([a, b], objectives, { strategy: "minimum_accuracy", minimum_accuracy: 0.95 }).reason, "no_feasible_candidate");
  assert.deepEqual(chooseParetoDelivery([a, b], objectives, { strategy: "frontier" }).selected, [a, b]);
  const valid = { version: 4, task: "tiny-xor-v1", goal: "Schema test", rules: TASK_RULES, budget: DEFAULT_BUDGET,
    max_revisions: 0, objectives: ["accuracy", "parameters", "loss"], delivery_preference: { strategy: "quality" },
    fidelity: { strategy: "full_only", max_full: 1 } };
  assert.deepEqual(validateTaskSpec(valid), valid);
  assert.throws(() => validateTaskSpec({ ...valid, fidelity: { ...valid.fidelity, strategy: "multi_fidelity" } }), /Invalid Tiny TaskSpec/);
  assert.throws(() => validateTaskSpec({ ...valid, objectives: ["accuracy", "accuracy"] }), /Invalid Tiny TaskSpec/);
  assert.throws(() => validateTaskSpec({ ...valid, objective: { metric: "accuracy" } }), /Invalid Tiny TaskSpec/);
});

test("PF-063-04 real CPU frontier, durable budget and per-member delivery integrity", { timeout: 280_000 }, async t => {
  const child = spawn(process.execPath, [...fixture, "hold"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", value => { errors += value; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; lines.close(); });
  const [line] = await Promise.race([
    once(lines, "line", { signal: AbortSignal.timeout(120_000) }),
    exited.then(() => { throw new Error(`Worker exited before interruption: ${errors}`); }),
  ]);
  const { before: original } = JSON.parse(line);
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  const { before, after, commands } = await run("continue", original.task_id);
  assert.deepEqual(before.pareto, original.pareto);
  assert.equal(before.budget.training_steps_reserved, 160);
  assert.equal(after.budget.training_steps_reserved, 320);
  assert.equal(after.stop_reason, "full_budget_exhausted");
  assert.deepEqual(commands.filter(op => op.reservation).map(op => op.runId), ["baseline", "exp-1", "exp-4", "exp-5"]);
  assert.equal(after.experiments[1].failure_category, "invalid_candidate");
  assert.equal(after.experiments[2].reused_from, "exp-1");
  assert.equal(after.fidelity.stages.proxy.starts, 0);
  assert.ok(after.pareto.frontier.length >= 2);
  const actual = [after.baseline, ...after.experiments.filter(row => row.status === "evaluated")].map(row =>
    ({ id: row.id, accuracy: row.validation.accuracy, parameters: row.validation.parameters, loss: row.validation.loss }));
  assert.deepEqual(actual.map(row => row.parameters), [6, 12, 42, 354]);
  const preferences = [
    { strategy: "quality" }, { strategy: "lightweight" }, { strategy: "minimum_accuracy", minimum_accuracy: 0.95 },
    { strategy: "frontier" },
  ].map(preference => chooseParetoDelivery(after.pareto.frontier, objectives, preference));
  assert.equal(preferences[1].primary, "baseline");
  assert.deepEqual(after.pareto.decision, preferences[3]);
  assert.deepEqual(after.delivery.members.map(item => item.id), after.pareto.frontier.map(item => item.id));
  for (const item of after.delivery.members)
    await access(join(after.workspace, "pareto-delivery", item.id, "checkpoint.pt"));
  const { after: reopened } = await run("probe", original.task_id);
  assert.deepEqual(reopened.pareto, after.pareto);
  assert.deepEqual(reopened.budget, after.budget);
  assert.deepEqual(reopened.delivery, after.delivery);
  // 篡改非主模型副本也必须拒绝恢复，恢复原字节后保留验收证据。
  const file = join(after.workspace, "pareto-delivery", after.delivery.members.at(-1).id, "checkpoint.pt");
  const good = await readFile(file);
  await writeFile(file, Buffer.concat([good, Buffer.from("corrupt")]));
  try { await assert.rejects(run("probe", original.task_id), /checkpoint changed/); }
  finally { await writeFile(file, good); }
  console.log(`PF-063-04 ${JSON.stringify({ task: after.task_id, actual, single: after.best.id, pareto: after.pareto, preferences, budget: after.budget })}`);
});

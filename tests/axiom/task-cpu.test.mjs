// Real local CPU WP-04 calibration; candidates are human-authored, never an autonomous/API claim.
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runProcess } from "../../packages/coding-agent/dist/axiom/execution/process.js";
import { TaskController } from "../../packages/coding-agent/dist/axiom/execution/task-controller.js";
import { DEFAULT_BUDGET, TASK_RULES, sha256 } from "../../packages/coding-agent/dist/axiom/execution/task-spec.js";

const repo = resolve(".");
const python = process.env.AXIOM_PYTHON || join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mlp = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.Tanh(), nn.Linear(8, 2))\n";
const weak = "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 2))\n";

test("real CPU: dedup, two experiments, degraded last model and independently reloadable history best", { timeout: 180000 }, async t => {
  const task = await TaskController.create(repo, python, { version: 1, task: "tiny-xor-v1", goal: "Human-authored offline two-round calibration", target_accuracy: null, rules: TASK_RULES, budget: DEFAULT_BUDGET }, () => {});
  t.after(() => task.stop("user_cancelled"));
  console.log(`AXIOM WP-04 real CPU evidence: ${task.root}`);
  const baseline = await task.invoke("baseline", {});
  assert.equal(baseline.status, "running"); assert.equal(baseline.baseline.validation.accuracy, 0.5);
  const first = await task.invoke("candidate", { content: mlp, rationale: "Offline nonlinear XOR fixture, not autonomous discovery" });
  assert.equal(first.status, "running"); assert.ok(first.best.validation.accuracy > 0.9);
  const before = task.budget.snapshot();
  const cached = await task.invoke("candidate", { content: `# Same AST, formatting only\n${mlp}`, rationale: "Check structural AST cache; do not retrain" });
  assert.equal(cached.experiments[1].status, "cache_hit"); assert.equal(cached.experiments[1].reused_from, "exp-1");
  assert.equal(task.budget.experiments, before.experiments); assert.equal(task.budget.trainingSteps, before.training_steps_reserved);
  // New AST-review startup is real overhead and is charged once; previous training/evaluation is not charged again.
  assert.ok(task.budget.computeMs / 1000 >= before.compute_process_seconds);
  assert.ok(!(await readdir(join(task.root, "runs"))).includes("exp-2"));
  const final = await task.invoke("candidate", { content: weak, rationale: "Intentionally degraded second unique candidate" });
  assert.equal(final.stop_reason, "experiment_budget_exhausted"); assert.equal(final.delivery.best_id, "exp-1");
  assert.equal(final.experiments[2].id, "exp-3"); assert.ok(final.experiments[2].validation.accuracy < final.best.validation.accuracy);
  assert.equal(final.budget.experiments, 2); assert.equal(final.budget.training_steps_reserved, 244); assert.equal(final.final_test_used, false);
  await assert.rejects(task.invoke("candidate", { content: mlp, rationale: "Forbidden third unique training" }), /Task stopped/);
  const delivered = await readFile(join(task.root, "best_model.pt"));
  assert.equal(sha256(delivered), first.best.validation.checkpoint_sha256);
  assert.equal(await readFile(join(task.root, "model.py"), "utf8"), mlp);
  const reloaded = await runProcess(python, [join(repo, "examples/tiny-ml-eval/validate_only.py"), "--run", join(task.root, "best")], { cwd: task.root, home: join(task.root, "tmp"), timeoutMs: 60000 });
  assert.equal(reloaded.code, 0, reloaded.stderr);
  const evidence = JSON.parse(reloaded.stdout);
  assert.equal(evidence.accuracy, first.best.validation.accuracy); assert.deepEqual(evidence.dataset_access_log, ["validation"]);
  for (const name of ["task-spec.json", "trusted-inputs.json", "summary.json", "experiments.json", "report.md", "events.jsonl", "patch.diff", "best_model.pt", "model.py", "config.json"]) assert.ok((await readFile(join(task.root, name))).length > 0);
});

test("real CPU wall deadline stops work and rejects any subsequent launch", { timeout: 45000 }, async t => {
  const task = await TaskController.create(repo, python, { version: 1, task: "tiny-xor-v1", goal: "Real wall-deadline regression", target_accuracy: null, rules: TASK_RULES, budget: { ...DEFAULT_BUDGET, wall_seconds: 10 } }, () => {});
  t.after(async () => { await task.stop("user_cancelled"); await rm(task.root, { recursive: true, force: true }); });
  await task.invoke("baseline", {});
  if (!task.stopped) await task.invoke("candidate", { content: mlp, rationale: "Deadline may interrupt this real CPU experiment" });
  if (!task.stopped) await new Promise(resolve => setTimeout(resolve, Math.max(1, task.budget.remainingWallMs + 50)));
  const final = await task.stop("wall_budget_exhausted");
  assert.equal(final.stop_reason, "wall_budget_exhausted"); assert.equal(final.status, "budget_exhausted");
  const before = await readdir(join(task.root, "commands"));
  await assert.rejects(task.invoke("candidate", { content: weak, rationale: "Must not start" }), /Task stopped/);
  assert.deepEqual(await readdir(join(task.root, "commands")), before);
});

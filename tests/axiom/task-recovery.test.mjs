// 用真实 CPU 训练和确定性进程终止验证 WP-05.2，不调用模型 API。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const fixture = fileURLToPath(new URL("../fixtures/axiom-cpu-recovery-worker.ts", import.meta.url));
const args = ["--conditions=source", "--experimental-strip-types", fixture];
const exec = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");

// 父进程只在子进程报告已提交状态后强制终止，避免依赖固定等待时间。
async function start(t, mode) {
  const child = spawn(process.execPath, [...args, mode], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  t.after(async () => { child.kill("SIGKILL"); await exited; lines.close(); });
  const ready = await Promise.race([
    once(lines, "line", { signal: AbortSignal.timeout(120_000) }).then(([line]) => JSON.parse(line)),
    exited.then(() => { throw new Error(`Worker exited before durable checkpoint: ${stderr}`); }),
  ]);
  return { child, exited, ...ready };
}

async function invoke(mode, id) {
  const result = await exec(process.execPath, [...args, mode, id], { timeout: 120_000 });
  return JSON.parse(result.stdout);
}

test("WP-05.2 resumes real CPU experiments without rerunning baseline or committed candidates", { timeout: 240_000 }, async t => {
  const { child, exited, taskId, ready } = await start(t, "start");
  assert.equal(ready.status, "running");
  assert.equal(ready.task_id, taskId);
  assert.equal(ready.baseline.validation.accuracy, 0.5);
  assert.equal(ready.best.id, "exp-1");
  assert.ok(ready.best.validation.accuracy > 0.9);
  const commandDir = join(ready.workspace, "commands");
  const files = await readdir(commandDir);
  const previous = await Promise.all(files.map(async name => [name, hash(await readFile(join(commandDir, name)))]));
  assert.equal(ready.budget.training_steps_reserved, 162);
  assert.equal(ready.budget.experiments, 1);
  assert.equal(ready.budget.tokens_actual, 123);
  await assert.rejects(invoke("probe", taskId), /AXIOM task already has an active owner/);
  assert.equal(child.kill("SIGKILL"), true);
  await exited;

  // 恢复后复用已验证基线和相同结构，只训练剩余的唯一候选。
  const { before, after } = await invoke("resume", taskId);
  assert.equal(before.task_id, taskId);
  assert.equal(before.deadline, ready.deadline);
  assert.deepEqual(before.best, ready.best);
  assert.deepEqual(before.experiments, ready.experiments);
  const { wall_seconds: restoredWall, ...restoredBudget } = before.budget;
  const { wall_seconds: oldWall, ...oldBudget } = ready.budget;
  assert.deepEqual(restoredBudget, oldBudget);
  assert.ok(restoredWall >= oldWall);
  assert.equal(after.stop_reason, "experiment_budget_exhausted");
  assert.equal(after.delivery.best_id, "exp-1");
  assert.equal(after.experiments[1].status, "cache_hit");
  assert.equal(after.experiments[1].reused_from, "exp-1");
  assert.equal(after.experiments[2].id, "exp-3");
  assert.ok(after.experiments[2].validation.accuracy < after.best.validation.accuracy);
  assert.equal(after.budget.experiments, 2);
  assert.equal(after.budget.training_steps_reserved, 244);
  assert.equal(after.budget.tokens_actual, 123);
  assert.equal(after.budget.model_requests, 1);
  assert.equal(after.final_test_used, false);
  for (const [name, digest] of previous) assert.equal(hash(await readFile(join(commandDir, name))), digest);
  const commands = await Promise.all((await readdir(commandDir)).map(async name => JSON.parse(await readFile(join(commandDir, name), "utf8"))));
  const launches = commands.filter(command => command.script === "experiment.py").map(command => command.runId);
  assert.deepEqual(launches, ["baseline", "exp-1", "exp-3"]);

  // 预算耗尽后再次恢复也不能启动额外训练，交付副本仍能独立评分。
  const terminal = await invoke("probe", taskId);
  assert.equal(terminal.before.stop_reason, "experiment_budget_exhausted");
  assert.deepEqual(terminal.before.delivery, after.delivery);
  await assert.rejects(invoke("resume", taskId), /Task stopped/);
  assert.equal((await readdir(commandDir)).length, commands.length);
  const artifact = join(ready.workspace, "best_model.pt");
  const weight = await readFile(artifact);
  assert.equal(hash(weight), after.delivery.checkpoint_sha256);
  const python = process.env.AXIOM_PYTHON || join(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const { stdout } = await exec(python, ["examples/tiny-ml-eval/validate_only.py", "--run", join(ready.workspace, "best")], { timeout: 60_000 });
  const validation = JSON.parse(stdout);
  assert.equal(validation.checkpoint_sha256, after.delivery.checkpoint_sha256);
  assert.equal(validation.accuracy, after.best.validation.accuracy);
  assert.deepEqual(validation.dataset_access_log, ["validation"]);
  try {
    await writeFile(artifact, Buffer.concat([weight, Buffer.from("altered")]));
    await assert.rejects(invoke("probe", taskId), /Delivered best_model.pt changed/);
  } finally {
    await writeFile(artifact, weight);
  }
  console.log(`WP-05.2 evidence: ${ready.workspace}; training=${launches.join(",")}; steps 162->244; tokens 123->123; best=${after.delivery.checkpoint_sha256}`);
});

test("WP-05.2 retains unconfirmed model reservation and refuses replay after restart", { timeout: 45_000 }, async t => {
  const { child, exited, taskId, ready } = await start(t, "reserve");
  assert.equal(ready.budget.tokens_admission_estimate, 1500);
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  const { before } = await invoke("probe", taskId);
  assert.equal(before.status, "needs_reconciliation");
  assert.equal(before.budget.tokens_admission_estimate, 1500);
  assert.equal(before.budget.usage_uncertain, true);
  assert.equal(before.budget.model_requests, 1);
  assert.deepEqual(await readdir(join(ready.workspace, "commands")), []);
  await assert.rejects(invoke("resume", taskId), /Task stopped/);
});

test("WP-05.2 never treats unconfirmed real worker output as a successful experiment", { timeout: 150_000 }, async t => {
  const { child, exited, taskId, ready } = await start(t, "hold-worker");
  const root = ready.workspace;
  const commands = await readdir(join(root, "commands"));
  assert.equal(commands.length, 2);
  // Python 已写出权重，存在文件仍不足以认定独立 validation 完成。
  assert.ok((await readFile(join(root, "runs", "baseline", "checkpoint.pt"))).length > 0);
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  const { before } = await invoke("probe", taskId);
  assert.equal(before.status, "needs_reconciliation");
  assert.equal(before.stop_reason, "operation_unconfirmed");
  assert.equal(before.baseline, undefined);
  assert.equal(before.best, undefined);
  assert.equal(before.budget.training_steps_reserved, 80);
  assert.deepEqual(await readdir(join(root, "commands")), commands);
  await assert.rejects(invoke("resume", taskId), /Task stopped/);
});

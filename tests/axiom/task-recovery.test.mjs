// 用真实 CPU 训练和确定性进程终止验证 WP-05.2，不调用模型 API。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const fixture = fileURLToPath(new URL("../fixtures/axiom-cpu-recovery-worker.ts", import.meta.url));
const args = ["--conditions=source", "--experimental-strip-types", fixture];
const exec = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");

// 父进程只在子进程报告已提交状态后强制终止，避免依赖固定等待时间。
async function start(t, mode, env = process.env) {
  const child = spawn(process.execPath, [...args, mode], { env, stdio: ["ignore", "pipe", "pipe"] });
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

async function invoke(mode, id = "", env = process.env) {
  const result = await exec(process.execPath, [...args, mode, id], { env, timeout: 120_000 });
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
  // DUR-053-05：同一已结算终态重开多次，墙钟和其他预算完全一致。
  assert.deepEqual(terminal.before.budget, after.budget);
  const terminalAgain = await invoke("probe", taskId);
  assert.equal(terminalAgain.before.ended_at, after.ended_at);
  assert.deepEqual(terminalAgain.before.budget, after.budget);
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
    // DUR-053-09：交付副本损坏会被哈希校验拒绝。
    await writeFile(artifact, Buffer.concat([weight, Buffer.from("altered")]));
    await assert.rejects(invoke("probe", taskId), /Delivered best_model.pt changed/);
  } finally {
    await writeFile(artifact, weight);
  }
  console.log(`WP-05.2 evidence: ${ready.workspace}; training=${launches.join(",")}; steps 162->244; tokens 123->123; best=${after.delivery.checkpoint_sha256}`);
});

test("DUR-053-06 WP-05.2 retains unconfirmed model reservation and refuses replay after restart", { timeout: 45_000 }, async t => {
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

test("DUR-053-03 WP-05.2 never treats unconfirmed real worker output as a successful experiment", { timeout: 150_000 }, async t => {
  const { child, exited, taskId, ready } = await start(t, "hold-worker");
  const root = ready.workspace;
  const commands = await readdir(join(root, "commands"));
  assert.equal(commands.length, 2);
  // Python 已写出权重，存在文件仍不足以认定独立 validation 完成。
  assert.ok((await readFile(join(root, "runs", "baseline", "checkpoint.pt"))).length > 0);
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  const { before, commands: ledger } = await invoke("probe", taskId);
  assert.equal(before.status, "needs_reconciliation");
  assert.equal(before.stop_reason, "operation_unconfirmed");
  assert.equal(before.baseline, undefined);
  assert.equal(before.best, undefined);
  assert.equal(before.budget.training_steps_reserved, 80);
  assert.equal(before.unconfirmed_training_steps, 80);
  assert.equal(ledger.at(-1).status, "unknown");
  assert.deepEqual(await readdir(join(root, "commands")), commands);
  await assert.rejects(invoke("resume", taskId), /Task stopped/);
});

test("DUR-053-02 durable intent without worker authorization permits safe baseline recovery", { timeout: 150_000 }, async t => {
  const { child, exited, taskId, ready } = await start(t, "hold-intent");
  assert.equal(ready.budget.training_steps_reserved, 80);
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  const { before, after, commands } = await invoke("baseline-only", taskId);
  assert.equal(before.status, "running");
  assert.equal(before.budget.training_steps_reserved, 0);
  assert.equal(commands.find(op => op.script === "experiment.py").status, "not_started");
  assert.equal(commands.filter(op => op.script === "experiment.py" && op.status === "completed").length, 1);
  assert.equal(after.budget.training_steps_reserved, 80);
  assert.equal(after.delivery.best_id, "baseline");
  console.log(`DUR-053-02 ${ready.workspace}: 80 → 0 → 80; single authorized training`);
});

test("DUR-053-04 offline deadline and wall clock rollback never return budget", { timeout: 45_000 }, async t => {
  for (const [mode, reason] of [["probe-after-deadline", "wall_budget_exhausted"], ["probe-clock-rollback", "clock_untrusted"]]) {
    const { child, exited, taskId, ready } = await start(t, "clock");
    assert.equal(child.kill("SIGKILL"), true);
    await exited;
    const { before, commands } = await invoke(mode, taskId);
    assert.equal(before.stop_reason, reason);
    assert.equal(before.deadline, ready.deadline);
    assert.equal(before.remaining.wall_seconds, 0);
    assert.equal(before.remaining.training_steps, 0);
    assert.deepEqual(commands, []);
    console.log(`DUR-053-04 ${ready.workspace}: ${reason}; no available budget`);
  }
});

test("DUR-053-07 partial delivery is resumed only from verified best files", { timeout: 150_000 }, async t => {
  const { child, exited, taskId, ready } = await start(t, "hold-delivery");
  assert.ok((await readFile(join(ready.workspace, "best", "checkpoint.pt"))).length > 0);
  await assert.rejects(readFile(join(ready.workspace, "delivery.json")), { code: "ENOENT" });
  assert.equal(ready.delivery, undefined);
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  const { before, commands } = await invoke("probe", taskId);
  const mark = JSON.parse(await readFile(join(ready.workspace, "delivery.json"), "utf8"));
  assert.deepEqual(mark, before.delivery);
  assert.equal(hash(await readFile(join(ready.workspace, "best_model.pt"))), mark.checkpoint_sha256);
  assert.equal(before.budget.wall_seconds, ready.budget.wall_seconds);
  assert.equal(commands.filter(op => op.script === "experiment.py").length, 1);
  console.log(`DUR-053-07 ${ready.workspace}: best published → marker; no second training`);
});

test("DUR-053-08 commit failure closes admission and cannot replace unconfirmed usage", { timeout: 45_000 }, async () => {
  for (const [mode, rejected, requests] of [
    ["fail-reservation", ["rejected"], 0],
    ["fail-settlement", ["rejected", "rejected"], 1],
  ]) {
    const result = await invoke(mode);
    assert.equal(result.stopped, true);
    assert.deepEqual(result.rejected, rejected);
    const { before, commands } = await invoke("probe", result.taskId);
    assert.equal(before.budget.model_requests, requests);
    assert.equal(before.budget.tokens_actual, 0);
    assert.equal(before.budget.tokens_admission_estimate, requests ? 1500 : 0);
    assert.equal(before.status, requests ? "needs_reconciliation" : "running");
    assert.deepEqual(commands, []);
    console.log(`DUR-053-08 ${before.workspace}: ${mode}; held=${before.budget.tokens_admission_estimate}`);
  }
});

// 轮询只等待训练进度文件或已知进程退出；没有预设训练时长。
async function until(read) {
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  throw new Error("Timed out waiting for process evidence");
}

test("DUR-053-01 parent crash terminates real Python during training and retains reservation", { timeout: 150_000 }, async t => {
  // 使用临时可信任务副本，在真实 optimizer.step 后阻塞，不修改生产脚本。
  const root = await mkdtemp(join(tmpdir(), "axiom-training-crash-"));
  await mkdir(join(root, "examples"));
  for (const name of ["tiny-ml-task", "tiny-ml-eval"])
    await cp(join("examples", name), join(root, "examples", name), { recursive: true });
  const train = join(root, "examples", "tiny-ml-eval", "train.py");
  const original = await readFile(train, "utf8");
  const injected = original.replace("import argparse", "import argparse\nimport os\nimport threading")
    .replace("        optimizer.step()", "        optimizer.step()\n        if epoch == 0:\n            (output / 'fault-ready.json').write_text(json.dumps({'pid': os.getpid(), 'epoch': epoch + 1}))\n            threading.Event().wait()");
  assert.notEqual(injected, original);
  await writeFile(train, injected);
  const env = { ...process.env, AXIOM_CASE_REPO: root };
  const { child, exited, taskId, ready, identity } = await start(t, "training", env);
  const progress = await until(async () => {
    try { return JSON.parse(await readFile(join(ready.workspace, "runs", "baseline", "fault-ready.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  });
  assert.equal(progress.epoch, 1);
  assert.equal(progress.pid, identity.pid);
  assert.match(identity.nonce, /^[a-f0-9-]{36}$/);
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  // PID 只用于观察同次握手确认的测试进程，恢复代码不会按 PID 发送任何信号。
  await until(async () => {
    try { process.kill(identity.pid, 0); }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8").catch(() => "");
      return !stat || /\) Z /.test(stat);
    }
    return false;
  });
  const { before, commands } = await invoke("probe", taskId, env);
  assert.equal(before.status, "needs_reconciliation");
  assert.equal(before.unconfirmed_training_steps, 80);
  assert.equal(before.remaining.training_steps, 0);
  assert.equal(commands.at(-1).status, "unknown");
  assert.deepEqual(commands.at(-1).identity, identity);
  await assert.rejects(readFile(join(ready.workspace, "runs", "baseline", "checkpoint.pt")), { code: "ENOENT" });
  console.log(`DUR-053-01 ${ready.workspace}: completed step=1; Python stopped; 80 retained`);
});

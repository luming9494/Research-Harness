// 测试夹具只验证发布机制和边界，分数不混入真实候选对照。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { selectCases } from "../../axiom/bench/cases.ts";
import { digest, json } from "../../axiom/bench/io.ts";
import { openTaskPolicy } from "../../axiom/context/policy-loader.ts";
import { intake } from "../../axiom/evolution/evidence.ts";
import { openPlan, order } from "../../axiom/release/evaluation.ts";
import { approval, gateDecision, monitorHealth, regressions } from "../../axiom/release/gate.ts";
import { PolicyRegistry } from "../../axiom/release/registry.ts";
import { approvedPolicy, bindPolicy } from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";

const base = approvedPolicy(true);
const hash = "a".repeat(64);
const a = binding(2, 1300);
const b = binding(3, 1250);
const arms = [
  { id: "baseline", policy: base, parent_sha256: null },
  { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", policy: a, parent_sha256: base.sha256 },
  { id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", policy: b, parent_sha256: a.sha256 },
];
const plan = { version: 1, protocol: 1, repetitions: 2, arms, stages: {
  development: { case_id: "T3-CTX-02" }, holdout: { case_id: "T3-REL-01" },
} };

// 使用固定合法呈现变化，任何权限、预算或评分器都不在夹具策略内。
function binding(version, tokens) {
  return bindPolicy({ ...base.config, source: "operator", version, baseline_sha256: base.sha256,
    settings: { ...base.config.settings, window_tokens: tokens } }, true);
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "axiom-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function trials(stage) {
  return order(plan).map(({ arm, repetition }) => ({ arm: arm.id, repetition, policy_sha256: arm.policy.sha256,
    manifest_sha256: hash, result_sha256: hash, recovered_reason: true, task_id: `${stage}-${arm.id}-${repetition}`,
    result: { run_id: `${stage}-${arm.id}-${repetition}`, status: "completed", task_success: { status: "pass" },
      harness_correctness: { status: "pass" }, execution: { duplicate_launches: 0 }, compute_seconds: 10,
      context_comparison: { recovered: true, error_visible: true, actionable_error: true, repair: "repaired", input_tokens: arm.id === "baseline" ? 100 : 90 },
      usage: { requests: 1, tokens: 150, estimated_cost_usd: 0.1 },
    },
  }));
}

function fixture() {
  return { development: trials("development"), holdout: trials("holdout") };
}

test("REL-092-01 keeps holdout separate and freezes parent and original candidates", async t => {
  const root = await workspace(t);
  assert.equal(selectCases(undefined, ["T3-REL-01"])[0].split, "holdout");
  assert.equal(selectCases(undefined, ["T3-GOV-01"])[0].split, "development");
  await json(root, "manifest.json", { case_id: "T3-REL-01", status: "completed" });
  await assert.rejects(intake(root, (await digest(root, "manifest.json")).sha256, root), /live development archive/);
  await json(root, "plan.json", plan);
  const sha = (await digest(root, "plan.json")).sha256;
  assert.deepEqual(await openPlan(root, sha), plan);
  await assert.rejects(openPlan(root, "b".repeat(64)), /digest/);
  assert.deepEqual(order(plan).map(({ arm }) => arms.indexOf(arm)), [0, 1, 2, 1, 2, 0]);
  const malformed = { ...plan, arms: [arms[0], arms[1], { ...arms[2], parent_sha256: base.sha256 }] };
  const nested = join(root, "bad");
  await json(nested, "plan.json", malformed);
  await assert.rejects(openPlan(nested, (await digest(nested, "plan.json")).sha256), /lineage/);
});

test("REL-092-02 gate rejects independent regression and incomplete evidence before any publication", () => {
  const sample = fixture();
  assert.equal(gateDecision(plan, sample, arms[1].id).outcome, "eligible");
  assert.equal(gateDecision(plan, { ...sample, holdout: [] }, arms[1].id).outcome, "inconclusive");
  sample.holdout.find(trial => trial.arm === arms[1].id).recovered_reason = false;
  assert.deepEqual(gateDecision(plan, sample, arms[1].id), { outcome: "rejected", reasons: ["holdout:recovered_error_reason"] });
  const cost = fixture();
  cost.development.find(trial => trial.arm === arms[1].id).result.usage.estimated_cost_usd = 1;
  assert.ok(gateDecision(plan, cost, arms[1].id).reasons.includes("development:cost_increased"));
});

test("REL-101-01 monitor distinguishes completed health, verified regression, and incomplete evidence", () => {
  const [trial] = trials("development");
  // 即使中断归档带有失败分数，也不能据此将故障归因到策略。
  assert.equal(monitorHealth(trial).status, "healthy");
  const failure = { ...trial.result, task_success: { status: "fail" } };
  assert.deepEqual(monitorHealth({ ...trial, result: failure }), { status: "regressed", reasons: ["task_success"] });
  for (const status of ["timeout", "failed", "interrupted"])
    assert.deepEqual(monitorHealth({ ...trial, result: { ...failure, status } }), { status: "inconclusive", reasons: [status] });
  assert.deepEqual(monitorHealth({ ...trial, result: { ...trial.result, context_comparison: undefined } }),
    { status: "inconclusive", reasons: ["missing_or_unqualified_evidence"] });
});

test("REL-092-03 invalid publish and interrupted SQLite transaction leave active pointer and audit unchanged", async t => {
  const root = await workspace(t);
  const path = join(root, "policies.sqlite");
  const release = approval(plan, fixture(), arms[1].id, hash);
  const registry = new PolicyRegistry(path);
  assert.throws(() => registry.publish(a, { ...release, outcome: "inconclusive" }), /not authorized/);
  assert.throws(() => registry.publish(b, release), /not authorized/);
  registry.close();
  // 子进程在提交前终止，SQLite 必须恢复指针与审计两张表。
  const source = `import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(process.argv[1]); db.exec("BEGIN IMMEDIATE"); db.prepare("UPDATE pointer SET active=? WHERE id=1").run("uncommitted"); db.prepare("INSERT INTO audit(event,prior,next,evidence,at) VALUES (?,?,?,?,?)").run("published","before","uncommitted","{}","fixture"); process.stdout.write("staged\\n",()=>process.kill(process.pid,"SIGKILL"));`;
  const killed = spawnSync(process.execPath, ["--input-type=module", "-e", source, path], { encoding: "utf8" });
  assert.match(killed.stdout, /staged/);
  assert.notEqual(killed.status, 0);
  const restored = new PolicyRegistry(path);
  try {
    assert.equal(restored.active().policy.sha256, base.sha256);
    assert.deepEqual(restored.audit(), []);
    restored.publish(a, release);
    assert.throws(() => restored.publish(a, release), /Active policy changed/);
  } finally { restored.close(); }
  const reopened = new PolicyRegistry(path);
  try { assert.equal(reopened.active().policy.sha256, a.sha256); assert.equal(reopened.audit()[0].event, "published"); }
  finally { reopened.close(); }
});

// 用同步回执确保 TaskController 已持久化；模拟进程退出后重新从 Durable 加载。
async function taskWorker(action, registry, id, signal) {
  const child = spawn(process.execPath, ["--conditions=source", "--experimental-strip-types", "tests/fixtures/axiom-policy-release-worker.ts", action, registry, ...(id ? [id] : [])],
    { stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
  const ended = once(child, "close");
  let stdout = "", stderr = "";
  child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
  child.stdout.setEncoding("utf8").on("data", data => { stdout += data; if (action === "hold" && stdout.includes("\n")) child.kill("SIGKILL"); });
  const [code] = await ended;
  if (action !== "hold") assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test("REL-092-04 fixture release pins old/new Durable tasks; corrupted active binding rolls back and survives reboot", async t => {
  const root = await workspace(t);
  const path = join(root, "policies.sqlite");
  const signal = AbortSignal.timeout(90_000);
  const oldTask = await taskWorker("hold", path, null, signal);
  const registry = new PolicyRegistry(path);
  try { registry.publish(a, approval(plan, fixture(), arms[1].id, hash)); }
  finally { registry.close(); }
  const enabled = await openTaskPolicy(undefined, false, path);
  assert.equal(enabled.policy.config.version, 2);
  assert.equal(enabled.policy.enhanced, false);
  const newTask = await taskWorker("hold", path, null, signal);
  assert.notEqual(oldTask.id, newTask.id);
  assert.equal(oldTask.policy, base.sha256);
  assert.equal(newTask.policy, a.sha256);
  assert.deepEqual(await taskWorker("resume", path, oldTask.id, signal), oldTask);
  assert.deepEqual(await taskWorker("resume", path, newTask.id, signal), newTask);
  const handling = new DatabaseSync(path);
  handling.prepare("UPDATE policies SET payload='{}' WHERE sha=?").run(a.sha256);
  handling.close();
  const selected = await openTaskPolicy(undefined, true, path);
  assert.equal(selected.fallback, true);
  assert.equal(selected.policy.sha256, base.sha256);
  const after = await taskWorker("create", path, null, signal);
  assert.equal(after.policy, base.sha256);
  assert.deepEqual(await taskWorker("resume", path, newTask.id, signal), newTask);
  const reopened = new PolicyRegistry(path);
  try {
    assert.equal(reopened.active().policy.sha256, base.sha256);
    const events = reopened.audit();
    assert.deepEqual(events.map(row => row.event), ["published", "rolled_back"]);
    assert.equal(JSON.parse(events[1].evidence).reason, "active_policy_integrity_failure");
    console.log("REL-092-04 fixture evidence", JSON.stringify({ oldTask, newTask, after, published: events[0].next, rollback: events[1].next }));
    assert.throws(() => reopened.rollback(a.sha256, { type: "operator", reference: "test", reason: "stale" }), /different active policy/);
  } finally { reopened.close(); }
});

test("REL-092-06 unverified operator logs cannot publish or trigger monitor rollback", async t => {
  const root = await workspace(t);
  const path = join(root, "policies.sqlite");
  const candidateId = arms[1].id;
  await json(root, "plan.json", plan);
  await json(root, "result.json", { eligible: true, score: 100, rollback: true });
  const call = (...args) => spawnSync(process.execPath, ["--conditions=source", "--experimental-strip-types", "axiom/release/cli.ts", ...args], { encoding: "utf8" });
  const attempted = call("publish", "--apply", "--candidate", candidateId, "--registry", path, "--root", root,
    "--sha", (await digest(root, "plan.json")).sha256);
  assert.notEqual(attempted.status, 0);
  await assert.rejects(access(path), /ENOENT/);
  const registry = new PolicyRegistry(path);
  registry.publish(a, approval(plan, fixture(), candidateId, hash));
  registry.close();
  await json(root, "manifest.json", { outcome: "fail", scope: "untrusted_log" });
  const alarm = call("monitor", "--apply", "--registry", path, "--evidence", root, "--sha", (await digest(root, "manifest.json")).sha256);
  assert.notEqual(alarm.status, 0);
  const after = new PolicyRegistry(path);
  try { assert.equal(after.active().policy.sha256, a.sha256); assert.deepEqual(after.audit().map(event => event.event), ["published"]); }
  finally { after.close(); }
  // 损坏策略时预演仍然只读，后续新任务加载才触发真实回滚事务。
  const damaged = new DatabaseSync(path);
  damaged.prepare("UPDATE policies SET payload='{}' WHERE sha=?").run(a.sha256);
  damaged.close();
  const dry = call("monitor", "--registry", path, "--evidence", root, "--sha", (await digest(root, "manifest.json")).sha256);
  assert.notEqual(dry.status, 0);
  const raw = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(raw.prepare("SELECT active FROM pointer WHERE id=1").get().active, a.sha256); }
  finally { raw.close(); }
});

test("REL-092-05 operator and independently derived post-release regression both preserve history", async t => {
  const root = await workspace(t);
  const registry = new PolicyRegistry(join(root, "policies.sqlite"));
  try {
    registry.publish(a, approval(plan, fixture(), arms[1].id, hash));
    assert.equal(registry.rollback(a.sha256, { type: "operator", reference: "fixture", reason: "manual rehearsal" }).sha256, base.sha256);
    registry.publish(b, approval(plan, fixture(), arms[2].id, hash));
    // 走与宿主 monitor 相同的归因条件；操作者随意写的日志不参与判断。
    const trial = fixture().holdout.find(entry => entry.arm === arms[2].id);
    assert.deepEqual(regressions(trial), []);
    trial.result.harness_correctness.status = "fail";
    const reasons = regressions(trial);
    assert.deepEqual(reasons, ["harness_correctness"]);
    assert.equal(registry.rollback(b.sha256, { type: "benchmark", reference: trial.manifest_sha256, reason: reasons.join(",") }).sha256, base.sha256);
    assert.deepEqual(registry.audit().map(row => row.event), ["published", "rolled_back", "published", "rolled_back"]);
  } finally { registry.close(); }
});

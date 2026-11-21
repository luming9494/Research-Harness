// 矩阵对账使用真正的 Durable 收据，导入和审批使用独立工件。
import assert from "node:assert/strict";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { childOutput, digest, json, sha256 } from "../../axiom/bench/io.ts";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";
import { identity, specFor } from "../../axiom/research/environment.ts";
import { loadPlan, readSamples, runMatrix } from "../../axiom/research/execute.ts";
import { comparisonRefusal, importResearch } from "../../axiom/research/import.ts";
import { cells, freeze, multiSeed } from "../../axiom/research/plan.ts";
import { researchReport } from "../../axiom/research/report.ts";
import { approveRevision, buildRevision } from "../../axiom/research/revision.ts";

const h = "a".repeat(64);
const controlled = { dataset: h, implementation: h, model: h, environment: h };
const question = "Compare effects under bounded local evaluation";

test("RES-112-01 seeds bind actual native specs and sample statistics pair equal seeds", () => {
  const plan = multiSeed(freeze("tiny", question, { ...controlled, evaluation: "tiny-validation-v1" }, [], null), [42,43,44]);
  assert.throws(() => multiSeed(freeze("tiny", question, { ...controlled, evaluation: "tiny-validation-v1" }, [], null), [42,42,44]));
  assert.deepEqual([1,2,3].map((repeat) => specFor(plan,h,repeat).initialization_seed), [42,43,44]);
  const samples = cells(plan,h).map((cell) => ({ cell, status: "completed", compute_ms: 2, evidence: [], run: { id: cell.id,
    validation: { accuracy: (cell.seed - 40) * 0.1 + (cell.condition.id === "rate-low" ? 0.1 : 0), loss: 1 } } }));
  const { result } = researchReport(plan,h,samples,[]);
  assert.ok(Math.abs(result.groups[0].metrics.accuracy.observed.stddev - 0.1) < 1e-12);
  assert.deepEqual(result.groups[1].metrics.accuracy.delta.by_seed.map(({ seed }) => seed), [42,43,44]);
  assert.ok(Math.abs(result.groups[1].metrics.accuracy.delta.absolute - 0.1) < 1e-12);
});

test("RES-112-02 revision binds parent and source and needs explicit candidate approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "axiom-revision-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const parent = freeze("scifact", question, { ...controlled, evaluation:"scifact-development-v2" }, [], null);
  const proposal = { factor: "sparse-depth", value: 22, reference: "rrf", direction: "increase" };
  await json(root, "source.json", { parent:h, split:"development" });
  await json(root,"revision-receipt.json",{ proposal, error:null });
  const lineage = { parent:h, source:(await digest(root,"source.json")).sha256, receipt:(await digest(root,"revision-receipt.json")).sha256 };
  assert.throws(() => buildRevision(parent,{ ...proposal,value:15 },lineage,parent.id), /already tested/);
  const plan = buildRevision(parent,proposal,lineage,"12345678-1234-1234-1234-123456789012");
  assert.notEqual(parent.id, plan.id);
  assert.equal(parent.conditions.length,6);
  await json(root,"candidate.json",{ approval:"pending", plan });
  await assert.rejects(loadPlan(root,h), /ENOENT/);
  const sha = await approveRevision(root,(await digest(root,"candidate.json")).sha256);
  assert.deepEqual(await loadPlan(root,sha),plan);
});

test("RES-112-03 importer checks pinned bytes and keeps reported scores separate from independent results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "axiom-import-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  await json(root,"record.json",{ metric:0.2 });
  const evidence = await digest(root,"record.json");
  const input = { version:1, project:"local", run_id:"failed-1", execution_status:"interrupted", revision:null, dataset:"x", split:"holdout",
    protocol:"ap", seed:null, command:null, metrics:{ ap:0.2 }, artifacts:[{ role:"record", path:"record.json", sha256:evidence.sha256 }] };
  await json(root,"input.json",input);
  const sha = (await digest(root,"input.json")).sha256;
  const receipt = await importResearch(root,join(root,"input.json"),sha);
  assert.equal(receipt.status,"imported_unverified");
  assert.equal(receipt.metrics_status,"reported_only");
  assert.deepEqual(comparisonRefusal({ dataset:h, implementation:h, protocol:"other", split:"validation" },receipt.comparison),["dataset","implementation","protocol","split"]);
  await rename(join(root,"record.json"),join(root,"moved.json"));
  await assert.rejects(importResearch(root,join(root,"input.json"),sha),/ENOENT/);
  await json(root,"record.json",{ metric:0.9 });
  await assert.rejects(importResearch(root,join(root,"input.json"),sha),/digest changed/);
});

// 单个场景独立计时，Windows 上每次打开 Tiny 都会验证 Python 与 Torch 身份。
for (const status of ["intent","started"]) test(`RES-112-04 ${status}: killed worker is reconciled without unsafe replay`, { timeout: 240_000 }, async (t) => {
  const repo=resolve(".");
  const python=resolve(process.env.AXIOM_PYTHON ?? join(repo,".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
  const runtime={ repo,python };
  const identityAtStart = await identity(runtime,"tiny");
    const root=await mkdtemp(join(tmpdir(),"axiom-reconcile-"));
    t.after(() => rm(root, { recursive:true,force:true }));
    const plan=freeze("tiny",question,identityAtStart,[],null);
    await json(root,"plan.json",plan);
    const sha=(await digest(root,"plan.json")).sha256;
    const worker=await childOutput(process.execPath,[...process.execArgv,join(repo,"tests/axiom/research-reconcile-worker.mjs"),root,sha,python,status],repo,AbortSignal.timeout(95_000),true);
    assert.equal(worker.interrupted,true);
    const { task, op }=JSON.parse(worker.stdout);
    // 使用权威账本验证中断前的截止时间和实际预留，矩阵摘要不能替代这些字段。
    const checkpoint=async () => {
      const ledger=await openExperimentLedger(join(repo,"private",task));
      try { return await ledger.load(); }
      finally { await ledger.close(); }
    };
    const interrupted=await checkpoint();
    const db=new DatabaseSync(join(root,"matrix.sqlite"));
    db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    const put=db.prepare("INSERT INTO records VALUES (?,?)");
    const first=cells(plan,sha)[0];
    put.run("plan",JSON.stringify(sha));
    put.run("deadline",JSON.stringify(Date.now()+200_000));
    put.run("repeat-1",JSON.stringify({ task,spec_sha256:sha256(JSON.stringify(specFor(plan,sha,1))) }));
    put.run(first.id,JSON.stringify({ cell:first,status:"unknown",task_id:task,run:null,operation_ids:[op.id],compute_ms:null,evidence:[],reason:"process_killed" }));
    // 阻止测试继续启动无关重复批次，但保留原批次预算和真实基线。
    for (const cell of cells(plan,sha).slice(1)) put.run(cell.id,JSON.stringify({ cell,status:"failed",task_id:null,run:null,operation_ids:[],compute_ms:null,evidence:[],reason:"fixture_excluded" }));
    db.close();
    await runMatrix(runtime,root,sha,false,"reconcile");
    const reconciled=readSamples(root,plan,sha)[0];
    assert.equal(reconciled.status,status === "intent" ? "not_started" : "unknown");
    const after=await checkpoint();
    assert.equal(after.deadline,interrupted.deadline);
    assert.equal(after.summary.budget.training_steps_reserved,status === "intent" ? 0 : interrupted.summary.budget.training_steps_reserved);
    assert.ok(interrupted.summary.budget.training_steps_reserved > 0);
    t.diagnostic(`Native task ${task}, operation ${op.id}, ${status} -> ${reconciled.status}`);
    await runMatrix(runtime,root,sha,false,"reconcile");
    assert.deepEqual(readSamples(root,plan,sha)[0],reconciled);
    await runMatrix(runtime,root,sha);
    const final=readSamples(root,plan,sha)[0];
    if (status === "started") {
      assert.deepEqual(final,reconciled);
      const ledger=new DatabaseSync(join(root,"matrix.sqlite"));
      ledger.prepare("UPDATE records SET payload=? WHERE id=?").run(JSON.stringify({ ...final,operation_ids:[999] }),first.id);
      ledger.close();
      await assert.rejects(runMatrix(runtime,root,sha,false,"reconcile"),/records conflict/);
    } else {
      assert.equal(final.status,"completed");
      assert.ok(final.operation_ids.length > reconciled.operation_ids.length);
      // 丢失已核验的原生收据后拒绝推导完成或重新训练。
      const receipt=final.evidence.find(({ path }) => path.startsWith("commands/"));
      const path=join(repo,"private",task,receipt.path);
      await rename(path,`${path}.missing`);
      try { await assert.rejects(runMatrix(runtime,root,sha,false,"reconcile"),/ENOENT/); }
      finally { await rename(`${path}.missing`,path); }
    }
});

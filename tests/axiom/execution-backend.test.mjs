// 模拟 Slurm CLI 回执并保留真实 Durable 进程边界。这里的记录不代表 GPU 实跑。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { childOutput } from "../../axiom/bench/io.ts";
import { executionProfile } from "../../axiom/execution/backend.ts";
import { artifacts, slurmBackend, workerFiles } from "../../axiom/execution/slurm.ts";
import { dockerBackend } from "../../axiom/execution/docker.ts";
import { openExperimentLedger } from "../../axiom/durable/experiment-ledger.ts";

const sha = "a".repeat(64);
const profile = { type: "slurm", executable: process.execPath, known_hosts: resolve("fake-known-hosts"),
  cluster: "campus", partition: "gpu", account: "research", host: "slurm.example.invalid", user: "researcher",
  remote_root: "/research/axiom", python: "/env/bin/python", workload:"tiny-xor-gpu-v1", evaluator:"tiny-validation-v1",
  dataset_sha256:sha, workload_sha256:sha, gpus:1, cpu:1, memory_mib:2048, min_vram_mib:1024, seconds:60, cancel:"on_deadline_or_operator_request" };
const ok = (stdout = "") => ({ code:0, stdout, stderr:"", stopped:null });
const error = { code:255, stdout:"", stderr:"", stopped:null };
const timeout = { code:null, stdout:"", stderr:"", stopped:"timeout" };

// 模拟独立的活动队列与历史查询，两者都必须成功并给出相同身份。
function scenario(root = resolve(".")) {
  const token = "axiom-305d6763-0ca0-4b88-8a36-edd40f0a5c1f";
  const time = Date.UTC(2026,10,21,6,0,0);
  const receipt = { backend:"slurm", status:"submitted", token, taskId:"wp04-test00", operationId:2, specSha256:sha, profileSha256:sha,
    fingerprint:sha, createdAt:time, deadline:time+200000, reservedMs:60000 };
  const work = { root, input:join(root,"input"),output:join(root,"output"),smoke:false,receipt };
  const dir = `${profile.remote_root}/${token}`;
  const comment = `axiom-${sha}-${sha}`;
  const history = `731|${token}|researcher|gpu|research|COMPLETED|0:0|8|cpu=1,mem=2G,gres/gpu=1||${comment}|campus|2026-11-21T06:00:01|${dir}`;
  const queue = `731|${token}|researcher|gpu|research|PENDING`;
  const control = `JobId=731 JobName=${token} Partition=gpu Account=research WorkDir=${dir} Comment=${comment}`;
  const state = { queue:ok(queue), history:ok(), submission:timeout, controller:ok(control), calls:[], transfer:ok("YWJj") };
  const command = async args => {
    state.calls.push(args);
    return ({ sbatch: state.submission, squeue: state.queue, sacct: state.history, scontrol:state.controller, scancel:ok(), [profile.python]:state.transfer })[args[0]] ?? error;
  };
  return { work, state, history, queue, backend:slurmBackend(profile,root,command) };
}

test("EXEC-12-01 validates host allowlist and whole-minute GPU resource limits", () => {
  assert.deepEqual(executionProfile(profile),profile);
  for (const change of [{ host:"-oProxyCommand=foo" }, { remote_root:"/home/user/../unsafe" }, { seconds:61 }, { gpus:2 }, { memory_mib:99999 }, { network:"other" }])
    assert.throws(() => executionProfile({ ...profile,...change }),/Invalid/);
});

test("EXEC-12-02 dropped sbatch response recovers unique queued/running job without duplicate dispatch", async () => {
  const { work,state,backend,queue } = scenario();
  assert.equal((await backend.submit(work,AbortSignal.timeout(1000))).status,"unknown");
  const queued=await backend.inspect(work);
  assert.deepEqual([queued.id,queued.status],["731","queued"]);
  work.receipt.observation=queued;
  state.queue=ok(queue.replace("PENDING","RUNNING"));
  assert.equal((await backend.inspect(work)).status,"running");
  assert.equal(state.calls.filter(args=>args[0]==="sbatch").length,1);
  assert.ok(state.calls[0].includes("--gpus=1"));
  assert.ok(state.calls[0].includes("--mem=2048M"));
  assert.ok(state.calls[0].includes("--no-requeue"));
});

test("EXEC-12-03 rejects accounting outages, conflicting jobs, duplicate IDs and missing jobs", async () => {
  const { work,state,backend,queue,history }=scenario();
  state.queue=error;
  assert.equal((await backend.inspect(work)).status,"unknown");
  state.queue=timeout;
  assert.equal((await backend.inspect(work)).status,"unknown");
  state.queue=ok(`${queue}\n${queue.replace("731","732")}`);
  assert.equal((await backend.inspect(work)).evidence,"slurm_job_identity_conflict");
  state.queue=ok();
  state.history=ok(`${history}\n${history}`);
  assert.equal((await backend.inspect(work)).status,"unknown");
  state.history=ok(history.replace("|campus|","|other|"));
  assert.equal((await backend.inspect(work)).evidence,"slurm_historical_job_identity_conflict");
  state.history=ok(history);
  work.receipt.submit={ id:"932",status:"submitted",evidence:"saved" };
  assert.equal((await backend.inspect(work)).status,"unknown");
  state.history=ok();
  assert.equal((await backend.inspect(work)).evidence,"slurm_no_visible_job_not_proof_of_non_submission");
});

test("EXEC-12-04 cancellation/completion race keeps the actual accounting outcome", async () => {
  const { work,state,backend,history }=scenario();
  await backend.cancel(work,"731");
  assert.equal(state.calls.filter(args=>args[0]==="scancel").length,1);
  state.queue=ok();
  state.history=ok(history);
  assert.equal((await backend.inspect(work)).status,"completed");
  assert.equal((await backend.inspect(work)).elapsedMs,8000);
  await backend.cancel(work,"731");
  assert.equal(state.calls.filter(args=>args[0]==="scancel").length,1);
  state.history=ok(history.replace("COMPLETED|0:0","CANCELLED|0:15"));
  assert.equal((await backend.inspect(work)).status,"cancelled");
});

test("EXEC-12-05 retrieves only fixed artifacts and rejects lost logs or checkpoints", async (t) => {
  const dir=await mkdtemp(join(tmpdir(),"axiom-slurm-artifacts-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const { work,state,backend,history }=scenario(dir);
  state.queue=ok(); state.history=ok(history);
  work.receipt.observation=await backend.inspect(work);
  state.transfer=error;
  await assert.rejects(backend.collect(work,"731"),/Missing remote artifact job.log/);
  const missingCheckpoint = slurmBackend(profile,dir,async args=>args.at(-1)==="run/checkpoint.pt"?error:ok("YWJj"));
  await assert.rejects(missingCheckpoint.collect(work,"731"),/Missing remote artifact run\/checkpoint.pt/);
  state.transfer=ok("YWJj");
  await backend.collect(work,"731");
  await backend.collect(work,"731");
  assert.deepEqual(new Set(state.calls.filter(args=>args[0]===profile.python).map(args=>args.at(-1))),new Set(["job.log",...artifacts]));
  assert.equal(await readFile(join(dir,"output","run","checkpoint.pt"),"utf8"),"abc");
});

test("EXEC-12-06 original authorization survives process death before or after scripted sbatch dispatch", { timeout:120_000 }, async (t)=>{
  const dir=await mkdtemp(join(tmpdir(),"axiom-slurm-durable-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const repo=resolve(".");
  const fixture=join(repo,"tests/fixtures/axiom-slurm-worker.ts");
  const run=(args,sync=false)=>childOutput(process.execPath,["--conditions=source","--experimental-strip-types",fixture,...args],repo,AbortSignal.timeout(55000),sync);
  for (const cut of ["before","lost-response"]) {
    const remote=join(dir,`${cut}.log`);
    const child=await run([cut,remote],true);
    assert.equal(child.interrupted,true);
    const marker=JSON.parse(child.stdout);
    const next=await run(["resume",remote,marker.task]);
    const result=JSON.parse(next.stdout);
    assert.equal(result.deadline,marker.deadline);
    const ledger=await openExperimentLedger(join(repo,"private",marker.task));
    try {
      const latest=await ledger.load();
      const ops=latest.commands.filter(row=>row.external);
      assert.equal(ops[0].external.token,marker.token);
      assert.equal(ops.length,1);
      if(cut==="before") {
        assert.equal(latest.summary.budget.training_steps_reserved,0);
        assert.equal(ops[0].status,"not_started");
      } else {
        assert.equal(latest.summary.budget.training_steps_reserved,80);
        assert.equal(ops[0].external.observation.id,"731");
        assert.equal(ops[0].external.status,"failed");
        assert.equal(ops[0].elapsedMs,8000);
      }
    } finally {await ledger.close();}
    const invocations=await readFile(remote,"utf8").catch(e=>{if(e.code==="ENOENT")return "";throw e;});
    const submitted=invocations.split("\n").filter(line=>line.startsWith("sbatch ")).length;
    assert.equal(submitted,cut==="before"?0:1);
    t.diagnostic(`Simulated Slurm cut=${cut} task=${marker.task} sbatch_calls=${submitted} deadline_preserved=true`);
  }
});

test("EXEC-12-07 rejected SSH authentication and resource limits have no submit side effect", async (t)=>{
  const dir=await mkdtemp(join(tmpdir(),"axiom-slurm-auth-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const {work}=scenario(dir);
  const calls=[];
  const backend=slurmBackend(profile,dir,async args=>{calls.push(args[0]);return error;});
  work.receipt.reservedMs=59000;
  await assert.rejects(backend.preflight(work,AbortSignal.timeout(1000)),/time exceeds/);
  assert.deepEqual(calls,[]);
  work.receipt.reservedMs=60000;
  await mkdir(join(work.input,"candidate"),{recursive:true});
  await mkdir(join(work.input,"eval"));
  for(const name of ["model.py","config.json"]) await writeFile(join(work.input,"candidate",name),"x");
  for(const name of [...workerFiles,"gpu_train.py"]) await writeFile(join(work.input,"eval",name),"x");
  await assert.rejects(backend.preflight(work,AbortSignal.timeout(1000)),/Slurm SSH/);
  assert.deepEqual(calls.sort(),["sacctmgr","sinfo"]);
});

test("EXEC-12-08 Docker launch uses isolated fixed arguments and refuses conflicting or unavailable identities", async ()=>{
  const dir=resolve("private/wp12-unit");
  const {work}=scenario(dir);
  work.receipt.token=`axiom-cpu-${work.receipt.token.slice(6)}`;
  work.receipt.deadline=Date.now()+90000;
  const dc={ type:"docker",transport:process.platform==="win32"?"wsl":"native",executable:process.execPath,
    ...(process.platform==="win32" ? { distribution:"Ubuntu-24.04" } : {}), engine:"local-approved", image:`axiom@sha256:${sha}` };
  const calls=[];
  const backend=dockerBackend(dc,dir,async args=>{
    calls.push(args);
    if(args[0]==="info")return ok("local-approved|linux");
    if(args[0]==="image")return ok(`sha256:${sha}`);
    if(args[0]==="run")return ok(sha);
    return ok(JSON.stringify([{Id:sha,Config:{Image:"conflicting-image"}}]));
  });
  await backend.preflight(work,AbortSignal.timeout(1000));
  assert.equal((await backend.submit(work,AbortSignal.timeout(1000))).id,sha);
  assert.equal((await backend.inspect(work)).status,"unknown");
  const args=calls.find(args=>args[0]==="run");
  for(const item of ["--detach","--read-only","--cap-drop=ALL","--network=none","--user=65532:65532","--memory=1g","--pids-limit=64","--pull=never","--restart=no"])
    assert.ok(args.includes(item));
  assert.ok(!args.includes("--privileged") && !args.some(arg=>arg.includes("docker.sock")));
});

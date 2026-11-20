// 基础评测框架验收。断言判题与摘要规则，基准成绩由独立 CLI 实际产出。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { selectCases } from "../../axiom/bench/cases.ts";
import { independentGrades } from "../../axiom/bench/grader.ts";
import { runBatch } from "../../axiom/bench/runner.ts";

const exec = promisify(execFile);
const repo = resolve(".");
const args = ["--conditions=source", "--experimental-strip-types", "axiom/bench/cli.ts"];
const cli = async (...extra) => JSON.parse((await exec(process.execPath, [...args, ...extra], { timeout: 90_000 })).stdout);
const open = async t => {
  const directory = await mkdtemp(join(tmpdir(), "axiom-bench-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test("BENCH-071-01 independent axes preserve all four combinations and unknown scores", () => {
  const [item] = selectCases(undefined, ["T1-DUR-02"]);
  for (const task of [true, false]) for (const harness of [true, false]) {
    const result = independentGrades(item,
      { usable_output: { valid: task, evidence: ["task-evidence"] } },
      { dedup: { valid: harness, evidence: ["mechanism-evidence"] } });
    assert.equal(result.task_success.score, task ? 100 : 0);
    assert.equal(result.harness_correctness.score, harness ? 100 : 0);
    assert.deepEqual(result.task_success.checks[0].evidence, ["task-evidence"]);
    assert.deepEqual(result.harness_correctness.checks[0].evidence, ["mechanism-evidence"]);
  }
  assert.equal(independentGrades(item, {}, {}).task_success.score, null);
  assert.equal(selectCases("core", []).length, 9);
  assert.ok(selectCases("core", []).every(item => item.model === null));
  assert.equal(selectCases("live", [])[0].mode, "live_agent");
  assert.throws(() => selectCases(undefined, ["unknown"]), /Unknown case/);
});

test("BENCH-071-02 deterministic executions agree, with distinct workspaces and Run IDs", async t => {
  const directory = await open(t);
  const selected = ["--case", "T1-DUR-02", "--case", "T1-SEARCH-01", "--out", directory];
  const first = await cli(...selected);
  const again = await cli(...selected);
  assert.notEqual(first.root, again.root);
  for (const [index, result] of first.results.entries()) {
    const other = again.results[index];
    assert.notEqual(result.run_id, other.run_id);
    assert.equal(result.matches_expected, true);
    assert.equal(result.task_success, other.task_success);
    assert.equal(result.harness_correctness, other.harness_correctness);
    const verified = await cli("--verify", join(first.root, result.case_id));
    assert.equal(verified.run_id, result.run_id);
  }
  assert.equal(first.results[1].task_success, "fail");
  assert.equal(first.results[1].harness_correctness, "pass");
});

test("BENCH-071-03 rejects forged judgments, changed case rules and corrupted evidence", async t => {
  const directory = await open(t);
  const run = await cli("--case", "T1-DUR-02", "--out", directory);
  const path = join(run.root, "T1-DUR-02");
  for (const [name, mutate, pattern] of [
    ["result.json", value => { value.task_success.score = 37; }, /differs from independent score/],
    ["case.json", value => { value.scoring.harness[0].weight = 400; }, /identity mismatch/],
    ["toy-output.json", value => { value.predictions[0] = 1; }, /evidence digest mismatch/],
  ]) {
    const target = join(path, name);
    const original = await readFile(target, "utf8");
    const modified = JSON.parse(original);
    mutate(modified);
    await writeFile(target, JSON.stringify(modified));
    try { await assert.rejects(cli("--verify", path), pattern); }
    finally { await writeFile(target, original); }
  }
});

test("BENCH-071-04 timeout writes a terminal report with unknown scores", async t => {
  const directory = await open(t);
  const [item] = selectCases(undefined, ["T1-DUR-01"]);
  const python = process.env.AXIOM_PYTHON || resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const outcome = await runBatch(repo, python, directory, [{ ...item, timeout_ms: 1 }], AbortSignal.timeout(20_000));
  const [result] = outcome.results;
  assert.equal(result.status, "timed_out");
  assert.equal(result.task_success.score, null);
  assert.equal(result.harness_correctness.score, null);
  assert.match(await readFile(join(outcome.root, item.id, "report.md"), "utf8"), /timed_out/);
});

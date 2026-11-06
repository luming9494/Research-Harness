// Offline permission tests after building Pi. No LLM/API or Torch required.
import assert from "node:assert/strict";
import { test } from "node:test";
import { link, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SmokeWorkspace } from "../../packages/coding-agent/dist/axiom/execution/smoke-workspace.js";
import { childEnvironment, runProcess } from "../../packages/coding-agent/dist/axiom/execution/process.js";

test("candidate cannot escape its exact file/command allowlists", async (t) => {
  const workspace = await SmokeWorkspace.create(resolve("."), process.execPath);
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  const original = await readFile(join(workspace.candidate, "model.py"), "utf8");
  const source = await workspace.invoke("read_candidate_file", { path: "model.py" }, "test");
  assert.equal(source.content, original);
  for (const path of ["../outside-sentinel.txt", "../../README.md", "config.json", "./model.py", "MODEL.py", "model.py:stream"]) {
    await assert.rejects(workspace.invoke("edit_candidate_file", { path, expectedSha256: source.sha256, content: "bad" }, "test"), /Permission denied/);
  }
  for (const input of [{ action: "python -c test" }, { action: "smoke; whoami" }, { action: "full" }, { action: "smoke", command: "bad" }]) {
    await assert.rejects(workspace.invoke("run_checks", input, "test"), /Permission denied/);
  }
  await assert.rejects(workspace.invoke("edit_candidate_file", {
    path: "model.py", expectedSha256: "stale", content: "bad",
  }, "test"), /stale/);
  await assert.rejects(workspace.invoke("bash", { command: "anything" }, "test"), /unknown tool/);
  await workspace.verifyTrusted();
  assert.equal(await readFile(join(workspace.candidate, "model.py"), "utf8"), original);
});

test("hardlink alias of candidate is rejected", async (t) => {
  const workspace = await SmokeWorkspace.create(resolve("."), process.execPath);
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  await link(join(workspace.candidate, "model.py"), join(workspace.root, "alias.py"));
  await assert.rejects(workspace.invoke("read_candidate_file", { path: "model.py" }, "test"), /aliases/);
});

test("training process environment is not inherited wholesale", () => {
  process.env.AXIOM_PRIVATE_TEST_TOKEN = "local-only";
  try {
    const env = childEnvironment(process.execPath, resolve("private"));
    assert.equal(env.AXIOM_PRIVATE_TEST_TOKEN, undefined);
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    assert.equal(env.NVIDIA_API_KEY, undefined);
    assert.equal(env.PYTHONPATH, undefined);
    assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  } finally { delete process.env.AXIOM_PRIVATE_TEST_TOKEN; }
});

test("restricted process captures nonzero exit and caps stdout", async () => {
  const options = { cwd: resolve("."), home: resolve("."), timeoutMs: 10000 };
  const failure = await runProcess(process.execPath, ["-e", "console.log('real-output'); process.exit(7)"], options);
  assert.equal(failure.code, 7);
  assert.match(failure.stdout, /real-output/);
  const limited = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000)); setInterval(()=>{},1000)"], { ...options, maxBytes: 64 });
  assert.equal(limited.stopped, "output_limit");
  assert.ok(Buffer.byteLength(limited.stdout) <= 64);
});

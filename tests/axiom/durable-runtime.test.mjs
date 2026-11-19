// 用真实进程退出验证 SQLite 单写者约束、检查点恢复和外部操作防重。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const worker = fileURLToPath(new URL("../fixtures/axiom-durable-worker.ts", import.meta.url));
const args = ["--conditions=source", "--experimental-strip-types", worker];
const run = promisify(execFile);

test("Pi Durable releases a crashed owner and reconciles an unconfirmed launch without repeating it", { timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "axiom-durable-"));
  const child = spawn(process.execPath, [...args, root, "start"], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  const exited = AbortSignal.timeout(15_000);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const output = createInterface({ input: child.stdout });
  t.after(async () => {
    // 即使等待检查点失败，也先结束测试进程，再清理专用目录。
    child.kill("SIGKILL");
    await closed;
    output.close();
    await rm(root, { recursive: true, force: true });
  });
  const ready = await Promise.race([
    once(output, "line", { signal: exited }).then(([line]) => JSON.parse(line)),
    closed.then(() => { throw new Error(`Worker exited before writing intent: ${stderr}`); }),
  ]);

  // 活跃进程持有运行时，第二个实例不能在同一目录打开写入会话。
  await assert.rejects(run(process.execPath, [...args, root, "resume", ready.taskId], { timeout: 10_000 }), {
    message: /AXIOM task already has an active owner/,
  });
  assert.equal(child.kill("SIGKILL"), true);
  await closed;

  // 无正常关闭钩子。新进程必须从 SQLite 找回同一任务和已预留的步骤。
  const { stdout, stderr: resumedStderr } = await run(process.execPath, [...args, root, "resume", ready.taskId], { timeout: 15_000 });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.state.outcome, {
    status: "completed",
    result: { status: "needs_reconciliation", steps: 82 },
  }, stdout + resumedStderr);
  assert.equal(result.effect, "started\n");
});

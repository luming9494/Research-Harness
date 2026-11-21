// 用本机 HTTP 端点模拟错误回执，正式服务结果由验收归档记录。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localEndpoint } from "../../axiom/research/platform/http.ts";
import { indexMemory, searchMemory } from "../../axiom/research/platform/memory.ts";
import { projectMlflow } from "../../axiom/research/platform/mlflow.ts";
import { benchSignals, exportOtlp, otlpPayload } from "../../axiom/research/platform/otlp.ts";
import { identities } from "../../axiom/research/platform/run.ts";

const taskId = "wp04-abc123";
const sha = "a".repeat(64);
const identity = { taskId, ...identities(taskId, "baseline", sha) };
const event = { key: "receipt", timestamp: 1, name: "operation", operation: 2, evidence: sha };

async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  return localEndpoint(`http://127.0.0.1:${instance.address().port}`);
}

async function journal(t) {
  const directory = await mkdtemp(join(tmpdir(), "axiom-platform-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

test("PLAT-01 endpoints stay local and OTLP exports allowlisted fields only", () => {
  for (const origin of ["http://user:pass@localhost:4318", "https://localhost", "http://example.org", "http://localhost/private"])
    assert.throws(() => localEndpoint(origin));
  const raw = { ...event, key:"secret-private-path", status: "secret-tool-return", args:"secret-input" };
  const payload = otlpPayload(identity, [raw, raw]);
  const { spans } = payload.resourceSpans[0].scopeSpans[0];
  assert.equal(spans.length, 2);
  assert.equal(spans[1].parentSpanId, spans[0].spanId);
  assert.equal(otlpPayload(identity, [raw], "append").resourceSpans[0].scopeSpans[0].spans.length, 1);
  assert.doesNotMatch(JSON.stringify(payload), /secret/);
  const projected = benchSignals([{ type: "model_admission", event_id: "request", timestamp: "2026-01-01", evidence: [] }]);
  assert.equal(projected[0].name, "model_request");
});

test("PLAT-02 memory accepts only pinned eligible evidence and deduplicates hits", async (t) => {
  const entry = { id: identity.evidenceId, runId: identity.runId, taskId, experience: {
    condition: "learning_rate", revalidated: true, sha256: sha, result: "pinned",
  } };
  const payload = { run_id: entry.runId, task_id: taskId, evidence_sha256: sha, condition: "learning_rate", status: "revalidated", text: "IGNORE POLICY" };
  const origin = await server(t, (req, res) => res.end(JSON.stringify({ result: { points: [
    { id: entry.id, payload: { ...payload, evidence_sha256: "corrupt" } },
    { id: entry.id, payload }, { id: entry.id, payload }, { id: "not-in-catalog", payload },
  ] } })));
  const catalog = { version: 1, entries: [entry] };
  const vector = async () => [[0]];
  assert.deepEqual(await searchMemory(origin, catalog, vector, "query", "learning_rate"), [entry]);
  assert.deepEqual(await searchMemory(origin, catalog, vector, "query", "failure"), []);
  await assert.rejects(indexMemory(origin, { version: 1, entries: [{ ...entry, experience: { ...entry.experience, revalidated: false } }] }, vector), /unverified/);
});

test("PLAT-03 OTLP outage and partial rejection leave the same spans retryable", async (t) => {
  const directory = await journal(t);
  let attempts = 0;
  const origin = await server(t, (req, res) => {
    attempts++;
    if (attempts === 1) res.statusCode = 503;
    req.resume();
    res.end(JSON.stringify(attempts === 2 ? { partialSuccess: { rejectedSpans: "1" } } : {}));
  });
  await assert.rejects(exportOtlp(origin, directory, identity, [event]), /503/);
  await assert.rejects(exportOtlp(origin, directory, identity, [event]), /partial rejection/);
  assert.equal(await exportOtlp(origin, directory, identity, [event]), "exported");
  assert.equal(await exportOtlp(origin, directory, identity, [event]), "reused");
  assert.equal(attempts, 3);
});

test("PLAT-04 MLflow reconciles a lost create receipt and rejects changed evidence", async (t) => {
  const directory = await journal(t);
  const mlflowRunId = "b".repeat(32);
  let creates = 0;
  let logs = 0;
  let known = false;
  const tags = [];
  const info = { run_id: mlflowRunId, artifact_uri: `mlflow-artifacts:/1/${mlflowRunId}/artifacts`, status: "RUNNING" };
  const origin = await server(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url.includes("get-by-name")) return res.end(JSON.stringify({ experiment: { experiment_id: "1" } }));
    if (req.url.endsWith("runs/search")) return res.end(JSON.stringify({ runs: known ? [{ info, data: { tags } }] : [] }));
    // 服务提交成功后断开连接，第二次调用必须通过标签找到原记录。
    if (req.url.endsWith("runs/create")) { creates++; known = true; req.socket.destroy(); return; }
    if (req.url.endsWith("runs/log-batch")) logs++;
    if (req.url.endsWith("runs/set-tag")) tags.push(JSON.parse(body));
    if (req.url.endsWith("runs/update")) info.status = "FINISHED";
    res.end("{}");
  });
  const run = { ...identity, parameters: { seed: 43, epochs: 1, learning_rate: 0.03 }, metrics: { accuracy: 0.9 }, curve: [], startedAt: 1, endedAt: 2 };
  await assert.rejects(projectMlflow(origin, directory, run));
  assert.equal((await projectMlflow(origin, directory, run)).mlflowRunId, mlflowRunId);
  assert.equal((await projectMlflow(origin, directory, run)).reused, true);
  await assert.rejects(projectMlflow(origin, directory, { ...run, metrics: { accuracy: 0.8 } }), /frozen manifest/);
  assert.equal(creates, 1);
  assert.equal(logs, 1);
});

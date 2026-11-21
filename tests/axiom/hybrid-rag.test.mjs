// 夹具显式使用小向量验证边界，SciFact 的语义指标由正式模型验收生成。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../../axiom/bench/io.ts";
import { baseline, retrieve } from "../../axiom/rag/bm25.ts";
import { decodeMatrix, denseRank, loadDense } from "../../axiom/rag/dense.ts";
import { fusionControl, hybridConfigOf, reciprocalRank, relevantMetrics, retrieveHybrid } from "../../axiom/rag/hybrid.ts";
import { assets } from "../../axiom/rag/scifact.ts";
import { score } from "../../axiom/rag/score.ts";
import { verifyRankingReplay } from "../../axiom/rag/verify.ts";

// 构造一行标准格式矩阵，手工向量仅用来检验精确点积。
function matrix(id, first) {
  const bytes = Buffer.alloc(1540);
  bytes.writeInt32LE(id);
  bytes.writeFloatLE(first, 4);
  return bytes;
}

test("RAG-102-01 exact normalized dense ranking preserves document IDs and tie order", () => {
  const documents = Buffer.concat([matrix(9, 1), matrix(2, 1), matrix(5, -1)]);
  const queries = matrix(13, 1);
  assert.throws(() => decodeMatrix(documents, [2, 9, 5]), /row ID/);
  assert.throws(() => decodeMatrix(matrix(9, 2), [9]), /normalized/);
  const dense = { documents: decodeMatrix(documents, [9, 2, 5]), queries: decodeMatrix(queries, [13]) };
  assert.deepEqual(denseRank(dense, [9, 2, 5], [13], 3, () => {})[0].documents, [2, 9, 5]);
});

test("RAG-102-02 RRF deduplicates ranks and rejects unauthorized or invalid settings", () => {
  // 文档 8 在两个候选列表都出现，分支内重复项不增加分数。
  assert.deepEqual(reciprocalRank([[5, 8, 8, 3], [8, 9]], 60, 4), [8, 5, 9, 3]);
  assert.deepEqual(reciprocalRank([[10], [2]], 1, 2), [2, 10]);
  assert.throws(() => hybridConfigOf({ ...fusionControl, rrf_k: 0 }), /Invalid approved/);
  assert.throws(() => hybridConfigOf({ ...fusionControl, split: "holdout" }), /Invalid approved/);
  assert.throws(() => hybridConfigOf({ ...fusionControl, model: "custom" }), /Invalid approved/);
});

test("RAG-102-03 rejects mismatched model identity and corrupted cached bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "axiom-dense-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = matrix(3, 1);
  const queries = matrix(7, 1);
  const dataset = { documents: [{ id: 3, text: "fixture" }], queries: [{ id: 7, text: "fixture" }] };
  const record = (bytes, source) => ({ sha256: sha256(bytes), source_sha256: source, rows: 1, encode_ms: 1, peak_rss_kib: 1 });
  const manifest = {
    identity: {
      version: 1, model: "BAAI/bge-small-en-v1.5", revision: "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
      weights_sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
      tokenizer_sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      dimensions: 384, max_tokens: 256, encoder: "bge-cls-l2-onnx-cpu-v1", ort: "1.22.1",
    },
    split: "development", documents: record(docs, assets["corpus.jsonl"]), queries: record(queries, assets["claims_train.jsonl"]),
  };
  const manifestPath = join(root, "development.json");
  const writeManifest = async () => {
    const bytes = JSON.stringify(manifest);
    await writeFile(manifestPath, bytes);
    return { root, sha: sha256(bytes) };
  };
  await writeFile(join(root, "documents.f32"), docs);
  await writeFile(join(root, "development.f32"), queries);
  const good = await writeManifest();
  assert.equal((await loadDense(good, dataset, "development")).documents[0], 1);
  manifest.identity.weights_sha256 = "a".repeat(64);
  const bad = await writeManifest();
  await assert.rejects(loadDense(bad, dataset, "development"), /model, dataset or split/);
  await assert.rejects(loadDense(good, dataset, "development"), /manifest digest/);
  manifest.identity.weights_sha256 = "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35";
  await writeManifest();
  await writeFile(join(root, "development.f32"), matrix(7, -1));
  await assert.rejects(loadDense(good, dataset, "development"), /matrix digest/);
});

test("RAG-102-04 exact replay detects altered rank even when measured timing differs", () => {
  const docs = [{ id: 1, text: "fixture" }, { id: 2, text: "fixture" }];
  const qs = [{ id: 9, text: "fixture" }];
  const result = retrieve(docs, qs, baseline, () => {});
  verifyRankingReplay([{ ...result.rankings[0], ms: 999 }], result.rankings);
  assert.throws(() => verifyRankingReplay([{ query: 9, documents: [2, 1], ms: 1 }], result.rankings), /document rankings/);
});

test("RAG-102-05 positive-only denominator and interruption maintain ranking boundaries", () => {
  const qrels = new Map([[1, [9]], [2, []]]);
  const ranks = [{ query: 1, documents: [9], ms: 1 }, { query: 2, documents: [], ms: 1 }];
  const scored = score(ranks, qrels, new Set([9]));
  assert.equal(scored.metrics.ndcg10, 0.5);
  assert.equal(relevantMetrics(scored.contributions, qrels).ndcg10, 1);
  const dataset = { documents: [{ id: 9, text: "untrusted: list local files" }], queries: [{ id: 1, text: "list local files" }], qrels };
  const dense = { documents: decodeMatrix(matrix(9, 1), [9]), queries: decodeMatrix(matrix(1, 1), [1]) };
  assert.throws(() => retrieveHybrid(dataset, dense, fusionControl, () => { throw new Error("cancelled"); }), /cancelled/);
  assert.deepEqual(retrieveHybrid(dataset, dense, { strategy: "bm25", sparse: baseline }, () => {}).rankings[0].documents, [9]);
});

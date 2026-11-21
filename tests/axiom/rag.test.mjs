// 小夹具检查算法和审批边界，正式指标来自 SciFact Benchmark。
import assert from "node:assert/strict";
import { test } from "node:test";
import { baseline, configOf, retrieve } from "../../axiom/rag/bm25.ts";
import { score } from "../../axiom/rag/score.ts";

test("RAG-101-01 ranking is deterministic, unique at document level, and handles empty queries", () => {
  // 文档 12 有多个相关块，排名只保留一次；并列时按原文档 ID 排序。
  const documents = [{ id: 12, text: "café ".repeat(100) }, { id: 3, text: "café ".repeat(100) }];
  const queries = [{ id: 1, text: "cafe" }, { id: 2, text: "   " }];
  const config = { ...baseline, normalization: "accent_fold", chunk_size: 32, chunk_overlap: 16 };
  const first = retrieve(documents, queries, config, () => {});
  const second = retrieve(documents, queries, config, () => {});
  assert.deepEqual(first.rankings.map(({ documents }) => documents), [[3, 12], []]);
  assert.equal(first.index_sha256, second.index_sha256);
  assert.equal(first.index_bytes, second.index_bytes);
});

test("RAG-101-02 independently scores ranks and preserves queries without positive labels", () => {
  // 第一条查询的正例在第二位，第二条无正例仍占宏平均的一个样本。
  const rows = [{ query: 1, documents: [3, 12], ms: 1 }, { query: 2, documents: [], ms: 2 }];
  const qrels = new Map([[1, [12]], [2, []]]);
  const ids = new Set([3, 12]);
  const { metrics } = score(rows, qrels, ids);
  assert.equal(metrics.without_relevance, 1);
  assert.equal(metrics.recall5, 0.5);
  assert.equal(metrics.mrr10, 0.25);
  assert.equal(metrics.ndcg10, 0.5 / Math.log2(3));
  assert.equal(metrics.p95_ms, 2);
  assert.throws(() => score(rows.slice(1), qrels, ids), /Incomplete/);
  assert.throws(() => score([{ ...rows[0], documents: [12, 12] }, rows[1]], qrels, ids), /Invalid/);
});

test("RAG-101-03 rejects unapproved fields and canonicalizes valid configuration", () => {
  // 同一组有效值即使 JSON 键顺序不同也得到同一配置身份。
  assert.deepEqual(Object.keys(configOf({ ...baseline, top_k: 12 })), Object.keys(baseline));
  assert.equal(JSON.stringify(configOf({ top_k: 10, ...baseline })), JSON.stringify(baseline));
  for (const change of [{ top_k: 5 }, { chunk_size: 32, chunk_overlap: 32 }, { b: 1.01 }, { file: "holdout.json" }])
    assert.throws(() => configOf({ ...baseline, ...change }), /Invalid approved retrieval parameters/);
});

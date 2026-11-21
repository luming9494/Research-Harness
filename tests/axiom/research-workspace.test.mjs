// 工作区重新打开后，来源与审批关系仍可查询，失败事务不会留下悬空证据。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../../axiom/bench/io.ts";
import { applicableExperience } from "../../axiom/context/experience.ts";
import { paperEvidence } from "../../axiom/research/workspace/paper.ts";
import { Workspace } from "../../axiom/research/workspace/store.ts";

test("WS-01 validates exact source location, provenance and cross-process-readable identity", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "axiom-workspace-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "paper.md");
	const text = "Title\nA fixed evaluation protocol.\n";
	await writeFile(path, text);
	const sha = sha256(text);
	const metadata = { title: "Title", authors: [], claims: [{ statement: "Uses a fixed protocol", excerpt: "fixed evaluation protocol", location: 2 }] };
	await assert.rejects(paperEvidence(path, sha, { ...metadata, claims: [{ ...metadata.claims[0], location: 1 }] }), /does not match/);
	await assert.rejects(paperEvidence(path, "f".repeat(64), metadata), /digest mismatch/);
	const { nodes, relations } = await paperEvidence(path, sha, metadata);
	const workspace = new Workspace(root);
	const project = workspace.create("Controlled study", "Compare fixed validation protocols");
	workspace.link(project.id, nodes, relations);
	workspace.link(project.id, nodes, relations);
	assert.throws(() => workspace.link(project.id, [{ id: "bad", kind: "claim", data: {} }], [
		{ from: "bad", to: "missing", kind: "source", source: sha, status: "verified" },
	]));
	workspace.setStatus(project.id, "paused");
	workspace.close();
	const reopened = new Workspace(root);
	try {
		const observed = reopened.read(project.id);
		assert.equal(observed.project.status, "paused");
		assert.equal(observed.nodes.length, 2);
		assert.equal(observed.relations.length, 1);
		assert.equal(observed.relations[0].source, sha);
	} finally { reopened.close(); }
});

test("WS-02 scoped facts and rule repair have distinct eligibility", () => {
	const scope = { dataset: "d", protocol: "tiny-validation-v1", split: "validation" };
	const evidence = { task: "tiny-xor-v1", kind: "hyperparameter", condition: "learning_rate", revalidated: true, scope };
	assert.equal(applicableExperience(evidence, "tiny-xor-v1", scope), true);
	assert.equal(applicableExperience(evidence, "tiny-xor-v1", { ...scope, dataset: "foreign" }), false);
	assert.equal(applicableExperience(evidence, "tiny-xor-v1", { ...scope, protocol: "foreign" }), false);
	assert.equal(applicableExperience({ ...evidence, revalidated: false }, "tiny-xor-v1", scope), false);
	assert.equal(applicableExperience({ ...evidence, condition: "static_review" }, "tiny-xor-v1", undefined, "invalid_candidate"), true);
	assert.equal(applicableExperience({ ...evidence, condition: "static_review" }, "tiny-xor-v1", scope), false);
});

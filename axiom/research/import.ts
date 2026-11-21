// 只读导入已有训练记录。输入摘要证明文件身份，日志里的指标仍是项目自报。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { type Digest, inside, sha256 } from "../bench/io.ts";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const label = Type.String({ minLength: 1, maxLength: 200 });
const roles = ["source", "config", "dataset", "environment", "checkpoint", "evaluator", "log"] as const;
const role = Type.Union([...roles, "record" as const].map((name) => Type.Literal(name)));
const schema = Type.Object(
	{
		version: Type.Literal(1),
		project: label,
		run_id: label,
		execution_status: Type.Union([
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("interrupted"),
			Type.Literal("unknown"),
		]),
		revision: Type.Union([Type.String({ pattern: "^[a-f0-9]{40,64}$" }), Type.Null()]),
		dataset: label,
		split: Type.Union([Type.Literal("development"), Type.Literal("validation"), Type.Literal("holdout")]),
		protocol: label,
		seed: Type.Union([Type.Integer({ minimum: 0, maximum: 2147483647 }), Type.Null()]),
		command: Type.Union([Type.String({ minLength: 1, maxLength: 8000 }), Type.Null()]),
		metrics: Type.Record(Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_.-]{0,39}$" }), Type.Number()),
		artifacts: Type.Array(
			Type.Object({ role, path: label, sha256: Type.Union([hash, Type.Null()]) }, { additionalProperties: false }),
			{ minItems: 1, maxItems: 40 },
		),
	},
	{ additionalProperties: false },
);

export type ResearchImport = Static<typeof schema>;
export type Reproduction =
	| "imported_unverified"
	| "evidence_verified"
	| "evaluation_reproduced"
	| "training_reproduced";

// 实验协议与分片都必须匹配。缺少真实文件身份时无法直接比较。
export interface ComparableRun {
	dataset: string | null;
	implementation: string | null;
	protocol: string;
	split: ResearchImport["split"];
}

export function comparisonRefusal(left: ComparableRun, right: ComparableRun): string[] {
	return (["dataset", "implementation", "protocol", "split"] as const).filter(
		(key) => !left[key] || left[key] !== right[key],
	);
}

// 流式读取大型 checkpoint，只计算摘要，不反序列化或执行导入代码。
async function artifactDigest(root: string, name: string): Promise<Digest> {
	const path = join(root, name);
	if (!inside(root, path) || !(await lstat(path)).isFile() || !inside(root, await realpath(path)))
		throw new Error("Untrusted research artifact path");
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const part of createReadStream(path)) {
		hash.update(part);
		bytes += Buffer.byteLength(part);
	}
	return { path: name, sha256: hash.digest("hex"), bytes };
}

export interface ImportedRun {
	version: 1;
	manifest_sha256: string;
	manifest: ResearchImport;
	status: Reproduction;
	metrics_status: "reported_only";
	comparison: ComparableRun;
	artifacts: (Digest & { role: ResearchImport["artifacts"][number]["role"]; pinned: boolean })[];
	missing: string[];
}

export async function importResearch(root: string, manifestPath: string, sha: string): Promise<ImportedRun> {
	root = await realpath(root);
	const bytes = await readFile(manifestPath);
	if (sha256(bytes) !== sha) throw new Error("Import manifest digest mismatch");
	const input: unknown = JSON.parse(bytes.toString());
	if (
		!Check(schema, input) ||
		Object.values(input.metrics).some((value) => !Number.isFinite(value)) ||
		new Set(input.artifacts.map(({ path }) => path)).size !== input.artifacts.length
	)
		throw new Error("Invalid research import manifest");
	const artifacts: ImportedRun["artifacts"] = [];
	for (const item of input.artifacts) {
		const observed = await artifactDigest(root, item.path);
		if (item.sha256 && item.sha256 !== observed.sha256)
			throw new Error(`Research artifact digest changed: ${item.path}`);
		artifacts.push({ ...observed, role: item.role, pinned: item.sha256 !== null });
	}
	const pinned = (name: string): (typeof artifacts)[number] | undefined =>
		artifacts.find((row) => row.role === name && row.pinned);
	const missing: string[] = roles.filter((name) => !pinned(name));
	if (!input.revision) missing.push("revision");
	if (!input.command) missing.push("command");
	if (input.seed === null) missing.push("seed");
	return {
		version: 1,
		manifest_sha256: sha,
		manifest: input,
		status: missing.length ? "imported_unverified" : "evidence_verified",
		metrics_status: "reported_only",
		artifacts,
		missing,
		comparison: {
			dataset: pinned("dataset")?.sha256 ?? null,
			implementation: pinned("source")?.sha256 ?? null,
			protocol: input.protocol,
			split: input.split,
		},
	};
}

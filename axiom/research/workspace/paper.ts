// 操作者固定原文摘要和定位。PDF 使用本地 Poppler，正文始终作为数据。
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { childOutput, sha256 } from "../../bench/io.ts";
import type { Node, Relation } from "./store.ts";

const label = Type.String({ minLength: 1, maxLength: 500 });
const manifest = Type.Object(
	{
		title: label,
		authors: Type.Array(label, { maxItems: 50 }),
		identifier: Type.Optional(label),
		claims: Type.Array(
			Type.Object(
				{
					statement: label,
					excerpt: label,
					location: Type.Integer({ minimum: 1, maximum: 50000 }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 25 },
		),
	},
	{ additionalProperties: false },
);

// 只解析有上限的普通文件；避免通过设备文件、大文件或链接绕过操作员输入边界。
export async function documentBytes(path: string, limit: number): Promise<Buffer> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size > limit) throw new Error("Expected bounded local research document");
	const value = await readFile(path);
	if (value.length > limit) throw new Error("Research document exceeded its limit");
	return value;
}

export async function paperEvidence(
	path: string,
	sha: string,
	raw: unknown,
): Promise<{ nodes: Node[]; relations: Relation[] }> {
	if (!Check(manifest, raw)) throw new Error("Invalid paper metadata or citation locator");
	const bytes = await documentBytes(path, 20 * 1024 * 1024);
	if (sha256(bytes) !== sha) throw new Error("Paper source digest mismatch");
	const format = extname(path).toLowerCase();
	if (![".pdf", ".md", ".txt", ".json"].includes(format)) throw new Error("Unsupported paper input");
	const paper = `paper-${sha}`;
	const nodes: Node[] = [
		{
			id: paper,
			kind: "paper",
			data: {
				title: raw.title,
				authors: raw.authors,
				identifier: raw.identifier,
				source_sha256: sha,
				format,
				file_name: basename(path),
			},
		},
	];
	const relations: Relation[] = [];
	let lines = bytes.toString("utf8").split(/\r?\n/);
	if (format === ".pdf") {
		// 提取固定字节的快照，页分隔符由 pdftotext 输出。
		const temp = await mkdtemp(join(tmpdir(), "axiom-paper-"));
		try {
			const input = join(temp, "input.pdf");
			await writeFile(input, bytes, { flag: "wx" });
			const result = await childOutput(
				"pdftotext",
				["-enc", "UTF-8", input, "-"],
				temp,
				AbortSignal.timeout(15_000),
			);
			lines = result.stdout.split("\f");
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}
	for (const claim of raw.claims) {
		const normalized = (value: string): string => value.replace(/\s+/g, " ").trim();
		const located = lines[claim.location - 1];
		if (!located || !normalized(claim.excerpt) || !normalized(located).includes(normalized(claim.excerpt)))
			throw new Error("Paper excerpt does not match its page or line");
		const id = `claim-${sha256(JSON.stringify([paper, claim]))}`;
		nodes.push({
			id,
			kind: "claim",
			data: {
				...(claim satisfies Static<typeof manifest>["claims"][number]),
				locator_kind: format === ".pdf" ? "page" : "line",
				source_sha256: sha,
			},
		});
		// “已核对”只证明原文定位。操作者释义单独保留为 reported。
		relations.push({ from: paper, to: id, kind: "contains_located_excerpt", source: sha, status: "verified" });
	}
	return { nodes, relations };
}

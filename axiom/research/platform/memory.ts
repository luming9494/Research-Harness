// Qdrant 只保存可重建的向量和索引身份。返回文字必须从本地固定目录重新解析。
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { runProcess } from "../../../packages/coding-agent/src/axiom/execution/process.ts";
import { digest, sha256 } from "../../bench/io.ts";
import type { Experience } from "../../context/experience.ts";
import { localEndpoint, PlatformHttpError, request } from "./http.ts";

export interface MemoryEntry {
	id: string;
	runId: string;
	taskId: string;
	experience: Experience;
}

export interface Catalog {
	version: 1;
	entries: MemoryEntry[];
}

export type Encoder = (text: string[], mode: "document" | "query") => Promise<number[][]>;

function wslPath(path: string): string {
	const match = /^([A-Za-z]):[\\/](.+)$/.exec(path);
	if (!match) throw new Error("Embedding path must be on a mounted Windows drive");
	return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

// 使用原有 CPU BGE 缓存。Windows 通过已配置 WSL 解释器直接执行固定入口。
export function bgeEncoder(repo: string): Encoder {
	return async (texts, mode): Promise<number[][]> => {
		const model = process.env.AXIOM_BGE_MODEL;
		const python = process.env.AXIOM_BGE_PYTHON;
		const script = join(repo, "axiom/rag/encode-experience.py");
		if (
			!model ||
			!isAbsolute(model) ||
			!python ||
			texts.length < 1 ||
			texts.length > 16 ||
			texts.some((v) => !v || v.length > 400)
		)
			throw new Error("BGE model, interpreter and bounded input required");
		const args = [
			"--model",
			process.platform === "win32" ? wslPath(model) : model,
			"--texts",
			Buffer.from(JSON.stringify(texts)).toString("base64"),
			...(mode === "query" ? ["--query"] : []),
		];
		const command =
			process.platform === "win32" ? join(process.env.SystemRoot ?? "C:/Windows", "System32", "wsl.exe") : python;
		if (!python.startsWith("/") || /[\r\n\0]/.test(python))
			throw new Error("BGE Python must use an absolute Linux path");
		const call =
			process.platform === "win32"
				? ["-d", "Ubuntu-24.04", "--exec", python, wslPath(script), ...args]
				: [script, ...args];
		// 批量索引可与本地训练并行，查询仍使用较短的交互时限。
		const result = await runProcess(command, call, {
			cwd: repo,
			home: repo,
			timeoutMs: mode === "document" ? 30_000 : 10_000,
			maxBytes: 500_000,
		});
		if (result.code !== 0 || result.stopped) throw new Error("Pinned BGE encoder unavailable");
		const output: unknown = JSON.parse(result.stdout);
		if (
			!Array.isArray(output) ||
			output.length !== texts.length ||
			output.some(
				(row) =>
					!Array.isArray(row) ||
					row.length !== 384 ||
					row.some((v) => typeof v !== "number" || !Number.isFinite(v)),
			)
		)
			throw new Error("Invalid BGE vector response");
		return output as number[][];
	};
}

export function memoryCollection(catalog: Catalog): string {
	return `axiom_exp_${sha256(JSON.stringify(catalog)).slice(0, 24)}`;
}

export async function indexMemory(origin: URL, catalog: Catalog, encode: Encoder): Promise<string> {
	// 未复验条目不得写入标记为可信的集合。
	if (catalog.entries.some(({ experience }) => !experience.revalidated))
		throw new Error("Memory catalog contains unverified entries");
	const name = memoryCollection(catalog);
	const path = `/collections/${name}`;
	try {
		await request(origin, path);
	} catch (err) {
		if (!(err instanceof PlatformHttpError) || err.status !== 404) throw err;
		await request(origin, path, "PUT", { vectors: { size: 384, distance: "Cosine" } });
	}
	for (let start = 0; start < catalog.entries.length; start += 12) {
		const entries = catalog.entries.slice(start, start + 12);
		const vectors = await encode(
			entries.map(({ experience }) => `${experience.problem} ${experience.result}`),
			"document",
		);
		await request(origin, `${path}/points?wait=true`, "PUT", {
			points: entries.map(({ id, runId, taskId, experience }, i) => ({
				id,
				vector: vectors[i],
				payload: {
					run_id: runId,
					task_id: taskId,
					condition: experience.condition,
					evidence_sha256: experience.sha256,
					status: "revalidated",
					...(experience.scope ? { task: experience.task, ...experience.scope } : {}),
				},
			})),
		});
	}
	return name;
}

export async function searchMemory(
	origin: URL,
	catalog: Catalog,
	encode: Encoder,
	query: string,
	condition?: string,
	limit = 3,
	scope?: Experience["scope"],
): Promise<MemoryEntry[]> {
	const must = [{ key: "status", match: { value: "revalidated" } }];
	if (condition) must.push({ key: "condition", match: { value: condition } });
	// 远端过滤和固定本地目录各核对一次，防止相似向量绕过协议边界。
	if (scope)
		for (const [key, value] of Object.entries({ task: "tiny-xor-v1", ...scope }))
			must.push({ key, match: { value } });
	const [vector] = await encode([query], "query");
	const response = await request<{ result: { points: { id: unknown; payload: Record<string, unknown> }[] } }>(
		origin,
		`/collections/${memoryCollection(catalog)}/points/query`,
		"POST",
		{ query: vector, with_payload: true, filter: { must }, limit },
	);
	const accepted = new Set<string>();
	return response.result.points
		.flatMap(({ id, payload }) => {
			const source = catalog.entries.find((row) => row.id === id);
			if (
				!source ||
				accepted.has(source.id) ||
				!source.experience.revalidated ||
				payload.status !== "revalidated" ||
				payload.run_id !== source.runId ||
				payload.task_id !== source.taskId ||
				payload.evidence_sha256 !== source.experience.sha256 ||
				payload.condition !== source.experience.condition ||
				(condition && source.experience.condition !== condition) ||
				(scope &&
					(!source.experience.kind ||
						payload.task !== source.experience.task ||
						Object.entries(scope).some(([key, value]) => payload[key] !== value) ||
						source.experience.scope?.dataset !== scope.dataset ||
						source.experience.scope.protocol !== scope.protocol ||
						source.experience.scope.split !== scope.split))
			)
				return [];
			accepted.add(source.id);
			return [source];
		})
		.slice(0, limit);
}

// 会话读取经操作者批准的本地目录摘要，异常自动退回原经验来源。
export async function tinyMemoryScope(repo: string): Promise<NonNullable<Experience["scope"]>> {
	// 复用科研矩阵为 Tiny 冻结的数据生成器身份。
	return {
		dataset: sha256(JSON.stringify([await digest(repo, "examples/tiny-ml-eval/common.py")])),
		protocol: "tiny-validation-v1",
		split: "validation",
	};
}

export async function configuredMemory(
	repo: string,
	query: string,
	scope: Experience["scope"],
): Promise<Experience[] | undefined> {
	const path = process.env.AXIOM_MEMORY_CATALOG;
	const sha = process.env.AXIOM_MEMORY_CATALOG_SHA;
	const endpoint = process.env.AXIOM_QDRANT_ENDPOINT;
	if (!path || !sha || !endpoint) return undefined;
	try {
		if (!isAbsolute(path)) throw new Error("Memory catalog must be absolute");
		const bytes = await readFile(path);
		if (sha256(bytes) !== sha.toLowerCase()) throw new Error("Memory catalog digest mismatch");
		const catalog = JSON.parse(bytes.toString()) as Catalog;
		if (catalog.version !== 1) throw new Error("Unsupported memory catalog");
		const origin = localEndpoint(endpoint);
		await request(origin, `/collections/${memoryCollection(catalog)}`);
		const rows = await searchMemory(origin, catalog, bgeEncoder(repo), query.slice(0, 400), undefined, 3, scope);
		return rows.map(({ experience }) => experience);
	} catch {
		return [];
	}
}

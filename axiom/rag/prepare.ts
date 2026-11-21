// 宿主交付后才启动留出编码，向量准备能力不会注册成 Pi 工具。
import { isAbsolute, join } from "node:path";
import { childOutput } from "../bench/io.ts";
import type { DenseSource } from "./dense.ts";

export function encoderSettings(): { python: string; model: string } {
	const python = process.env.AXIOM_RAG_EMBED_PYTHON;
	const model = process.env.AXIOM_RAG_EMBED_MODEL;
	if (!python || !model || !isAbsolute(model) || !(isAbsolute(python) || python.startsWith("/")))
		throw new Error("Set AXIOM_RAG_EMBED_PYTHON and AXIOM_RAG_EMBED_MODEL to trusted absolute paths");
	return { python, model };
}

export async function prepareHoldout(
	repo: string,
	data: string,
	vectors: string,
	signal: AbortSignal,
): Promise<DenseSource> {
	const { python, model } = encoderSettings();
	const paths = [join(repo, "axiom/rag/embed.py"), data, model, vectors];
	const windows = process.platform === "win32";
	// Windows 的 Pi 仍在原生进程运行，官方 CPU 编码在已有 WSL2 Python 环境中执行。
	const [script, dataPath, modelPath, vectorPath] = windows
		? await Promise.all(
				paths.map(
					async (path): Promise<string> =>
						(await childOutput("wsl.exe", ["--exec", "wslpath", "-a", path], repo, signal)).stdout.trim(),
				),
			)
		: paths;
	const args = [script, "--data", dataPath, "--model", modelPath, "--out", vectorPath, "--split", "holdout"];
	const output = await childOutput(
		windows ? "wsl.exe" : python,
		windows ? ["--exec", python, ...args] : args,
		repo,
		signal,
	);
	const sha = output.stdout.trim();
	if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("Holdout encoder returned no verified manifest");
	return { root: vectors, sha };
}

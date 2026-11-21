// 使用独立入口扩展 AXIOM-Bench，保留 WP-09.2 的历史判题文件身份。
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { file } from "../bench/io.ts";
import { runLiveCase } from "./benchmark.ts";
import { runCoreCase } from "./core.ts";
import { verifyRagArchive } from "./verify.ts";

async function main(): Promise<void> {
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			data: { type: "string" },
			out: { type: "string" },
			model: { type: "string" },
			sha: { type: "string" },
			vectors: { type: "string" },
			"vector-sha": { type: "string" },
		},
	});
	const [mode, archive] = positionals;
	if (!values.data) throw new Error("Set --data to the extracted frozen SciFact data directory");
	const data = resolve(values.data);
	if (mode === "verify" && archive && positionals.length === 2 && values.sha && !values.model && !values.out) {
		console.log(
			JSON.stringify(
				await verifyRagArchive(
					resolve(archive),
					data,
					values.sha,
					values.vectors ? resolve(values.vectors) : undefined,
				),
			),
		);
		return;
	}
	if (
		positionals.length !== 1 ||
		values.sha ||
		(mode !== "core" && mode !== "live") ||
		(mode === "live" ? !values.model : values.model !== undefined)
	)
		throw new Error("Choose core, live --model provider/model, or verify ARCHIVE --sha SHA256");
	const out = resolve(values.out ?? join(repo, "private", "axiom-rag"));
	const embedding =
		values.vectors && values["vector-sha"] && /^[a-f0-9]{64}$/i.test(values["vector-sha"])
			? { root: resolve(values.vectors), sha: values["vector-sha"].toLowerCase() }
			: undefined;
	if ((values.vectors || values["vector-sha"]) && (!embedding || mode !== "live"))
		throw new Error("Hybrid live requires --vectors and --vector-sha");
	// core 始终离线，live 才能运行真实模型。
	const root = values.model
		? await runLiveCase(repo, data, out, values.model, embedding)
		: await runCoreCase(repo, data, out);
	const result = JSON.parse((await file(root, "result.json")).toString()) as {
		task_success: { status: string };
		harness_correctness: { status: string };
	};
	console.log(
		JSON.stringify({
			root,
			task_success: result.task_success.status,
			harness_correctness: result.harness_correctness.status,
		}),
	);
	if (result.task_success.status !== "pass" || result.harness_correctness.status !== "pass") process.exitCode = 1;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "RAG benchmark failed");
	process.exitCode = 1;
});

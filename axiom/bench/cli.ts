// 命令行只允许选择主机内置 Case，缺省入口不发起付费请求。
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cases, selectCases } from "./cases.ts";
import { attributeArchive, runBatch, verifyRun } from "./runner.ts";

async function main(): Promise<void> {
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const { values } = parseArgs({
		options: {
			case: { type: "string", multiple: true },
			profile: { type: "string" },
			out: { type: "string" },
			verify: { type: "string" },
			attribute: { type: "string" },
			list: { type: "boolean" },
			phase: { type: "string" },
			repeats: { type: "string" },
			help: { type: "boolean" },
		},
		strict: true,
	});
	if (values.help) {
		console.log(
			"npm run bench:axiom -- [--profile core|smoke|live|comparison|mechanisms|trace|context | --case ID ...] [--out DIR] [--list]\n" +
				"npm run bench:axiom -- --profile comparison --phase pilot|formal [--repeats N]\n" +
				"npm run bench:axiom -- --verify <case-run-directory>\n" +
				"npm run bench:axiom -- --attribute <case-run-directory> [--out EXISTING-DIR]",
		);
		return;
	}
	if (values.attribute) {
		if (values.verify || values.profile || values.case || values.list || values.phase || values.repeats)
			throw new Error("--attribute only accepts --out");
		const root = await attributeArchive(resolve(values.attribute), resolve(values.out ?? join(repo, "private")));
		console.log(JSON.stringify({ root }));
		return;
	}
	if (values.verify) {
		if (values.profile || values.case || values.out || values.list || values.phase || values.repeats)
			throw new Error("--verify is a standalone command");
		const result = await verifyRun(repo, resolve(values.verify));
		console.log(JSON.stringify(result, null, 2));
		process.exitCode = result.matches_expected ? 0 : 1;
		return;
	}
	const selected = selectCases(values.profile, values.case ?? []);
	const phase = values.phase ?? (values.profile === "comparison" ? "pilot" : undefined);
	if (phase !== undefined && phase !== "pilot" && phase !== "formal") throw new Error("Unknown comparison phase");
	if ((phase || values.repeats) && (!phase || !selected.every((item) => item.comparison)))
		throw new Error("Comparison options require comparison cases");
	const repeats = Number(values.repeats ?? (phase === "formal" ? 3 : 1));
	if (values.list) {
		const listed = values.profile || values.case ? selected : cases;
		console.log(
			JSON.stringify(
				listed.map(({ id, version, mode, split }) => ({ id, version, mode, split })),
				null,
				2,
			),
		);
		return;
	}
	const signal = new AbortController();
	const interrupt = (): void => signal.abort(new Error("Benchmark interrupted"));
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		const python = resolve(
			process.env.AXIOM_PYTHON ??
				join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
		);
		const { root, results } = await runBatch(
			repo,
			python,
			resolve(values.out ?? join(repo, "private", "axiom-bench")),
			selected,
			signal.signal,
			phase ? { phase, repeats } : undefined,
		);
		console.log(
			JSON.stringify(
				{
					root,
					results: results.map((run) => ({
						case_id: run.case_id,
						run_id: run.run_id,
						status: run.status,
						matches_expected: run.matches_expected,
						task_success: run.task_success.status,
						harness_correctness: run.harness_correctness.status,
					})),
				},
				null,
				2,
			),
		);
		// 正式任务的失败是一条结果；仅报告运行器中断或缺失，不能筛掉不利样本。
		process.exitCode = signal.signal.aborted
			? 130
			: phase
				? results.every((result) => result.status === "completed")
					? 0
					: 1
				: results.every((result) => result.matches_expected)
					? 0
					: 1;
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

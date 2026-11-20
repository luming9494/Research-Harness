// 命令行只允许选择主机内置 Case，缺省入口不发起付费请求。
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { selectCases } from "./cases.ts";
import { runBatch, verifyRun } from "./runner.ts";

async function main(): Promise<void> {
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const { values } = parseArgs({
		options: {
			case: { type: "string", multiple: true },
			profile: { type: "string" },
			out: { type: "string" },
			verify: { type: "string" },
			list: { type: "boolean" },
			help: { type: "boolean" },
		},
		strict: true,
	});
	if (values.help) {
		console.log(
			"npm run bench:axiom -- [--profile core|smoke|live | --case ID ...] [--out DIR] [--list]\n" +
				"npm run bench:axiom -- --verify <case-run-directory>",
		);
		return;
	}
	if (values.verify) {
		if (values.profile || values.case || values.out || values.list)
			throw new Error("--verify is a standalone command");
		const result = await verifyRun(repo, resolve(values.verify));
		console.log(JSON.stringify(result, null, 2));
		process.exitCode = result.matches_expected ? 0 : 1;
		return;
	}
	const selected = selectCases(values.profile, values.case ?? []);
	if (values.list) {
		const listed = values.profile || values.case ? selected : [...selected, ...selectCases("live", [])];
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
		process.exitCode = signal.signal.aborted ? 130 : results.every((result) => result.matches_expected) ? 0 : 1;
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

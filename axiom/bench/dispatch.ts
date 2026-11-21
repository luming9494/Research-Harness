// 统一 Case 发现和调度。Tiny 入口保留原始源码及评分身份。
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runLiveCase } from "../rag/benchmark.ts";
import { runCoreCase } from "../rag/core.ts";
import { verifyRagArchive } from "../rag/verify.ts";
import { cases, selectCases } from "./cases.ts";
import { file, json } from "./io.ts";
import { runBatch } from "./runner.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const rag = [
	{ id: "RAG-CORE-01", version: 1, mode: "fixed_parameters", split: "development", profile: "rag" },
	{ id: "RAG-LIVE-01", version: 1, mode: "live_agent", split: "development", profile: "rag-live" },
	{ id: "RAG-HYBRID-01", version: 2, mode: "live_agent", split: "development", profile: "rag-hybrid" },
] as const;
type Status = "pass" | "fail" | "unknown";
interface Summary {
	case_id: string;
	run_id: string | null;
	status: string;
	matches_expected: boolean;
	task_success: Status;
	harness_correctness: Status;
	wall_seconds?: number | null;
	compute_seconds?: number | null;
	usage?: { requests: number | null; tokens: number | null; estimated_cost_usd: number | null };
	path?: string;
	error?: string;
}

// 保留旧命令参数、输出和退出码，避免破坏已发布 Tiny 归档。
function tinyCli(argv: string[]): Promise<void> {
	return new Promise((done, fail) => {
		const child = spawn(process.execPath, [...process.execArgv, join(repo, "axiom/bench/cli.ts"), ...argv], {
			stdio: "inherit",
		});
		child.once("error", fail);
		child.once("close", (code) => {
			process.exitCode = code ?? 1;
			done();
		});
	});
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const { values } = parseArgs({
		args: argv,
		options: {
			case: { type: "string", multiple: true },
			profile: { type: "string" },
			out: { type: "string" },
			verify: { type: "string" },
			attribute: { type: "string" },
			sandbox: { type: "string" },
			list: { type: "boolean" },
			help: { type: "boolean" },
			phase: { type: "string" },
			repeats: { type: "string" },
			data: { type: "string" },
			model: { type: "string" },
			vectors: { type: "string" },
			"vector-sha": { type: "string" },
			sha: { type: "string" },
		},
	});
	if (values.help) {
		await tinyCli(argv);
		console.log(
			"npm run bench:axiom -- --profile rag|rag-live|rag-hybrid --data DIR [--model provider/model] [--vectors DIR --vector-sha SHA]",
		);
		console.log("npm run bench:axiom -- --verify RUN --data DIR --sha SHA [--vectors DIR]");
		return;
	}
	if (
		values.verify &&
		!values.profile &&
		!values.case &&
		!values.list &&
		!values.out &&
		!values.phase &&
		!values.repeats &&
		!values.attribute &&
		!values.sandbox &&
		!values.model &&
		!values["vector-sha"]
	) {
		const root = resolve(values.verify);
		const manifest = JSON.parse((await file(root, "manifest.json")).toString()) as { case_id?: string };
		if (rag.some(({ id }) => id === manifest.case_id)) {
			if (!values.data || !values.sha) throw new Error("RAG verification requires --data and --sha");
			console.log(
				JSON.stringify(
					await verifyRagArchive(
						root,
						resolve(values.data),
						values.sha,
						values.vectors ? resolve(values.vectors) : undefined,
					),
					null,
					2,
				),
			);
			return;
		}
	}
	const profile = rag.find((item) => item.profile === values.profile);
	const requested = values.case ?? [];
	const selected = rag.filter((item) => item === profile || requested.includes(item.id));
	const simple = ({ id, version, mode, split }: (typeof cases)[number]): object => ({ id, version, mode, split });
	if (values.list && !values.profile && !requested.length) {
		console.log(JSON.stringify([...cases.map(simple), ...rag], null, 2));
		return;
	}
	if (!selected.length) return tinyCli(argv);
	if (
		(values.profile && (!profile || requested.length)) ||
		values.verify ||
		values.attribute ||
		values.sandbox ||
		values.phase ||
		values.repeats
	)
		throw new Error("RAG selection accepts one RAG profile or explicit Case IDs");
	const ids = requested.filter((id) => !selected.some((item) => item.id === id));
	const tiny = ids.length ? selectCases(undefined, ids) : [];
	if (values.list) {
		console.log(JSON.stringify([...tiny.map(simple), ...selected], null, 2));
		return;
	}
	if (!values.data || (selected.some(({ mode }) => mode === "live_agent") && !values.model))
		throw new Error("RAG needs --data, and live Cases require an explicit --model");
	const vectorSha = values["vector-sha"];
	const vectors =
		values.vectors && vectorSha && /^[a-f0-9]{64}$/i.test(vectorSha)
			? { root: resolve(values.vectors), sha: vectorSha.toLowerCase() }
			: undefined;
	if (selected.some(({ id }) => id === "RAG-HYBRID-01") && !vectors)
		throw new Error("Hybrid requires --vectors and an approved --vector-sha");
	const data = resolve(values.data);
	const out = resolve(values.out ?? join(repo, "private", "axiom-bench"));
	const signal = new AbortController();
	const abort = (): void => signal.abort(new Error("Benchmark interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	try {
		await mkdir(out, { recursive: true });
		const root = await mkdtemp(join(out, "domains-"));
		const planned = [...tiny, ...selected].map(({ id }) => id);
		await json(root, "plan.json", { version: 1, planned });
		const results: Summary[] = [];
		if (tiny.length) {
			const python = resolve(
				process.env.AXIOM_PYTHON ??
					join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
			);
			const batch = await runBatch(repo, python, join(root, "tiny"), tiny, signal.signal);
			results.push(
				...batch.results.map(
					(row): Summary => ({
						case_id: row.case_id,
						run_id: row.run_id,
						status: row.status,
						task_success: row.task_success.status,
						harness_correctness: row.harness_correctness.status,
						matches_expected: row.matches_expected,
						wall_seconds: row.wall_seconds,
						compute_seconds: row.compute_seconds,
						usage: row.usage,
						path: join(batch.root, row.case_id),
					}),
				),
			);
		}
		for (const item of selected) {
			if (signal.signal.aborted) break;
			// Case 的失败也是可审计结果，批次成功率始终使用计划分母。
			try {
				const path =
					item.mode === "fixed_parameters"
						? await runCoreCase(repo, data, root)
						: await runLiveCase(
								repo,
								data,
								root,
								values.model ?? "",
								item.id === "RAG-HYBRID-01" ? vectors : undefined,
								signal.signal,
							);
				const row = JSON.parse((await file(path, "result.json")).toString()) as {
					run_id: string;
					status?: string;
					task_success: { status: Status };
					harness_correctness: { status: Status };
					budget?: { wall_seconds: number; compute_process_seconds: number } | null;
					usage?: Summary["usage"];
				};
				results.push({
					case_id: item.id,
					run_id: row.run_id,
					status: row.status ?? "completed",
					path,
					task_success: row.task_success.status,
					harness_correctness: row.harness_correctness.status,
					matches_expected: row.task_success.status === "pass" && row.harness_correctness.status === "pass",
					wall_seconds: row.budget?.wall_seconds ?? null,
					compute_seconds: row.budget?.compute_process_seconds ?? null,
					usage: row.usage,
				});
			} catch (error) {
				results.push({
					case_id: item.id,
					run_id: null,
					status: "error",
					task_success: "unknown",
					harness_correctness: "unknown",
					matches_expected: false,
					error: error instanceof Error ? error.message : "RAG execution failed",
				});
			}
		}
		const passed = results.filter(({ matches_expected }) => matches_expected).length;
		const summary = {
			root,
			status: results.length === planned.length ? "completed" : "incomplete",
			planned: planned.length,
			executed: results.length,
			passed,
			success_rate: passed / planned.length,
			task_successes: results.filter(({ task_success }) => task_success === "pass").length,
			harness_passes: results.filter(({ harness_correctness }) => harness_correctness === "pass").length,
			results,
		};
		await json(root, "summary.json", summary);
		console.log(JSON.stringify(summary, null, 2));
		process.exitCode = signal.signal.aborted ? 130 : passed === planned.length ? 0 : 1;
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

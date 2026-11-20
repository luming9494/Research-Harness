// 统一运行、存档与复核已批准的 Case。运行器从不接受用户提供的判题代码。
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { type BenchCase, selectCases } from "./cases.ts";
import { schedule, summarize } from "./comparison.ts";
import { executeCase } from "./execute.ts";
import { type Grading, grade, independentGrades, liveUsage } from "./grader.ts";
import { childOutput, type Digest, digest, file, inside, json, save, sha256 } from "./io.ts";
import type { LiveTrace } from "./live.ts";
import { TraceEvidence } from "./trace-evidence.ts";
import { attributionPaths, saveSource, saveTrace, traceFiles, traceOutput } from "./trace-report.ts";

const graderAssets = [
	"axiom/bench/cases.ts",
	"axiom/bench/cli.ts",
	"axiom/bench/grader.ts",
	"axiom/bench/execute.ts",
	"axiom/bench/io.ts",
	"axiom/bench/runner.ts",
	"axiom/bench/comparison.ts",
	"axiom/bench/live.ts",
	...["trace", "trace-evidence", "trace-report", "trace-rpc", "attribution"].map((name) => `axiom/bench/${name}.ts`),
	"axiom/bench/deterministic.ts",
	"axiom/durable/task-runtime.ts",
	"axiom/durable/experiment-ledger.ts",
	...[
		"task-controller",
		"task-executor",
		"task-budget",
		"task-spec",
		"pareto",
		"pareto-artifacts",
		"process",
		"experiment-domain",
	].map((name) => `packages/coding-agent/src/axiom/execution/${name}.ts`),
];
type RunState = "completed" | "timed_out" | "interrupted" | "error" | "integrity_rejected";
interface Manifest {
	schema_version: 1;
	trace_schema_version?: 1;
	case_id: string;
	case_version: number;
	case_sha256: string;
	run_id: string;
	started_at: string;
	wall_seconds: number;
	status: RunState;
	error: string | null;
	environment: {
		node: string;
		platform: string;
		architecture: string;
		python: string;
		python_sha256: string;
		pi: string;
		commit: string | null;
		torch?: string | null;
	};
	budget: BenchCase["budget"];
	inputs: Digest[];
	evidence: Digest[];
}

export interface Result extends Grading {
	schema_version: 1;
	case_id: string;
	case_version: number;
	run_id: string;
	mode: BenchCase["mode"];
	status: RunState;
	matches_expected: boolean;
	wall_seconds: number;
	failures: string[];
	attribution?: typeof attributionPaths;
}

export async function runBatch(
	repo: string,
	python: string,
	output: string,
	cases: readonly BenchCase[],
	signal: AbortSignal,
	comparison?: { phase: "pilot" | "formal"; repeats: number },
): Promise<{ root: string; results: Result[] }> {
	const root = join(output, randomUUID());
	await mkdir(output, { recursive: true });
	await mkdir(root);
	const environment = await runtime(repo, python, signal);
	const plan = comparison
		? schedule(cases, comparison.repeats)
		: cases.map((item) => ({ item, path: item.id, repetition: 1 }));
	if (comparison)
		await json(root, "comparison-plan.json", {
			...comparison,
			environment,
			order: plan.map(({ item, path, repetition }) => ({ item, path, repetition })),
		});
	const results: Result[] = [];
	// 先发布含完整计划分母的汇总，再逐条原子替换。进程被强制终止时仍留有 incomplete。
	const refreshComparison = async (): Promise<void> => {
		if (!comparison) return;
		const status =
			results.length === plan.length && !results.some((result) => result.status === "interrupted")
				? "complete"
				: "incomplete";
		await json(root, "comparison.tmp", {
			schema_version: 2,
			phase: comparison.phase,
			status,
			planned: plan.length,
			executed: results.length,
			passed: results.filter((result) => result.task_success.status === "pass").length,
			interrupted: signal.aborted,
			groups: summarize(plan, results, comparison.phase),
		});
		await rename(join(root, "comparison.tmp"), join(root, "comparison.json"));
	};
	await refreshComparison();
	// 单机串行执行，减少 CPU 噪声，批次目录只含独立运行。
	for (const { item, path } of plan) {
		if (signal.aborted) break;
		const caseRoot = join(root, path);
		await mkdir(caseRoot, { recursive: true });
		results.push(await runCase(repo, python, caseRoot, item, environment, signal));
		await refreshComparison();
	}
	await json(root, "batch.json", {
		schema_version: 1,
		interrupted: signal.aborted,
		requested: cases.map((item) => item.id),
		results,
	});
	if (signal.aborted) await refreshComparison();
	return { root, results };
}

async function runCase(
	repo: string,
	python: string,
	root: string,
	item: BenchCase,
	environment: Manifest["environment"],
	signal: AbortSignal,
): Promise<Result> {
	const deadline = AbortSignal.timeout(item.timeout_ms);
	const combined = AbortSignal.any([signal, deadline]);
	const started = performance.now();
	const started_at = new Date().toISOString();
	const run_id = randomUUID();
	const inputs = await identities(repo, item);
	const case_sha256 = sha256(JSON.stringify(item));
	await json(root, "case.json", item);
	let status: RunState = "completed";
	let error: string | null = null;
	let graded: Grading | undefined;
	try {
		await executeCase(item, root, repo, python, combined);
		combined.throwIfAborted();
		if (
			JSON.stringify(inputs) !== JSON.stringify(await identities(repo, item)) ||
			case_sha256 !== sha256(JSON.stringify(await read(root, "case.json")))
		) {
			status = "integrity_rejected";
			throw new Error("Case or grader identity changed during execution");
		}
		for (const name of item.evidence) await file(root, name);
		graded = await grade(item, root);
		for (const check of [...graded.task_success.checks, ...graded.harness_correctness.checks])
			for (const proof of check.evidence) await file(root, proof);
		combined.throwIfAborted();
	} catch (caught) {
		graded = undefined;
		if (status !== "integrity_rejected")
			status = signal.aborted ? "interrupted" : deadline.aborted ? "timed_out" : "error";
		error = caught instanceof Error ? caught.message : String(caught);
	}
	// 仅记录可公开的宿主终态，避免异常原文进入 Trace。
	await json(root, "runner-status.json", { status });
	const evidence = await Promise.all((await evidenceFiles(root)).map((path) => digest(root, path)));
	const manifest: Manifest = {
		schema_version: 1,
		trace_schema_version: 1,
		case_id: item.id,
		case_version: item.version,
		case_sha256,
		run_id,
		started_at,
		wall_seconds: (performance.now() - started) / 1000,
		status,
		error,
		environment: { ...environment, torch: graded?.torch ?? null },
		budget: item.budget,
		inputs,
		evidence,
	};
	const result = finalResult(item, manifest, graded, await retainedUsage(item, root));
	// 归因在评分完成后运行，四个派生文件随后单独登记入清单。
	await saveTrace(root, await traceOutput(root, manifest, evidence, inputs, result));
	const derived = await Promise.all(traceFiles.map((path) => digest(root, path)));
	manifest.evidence = [...evidence, ...derived].sort((a, b): number =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	await json(root, "manifest.json", manifest);
	await json(root, "result.json", result);
	await save(root, "report.md", report(item, manifest, result));
	return result;
}

// 重算归档评分，先核对 Case、评测资产、证据清单，再检查 result 的原判。
export async function verifyRun(repo: string, root: string): Promise<Result> {
	const manifest = (await read(root, "manifest.json")) as Manifest;
	const [item] = selectCases(undefined, [manifest.case_id]);
	if (
		manifest.schema_version !== 1 ||
		manifest.case_version !== item.version ||
		manifest.case_sha256 !== sha256(JSON.stringify(item)) ||
		manifest.case_sha256 !== sha256(JSON.stringify(await read(root, "case.json"))) ||
		JSON.stringify(manifest.inputs) !== JSON.stringify(await identities(repo, item)) ||
		JSON.stringify(manifest.budget) !== JSON.stringify(item.budget)
	)
		throw new Error("Benchmark Case, asset or grader identity mismatch");
	const archived = await Promise.all((await evidenceFiles(root)).map((path) => digest(root, path)));
	if (JSON.stringify(manifest.evidence) !== JSON.stringify(archived))
		throw new Error("Benchmark evidence digest mismatch");
	if (manifest.status === "completed") for (const name of item.evidence) await file(root, name);
	const result = finalResult(
		item,
		manifest,
		manifest.status === "completed" ? await grade(item, root) : undefined,
		await retainedUsage(item, root),
	);
	if (manifest.trace_schema_version === 1) {
		const raw = archived.filter((item) => !traceFiles.some((name) => name === item.path));
		const derived = await traceOutput(root, manifest, raw, manifest.inputs, result);
		for (const name of traceFiles)
			if ((await file(root, name)).toString("utf8") !== derived[name])
				throw new Error("Saved trace differs from independent derivation");
	}
	if (JSON.stringify(result) !== JSON.stringify(await read(root, "result.json")))
		throw new Error("Saved result differs from independent score");
	return result;
}

// 用原始 Case 和原判复核历史归档，只在新目录写派生归因，保留既有成绩及文件。
export async function attributeArchive(root: string, output: string): Promise<string> {
	const manifestFile = await file(root, "manifest.json");
	const manifest = JSON.parse(manifestFile.toString("utf8")) as Manifest;
	const [item] = selectCases(undefined, [manifest.case_id]);
	if (
		manifest.schema_version !== 1 ||
		manifest.case_version !== item.version ||
		manifest.case_sha256 !== sha256(JSON.stringify(item)) ||
		manifest.case_sha256 !== sha256(JSON.stringify(await read(root, "case.json")))
	)
		throw new Error("Historical Case identity mismatch");
	// 判题器读取的目录必须与旧清单一一对应，避免未登记文件影响重算。
	if (
		JSON.stringify(await evidenceFiles(root)) !== JSON.stringify(manifest.evidence.map((entry) => entry.path).sort())
	)
		throw new Error("Historical evidence inventory mismatch");
	await new TraceEvidence(root, manifest.evidence).verifyAll();
	const replay = finalResult(
		item,
		manifest,
		manifest.status === "completed" ? await grade(item, root) : undefined,
		await retainedUsage(item, root),
	);
	const original = (await read(root, "result.json")) as Result;
	if (
		original.run_id !== manifest.run_id ||
		original.case_id !== item.id ||
		original.status !== manifest.status ||
		JSON.stringify(original.task_success) !== JSON.stringify(replay.task_success) ||
		JSON.stringify(original.harness_correctness) !== JSON.stringify(replay.harness_correctness)
	)
		throw new Error("Historical scores differ from independent evidence");
	const parent = await realpath(output);
	const archive = await realpath(root);
	// 目标目录必须独立，禁止在历史归档内生成文件。
	if (parent === archive || inside(archive, parent))
		throw new Error("Historical attribution needs a separate directory");
	const destination = await mkdtemp(join(parent, "axiom-attribution-"));
	await saveTrace(destination, await traceOutput(root, manifest, manifest.evidence, manifest.inputs, replay));
	await saveSource(destination, sha256(manifestFile));
	return destination;
}

function finalResult(
	item: BenchCase,
	manifest: Manifest,
	graded: Grading | undefined,
	usage: Grading["usage"],
): Result {
	const actual = graded ?? {
		...independentGrades(item, {}, {}),
		usage,
		compute_seconds: null,
		evaluation: [],
		torch: null,
	};
	const failures = [...actual.task_success.checks, ...actual.harness_correctness.checks]
		.filter((check) => check.status !== "pass")
		.map((check) => `${check.id}: ${check.status}`);
	if (manifest.error) failures.push(manifest.error);
	return {
		schema_version: 1,
		case_id: item.id,
		case_version: item.version,
		run_id: manifest.run_id,
		mode: item.mode,
		status: manifest.status,
		wall_seconds: manifest.wall_seconds,
		...actual,
		failures,
		...(manifest.trace_schema_version === 1 ? { attribution: attributionPaths } : {}),
		matches_expected:
			manifest.status === "completed" &&
			actual.task_success.status === item.expected.task &&
			actual.harness_correctness.status === item.expected.harness,
	};
}

// 判题缺失不应抹去已归档的真实请求和用量。
async function retainedUsage(item: BenchCase, root: string): Promise<Grading["usage"]> {
	if (item.mode !== "live_agent") return liveUsage(undefined);
	const [observed, state] = await Promise.all([
		read(root, "observed.json").catch((): undefined => undefined) as Promise<
			Pick<LiveTrace, "usage" | "admitted"> | undefined
		>,
		read(root, "final/ledger.json").catch((): undefined => undefined) as Promise<TaskCheckpoint | undefined>,
	]);
	return liveUsage(observed?.usage, state?.requests.length ?? observed?.admitted);
}

function report(item: BenchCase, manifest: Manifest, result: Result): string {
	const axis = (label: string, score: Grading["task_success"]): string =>
		[
			`${label} — ${score.status} (${score.score ?? "unknown"})`,
			...score.checks.map(
				(check) => `- ${check.id} (${check.weight}): ${check.status}. ${check.evidence.join(", ")}`,
			),
		].join("\n");
	const sections = [
		`# ${item.id} · AXIOM-Bench`,
		`Run ID \`${result.run_id}\`. Mode \`${item.mode}\`. Status \`${result.status}\`. Expected pattern matched: ${result.matches_expected}.`,
		axis("Task Success", result.task_success),
		axis("Harness Correctness", result.harness_correctness),
		`Model requests ${result.usage.requests ?? "unknown"}. Tokens ${result.usage.tokens ?? "unknown"}. Estimated USD ${result.usage.estimated_cost_usd ?? "unknown"}.`,
		`Wall ${result.wall_seconds.toFixed(3)} s. Worker process time ${result.compute_seconds ?? "unknown"} s.`,
		...(result.execution
			? [
					`Execution ${result.execution.outcome}. Stop ${result.execution.stop_reason ?? "unknown"}. Steps ${result.execution.training_steps}. Training launches ${result.execution.training_launches}. Duplicate launches ${result.execution.duplicate_launches}. Provider overrun ${result.execution.provider_overrun}.`,
				]
			: []),
		"## Failure evidence",
		...(result.attribution
			? ["[Trace](trace.jsonl) · [Attribution](attribution.md) · [Evidence index](trace-evidence.json)"]
			: []),
		result.failures.map((failure) => `- ${failure}`).join("\n") || "- None observed.",
		"## Independent evaluation",
		result.evaluation
			.map(
				({ label, id, result, evidence }) =>
					`- ${label}/${id}, accuracy ${result.accuracy ?? "unknown"}, loss ${result.loss ?? "unknown"}, parameters ${result.parameters ?? "unknown"}. [Evidence](${evidence}).`,
			)
			.join("\n") || "- Unavailable in this case.",
		"## Evidence digests",
		...manifest.evidence.map(({ path, sha256 }) => `- [${path}](${path}) \`${sha256}\``),
		"## Limits",
		"A run covers the recorded inputs and environment. Worker elapsed time is not CPU time. Token cost is estimated when Pi reports it. Synthetic fixtures do not measure real model quality.",
	];
	return `${sections.join("\n\n")}\n`;
}

async function identities(repo: string, item: BenchCase): Promise<Digest[]> {
	return Promise.all([...new Set([...graderAssets, ...item.assets])].sort().map((path) => digest(repo, path)));
}

async function evidenceFiles(root: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(join(root, prefix), { withFileTypes: true });
	const paths: string[] = [];
	for (const entry of entries) {
		if (!prefix && ["manifest.json", "report.md", "result.json"].includes(entry.name)) continue;
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) paths.push(...(await evidenceFiles(root, path)));
		else if (entry.isFile()) paths.push(path);
		else throw new Error(`Unexpected evidence entry ${path}`);
	}
	return paths.sort();
}

async function runtime(repo: string, python: string, signal: AbortSignal): Promise<Manifest["environment"]> {
	const info = await childOutput(python, ["--version"], repo, signal);
	const git = await childOutput("git", ["rev-parse", "HEAD"], repo, signal).catch(() => undefined);
	const version = (await read(repo, "packages/coding-agent/package.json")) as { version: string };
	const executable = await realpath(resolve(python));
	const size = await stat(executable);
	if (!size.isFile()) throw new Error("Python executable is not a file");
	const absolute = executable.replaceAll("\\", "/");
	const slash = absolute.lastIndexOf("/");
	const identity = await digest(absolute.slice(0, slash), absolute.slice(slash + 1));
	return {
		node: process.version,
		platform: process.platform,
		architecture: process.arch,
		python: info.stdout.trim(),
		python_sha256: identity.sha256,
		pi: version.version,
		commit: git?.stdout.trim() ?? null,
	};
}

async function read(root: string, path: string): Promise<unknown> {
	return JSON.parse((await file(root, path)).toString("utf8")) as unknown;
}

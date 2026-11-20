// 统一运行、存档与复核已批准的 Case。运行器从不接受用户提供的判题代码。
import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TaskCheckpoint } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { type BenchCase, selectCases } from "./cases.ts";
import { schedule, summarize } from "./comparison.ts";
import { executeCase } from "./execute.ts";
import { type Grading, grade, independentGrades, liveUsage } from "./grader.ts";
import { childOutput, type Digest, digest, file, json, save, sha256 } from "./io.ts";
import type { LiveTrace } from "./live.ts";

const graderAssets = [
	"axiom/bench/cases.ts",
	"axiom/bench/cli.ts",
	"axiom/bench/grader.ts",
	"axiom/bench/execute.ts",
	"axiom/bench/io.ts",
	"axiom/bench/runner.ts",
	"axiom/bench/comparison.ts",
	"axiom/bench/live.ts",
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
	// 单机串行执行，减少 CPU 噪声，批次目录只含独立运行。
	for (const { item, path } of plan) {
		if (signal.aborted) break;
		const caseRoot = join(root, path);
		await mkdir(caseRoot, { recursive: true });
		results.push(await runCase(repo, python, caseRoot, item, environment, signal));
	}
	await json(root, "batch.json", {
		schema_version: 1,
		interrupted: signal.aborted,
		requested: cases.map((item) => item.id),
		results,
	});
	if (comparison)
		await json(root, "comparison.json", {
			schema_version: 1,
			phase: comparison.phase,
			interrupted: signal.aborted,
			groups: summarize(plan, results),
		});
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
	const evidence = await Promise.all((await evidenceFiles(root)).map((path) => digest(root, path)));
	const manifest: Manifest = {
		schema_version: 1,
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
	if (JSON.stringify(result) !== JSON.stringify(await read(root, "result.json")))
		throw new Error("Saved result differs from independent score");
	return result;
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

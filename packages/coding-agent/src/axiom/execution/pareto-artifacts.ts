// 原子发布多目标交付目录，并在恢复时对每个已独立评估的成员重新核验摘要。
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactManifest, ParetoDecision, RunResult } from "./experiment-domain.ts";
import { ExperimentFailure } from "./experiment-domain.ts";
import { sha256 } from "./task-spec.ts";

type VerifyRun = (run: RunResult, directory?: string) => Promise<unknown>;
const destinationName = "pareto-delivery";

export async function publishParetoArtifacts(
	root: string,
	decision: ParetoDecision,
	runs: readonly RunResult[],
	files: readonly string[],
	verify: VerifyRun,
): Promise<ArtifactManifest> {
	const manifest = await expectedManifest(decision, runs, files, verify);
	const destination = join(root, destinationName);
	const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	if (existing) {
		await verifyPublished(destination, runs, files, manifest, verify);
		return manifest;
	}
	const staging = await mkdtemp(join(root, ".pareto-"));
	try {
		for (const run of runs) {
			const directory = join(staging, run.id);
			await mkdir(join(directory, "candidate"), { recursive: true });
			for (const file of files) await copyFile(join(run.run, file), join(directory, file));
		}
		await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
		await verifyPublished(staging, runs, files, manifest, verify);
		// 整个集合与清单通过同卷改名一次发布，恢复时可安全复用完整目录。
		await rename(staging, destination);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	return manifest;
}

export async function verifyParetoArtifacts(
	root: string,
	decision: ParetoDecision,
	runs: readonly RunResult[],
	files: readonly string[],
	manifest: ArtifactManifest,
	verify: VerifyRun,
): Promise<void> {
	const expected = await expectedManifest(decision, runs, files, verify);
	if (JSON.stringify(manifest) !== JSON.stringify(expected))
		throw new ExperimentFailure("evidence_integrity", "Pareto delivery ledger manifest changed");
	await verifyPublished(join(root, destinationName), runs, files, expected, verify);
}

interface ParetoArtifactManifest extends ArtifactManifest {
	members: { id: string; files: Record<string, string> }[];
}

async function expectedManifest(
	decision: ParetoDecision,
	runs: readonly RunResult[],
	files: readonly string[],
	verify: VerifyRun,
): Promise<ParetoArtifactManifest> {
	if (
		!decision.primary ||
		JSON.stringify(runs.map((run) => run.id)) !== JSON.stringify(decision.selected.map((point) => point.id))
	)
		throw new ExperimentFailure("evidence_integrity", "Pareto delivery does not match approved decision");
	const members = [];
	for (const run of runs) {
		await verify(run);
		members.push({ id: run.id, files: await digests(run.run, files) });
	}
	return { best_id: decision.primary, manifest: `${destinationName}/manifest.json`, decision, members };
}

async function verifyPublished(
	directory: string,
	runs: readonly RunResult[],
	files: readonly string[],
	expected: ParetoArtifactManifest,
	verify: VerifyRun,
): Promise<void> {
	const stat = await lstat(directory);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(await readFile(join(directory, "manifest.json"), "utf8")) !== JSON.stringify(expected, null, 2)
	)
		throw new ExperimentFailure("evidence_integrity", "Pareto delivery manifest changed");
	for (const [index, run] of runs.entries()) {
		const member = join(directory, run.id);
		await verify(run, member);
		if (JSON.stringify(await digests(member, files)) !== JSON.stringify(expected.members[index].files))
			throw new ExperimentFailure("evidence_integrity", "Pareto delivery member changed");
	}
}

async function digests(directory: string, files: readonly string[]): Promise<Record<string, string>> {
	const entries: [string, string][] = [];
	for (const file of files) entries.push([file, sha256(await readFile(join(directory, file)))]);
	return Object.fromEntries(entries);
}

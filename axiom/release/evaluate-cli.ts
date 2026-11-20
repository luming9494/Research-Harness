// 操作者入口只冻结和评测；批准指针由独立发布入口更新。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { evaluate, freeze, openPlan } from "./evaluation.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			source: { type: "string" },
			sha: { type: "string" },
			root: { type: "string" },
			stage: { type: "string" },
			repetitions: { type: "string" },
		},
	});
	if (!values.root || !values.sha || !/^[a-f0-9]{64}$/.test(values.sha))
		throw new Error("Use --root and --sha with --source or --stage");
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const root = resolve(values.root);
	if (values.source && !values.stage) {
		const repetitions = Number(values.repetitions ?? "2");
		if (repetitions !== 2 && repetitions !== 3) throw new Error("Expected two or three repetitions");
		console.log(
			JSON.stringify({
				root,
				plan_sha256: await freeze(repo, resolve(values.source), values.sha, root, repetitions),
			}),
		);
		return;
	}
	if (values.source || (values.stage !== "development" && values.stage !== "holdout") || values.repetitions)
		throw new Error("Choose a single registered stage");
	const plan = await openPlan(root, values.sha);
	const python = resolve(
		process.env.AXIOM_PYTHON ??
			resolve(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
	);
	const controller = new AbortController();
	process.once("SIGINT", () => controller.abort());
	const executed = await evaluate(
		repo,
		python,
		root,
		plan,
		values.stage,
		AbortSignal.any([controller.signal, AbortSignal.timeout(110_000 * 60)]),
	);
	console.log(JSON.stringify({ root, stage: values.stage, planned: plan.arms.length * plan.repetitions, executed }));
	if (executed !== plan.arms.length * plan.repetitions) process.exitCode = 1;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Release evaluation failed");
	process.exitCode = 1;
});

// 宿主专用发布入口。所有基于模型的提案工具均不注册这些操作。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { file, sha256 } from "../bench/io.ts";
import { checkTrial, developmentCase, holdoutCase, openPlan, readStage } from "./evaluation.ts";
import { approval, gateDecision, regressions, summarize } from "./gate.ts";
import { PolicyRegistry } from "./registry.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			root: { type: "string" },
			sha: { type: "string" },
			candidate: { type: "string" },
			registry: { type: "string" },
			apply: { type: "boolean" },
			expected: { type: "string" },
			reason: { type: "string" },
			evidence: { type: "string" },
		},
	});
	const [operation] = positionals;
	if (positionals.length !== 1) throw new Error("Choose gate, publish, status, rollback or monitor");
	if (operation === "gate" || operation === "publish") {
		if (!values.root || !values.sha) throw new Error("Requires a frozen --root and --sha");
		if (operation === "publish" && !values.candidate) throw new Error("Publish requires --candidate");
		const root = resolve(values.root);
		const plan = await openPlan(root, values.sha);
		const trials = {
			development: await readStage(repo, root, plan, "development"),
			holdout: await readStage(repo, root, plan, "holdout"),
		};
		if (operation === "gate") {
			console.log(
				JSON.stringify(
					{
						development: summarize(trials.development, plan),
						holdout: summarize(trials.holdout, plan),
						decisions: plan.arms.slice(1).map((arm) => ({ id: arm.id, ...gateDecision(plan, trials, arm.id) })),
					},
					null,
					2,
				),
			);
			return;
		}
		const id = values.candidate ?? "";
		const arm = plan.arms.find((entry) => entry.id === id);
		if (!arm?.parent_sha256) throw new Error("Unknown candidate");
		const receipt = approval(plan, trials, id, values.sha);
		console.log(
			JSON.stringify({ dry_run: !values.apply, decision: gateDecision(plan, trials, id), approval: receipt }),
		);
		if (!values.apply) return;
		if (!values.registry || receipt.outcome !== "eligible")
			throw new Error("Eligible evidence and explicit registry required to publish");
		const registry = new PolicyRegistry(resolve(values.registry));
		try {
			registry.publish(arm.policy, receipt);
		} finally {
			registry.close();
		}
		return;
	}
	if (!["status", "rollback", "monitor"].includes(operation) || !values.registry)
		throw new Error("Expected a supported operation and --registry");
	if (operation === "rollback" && (!values.expected || !values.reason?.trim() || values.reason.length > 500))
		throw new Error("Requires --expected and a short --reason");
	if (operation === "rollback" && !values.apply) {
		console.log(JSON.stringify({ dry_run: true, expected: values.expected, reason: values.reason }));
		return;
	}
	const registry = new PolicyRegistry(
		resolve(values.registry),
		operation !== "status" && values.apply ? "write" : "read",
	);
	try {
		if (operation === "status") {
			console.log(JSON.stringify({ policy: registry.inspect(), audit: registry.audit() }, null, 2));
			return;
		}
		if (operation === "rollback") {
			const policy = registry.rollback(values.expected ?? "", {
				type: "operator",
				reference: "operator_cli",
				reason: values.reason ?? "",
			});
			console.log(JSON.stringify({ outcome: "rolled_back", policy }));
			return;
		}
		if (!values.evidence || !values.sha) throw new Error("Monitor requires --evidence with its manifest --sha");
		const source = resolve(values.evidence);
		const policy = values.apply ? registry.active().policy : registry.inspect();
		const trial = await checkTrial(
			repo,
			source,
			{
				arm: "active",
				repetition: 1,
				path: source,
				manifest_sha256: values.sha,
				result_sha256: sha256(await file(source, "result.json")),
			},
			policy,
		);
		if (![developmentCase, holdoutCase].includes(trial.result.case_id))
			throw new Error("Unsupported runtime regression case");
		const reasons = regressions(trial);
		if (reasons.length && values.apply) {
			const fallback = registry.rollback(policy.sha256, {
				type: "benchmark",
				reference: values.sha,
				reason: reasons.join(","),
			});
			console.log(
				JSON.stringify({ outcome: "rolled_back", triggering_run: trial.result.run_id, reasons, fallback }),
			);
		} else console.log(JSON.stringify({ dry_run: !values.apply, triggering_run: trial.result.run_id, reasons }));
	} finally {
		registry.close();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Release command failed");
	process.exitCode = 1;
});

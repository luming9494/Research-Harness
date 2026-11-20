// 用预登记的呈现退化夹具产生真实负反馈，再交给无工具的 Pi 提案会话修订。
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	approvedPolicy,
	bindPolicy,
	type PolicyBinding,
	verifyPolicy,
} from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";
import { selectCases } from "../bench/cases.ts";
import { file, inside, json, sha256 } from "../bench/io.ts";
import { runBatch } from "../bench/runner.ts";
import { propose } from "../evolution/policy.ts";
import { proposalModel, requestProposal } from "../evolution/proposal-rpc.ts";
import { checkTrial, developmentCase, type Trial } from "./evaluation.ts";
import { regressions } from "./gate.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const [item] = selectCases(undefined, [developmentCase]);

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { out: { type: "string" }, retry: { type: "boolean" } } });
	if (!values.out) throw new Error("Use --out with a new directory");
	const root = resolve(values.out);
	const baseline = approvedPolicy(true);
	const fixture = values.retry
		? verifyPolicy(
				(JSON.parse((await file(root, "plan.json")).toString("utf8")) as { fixture: PolicyBinding }).fixture,
			)
		: bindPolicy(
				{
					...baseline.config,
					source: "operator",
					version: 90001,
					baseline_sha256: baseline.sha256,
					created_at: new Date().toISOString(),
					settings: { ...baseline.config.settings, error_detail: "category" },
				},
				true,
			);
	if (!values.retry) {
		await mkdir(root);
		await json(root, "plan.json", {
			version: 1,
			split: "development",
			case: developmentCase,
			provenance: "operator_injected_presentation_fixture",
			expected_regression: "recovered_error_reason",
			fixture,
			model: proposalModel,
		});
	}
	const python = resolve(
		process.env.AXIOM_PYTHON ??
			join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
	);
	const signal = AbortSignal.timeout(2 * item.timeout_ms + 90_000);
	delete process.env.AXIOM_CONTEXT_EXPERIENCE;
	const run = async (label: string, policy: PolicyBinding): Promise<Trial> => {
		await json(root, `${label}.json`, policy.config);
		process.env.AXIOM_HARNESS_POLICY = join(root, `${label}.json`);
		const batch = await runBatch(repo, python, join(root, label), [item], signal);
		const path = join(batch.root, item.id);
		const trial = await checkTrial(
			repo,
			path,
			{
				arm: label,
				path,
				repetition: 1,
				manifest_sha256: sha256(await file(path, "manifest.json")),
				result_sha256: sha256(await file(path, "result.json")),
			},
			policy,
		);
		await json(root, `${label}-evaluation.json`, trial);
		return trial;
	};
	let original: Trial;
	if (values.retry) {
		// 重试只复用已归档且可重算的开发负例，不重复训练或读取留出。
		await file(root, "proposal-usage.json");
		const saved = JSON.parse((await file(root, "fixture-evaluation.json")).toString("utf8")) as Trial;
		if (
			!inside(join(root, "fixture"), saved.path) ||
			saved.result.case_id !== developmentCase ||
			fixture.config.version !== 90001
		)
			throw new Error("Untrusted revision fixture");
		original = await checkTrial(repo, saved.path, saved, fixture);
	} else original = await run("fixture", fixture);
	// 只能依据独立重算后的 Case 身份决定反馈是否可进入提案。
	if (original.result.case_id !== developmentCase) throw new Error("Revision feedback must come from development");
	const observed = regressions(original);
	if (!observed.includes("recovered_error_reason"))
		throw new Error("Expected fixture regression was not independently observed");
	const feedback = {
		case: developmentCase,
		run_id: original.result.run_id,
		manifest_sha256: original.manifest_sha256,
		result_sha256: original.result_sha256,
		recovered_error_reason: original.recovered_reason,
		regressions: observed,
	};
	if (!values.retry) await json(root, "feedback.json", feedback);
	// 先独占登记重试，避免反复付费重试同一条开发证据。
	if (values.retry)
		await json(root, "retry.json", { version: 1, feedback, reason: "first_proposal_duplicates_approved_policy" });
	// 留出内容、原始日志和自由文本分数均不会送到模型。
	const reply = await requestProposal(
		repo,
		`Repair a presentation-only Harness policy using this independently verified development feedback.
Return only JSON {settings,hypothesis,target_metrics}. The current policy is ${JSON.stringify(fixture.config.settings)}.
After process recovery the repaired AST failure lost its reason. Restore the necessary reason, using a minimal evidence-driven change. Allowed fields: prompt balanced|evidence_first, window_tokens 900..3200, priorities recent/artifacts/experience/operations 0..100, feedback summary|structured, experience_limit 0..8, error_detail category|reason. Never change evaluator, permissions, training or budgets. Target metrics from input_tokens,repair,error_visibility,recovery,task_success. Evidence: ${JSON.stringify(feedback)}`,
		signal,
	);
	await json(root, values.retry ? "proposal-usage-2.json" : "proposal-usage.json", {
		model: proposalModel,
		usage: reply.usage,
		error: reply.error,
		response_sha256: sha256(reply.text),
	});
	if (reply.error) throw new Error(reply.error);
	const candidate = propose(reply.text, fixture, 90002, new Date().toISOString(), "repair_fixture");
	await json(root, "proposal.json", candidate);
	const repaired = await run("revision", candidate.binding);
	console.log(
		JSON.stringify({
			root,
			fixture: original.result.run_id,
			revision: repaired.result.run_id,
			before: observed,
			after: regressions(repaired),
			success: repaired.recovered_reason === true,
		}),
	);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Revision failed");
	process.exitCode = 1;
});

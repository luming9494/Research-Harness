// 操作者显式运行的真实 Docker 验收，Pi 使用 faux provider，训练仍运行于真实容器。
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { childOutput, json } from "../../../../axiom/bench/io.ts";
import { openExperimentLedger } from "../../../../axiom/durable/experiment-ledger.ts";
import axiomTiny from "../../../../axiom/extensions/axiom-tiny.ts";
import { createHarness, createTestUiContext } from "./harness.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

// 实跑仅接受操作者提供的固定 TaskSpec 和同一批准配置。
function settings(): { spec: string; archive: string } {
	const spec = process.env.AXIOM_DOCKER_LIVE_SPEC;
	const archive = process.env.AXIOM_DOCKER_LIVE_ARCHIVE;
	if (!spec || !archive || !process.env.AXIOM_EXECUTION_PROFILE)
		throw new Error("Explicit Docker live test configuration required");
	return { spec: resolve(spec), archive: resolve(archive) };
}

it("SIGKILL after real Docker submission and resume the same task in a new native Pi session", async (): Promise<void> => {
	const { spec, archive } = settings();
	const worker = await childOutput(
		process.execPath,
		[
			"--conditions=source",
			"--experimental-strip-types",
			join(repo, "tests/fixtures/axiom-execution-worker.ts"),
			resolve(spec),
		],
		repo,
		AbortSignal.timeout(90_000),
		true,
	);

	expect(worker.interrupted).toBe(true);
	const before = JSON.parse(worker.stdout) as { task: string; deadline: number; backend: { submit: { id: string } } };
	const harness = await createHarness({
		settings: { retry: { provider: { maxRetries: 0 } } },
		extensionFactories: [axiomTiny],
	});
	try {
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		await harness.session.prompt(`/axiom-task-resume ${before.task}`);
		expect(errors).toEqual([]);
		const restoredSession = harness.sessionManager.getSessionId();
		// 原本的生产命令关闭任务并交付已独立核验的权重。
		await harness.session.prompt("/axiom-task-stop");
		expect(harness.faux.state.callCount).toBe(0);
		const root = join(repo, "private", before.task);
		const ledger = await openExperimentLedger(root);
		try {
			const after = await ledger.load();
			const executions = after?.commands.filter((row) => row.external) ?? [];
			expect(after?.deadline).toBe(before.deadline);
			expect(after?.taskId).toBe(basename(root));
			expect(executions).toHaveLength(1);
			expect(executions[0]?.external?.submit?.id).toBe(before.backend.submit.id);
			expect(executions[0]?.external?.observation?.id).toBe(before.backend.submit.id);
			expect(executions[0]?.external?.status).toBe("completed");
			expect(after?.evaluated[0]?.validation.samples).toBe(512);
			expect(after?.summary.delivery?.best_id).toBe("baseline");
			await json(resolve(archive), "docker-cross-process.json", {
				before,
				after,
				restoredSession,
				signal: "SIGKILL",
				modelRequests: 0,
			});
		} finally {
			await ledger.close();
		}
	} finally {
		await harness.cleanup();
	}
}, 150_000);

it("cancels and cleans the original real Docker container after process loss", async (): Promise<void> => {
	const { spec, archive } = settings();
	const args = ["--conditions=source", "--experimental-strip-types"];
	const worker = await childOutput(
		process.execPath,
		[...args, join(repo, "tests/fixtures/axiom-execution-worker.ts"), spec, "hold-for-cancel"],
		repo,
		AbortSignal.timeout(90_000),
		true,
	);
	expect(worker.interrupted).toBe(true);
	const before = JSON.parse(worker.stdout) as { task: string; deadline: number; backend: { submit: { id: string } } };
	await childOutput(
		process.execPath,
		[...args, join(repo, "axiom/execution/cli.ts"), "cancel", "--task", before.task],
		repo,
		AbortSignal.timeout(90_000),
	);
	const ledger = await openExperimentLedger(join(repo, "private", before.task));
	try {
		const after = await ledger.load();
		const job = after?.commands.find((op) => op.external)?.external;
		expect(job?.observation?.id).toBe(before.backend.submit.id);
		expect(job?.status).toBe("cancelled");
		expect(job?.cancelRequested).toBe(true);
		expect(after?.deadline).toBe(before.deadline);
		expect(after?.evaluated).toHaveLength(0);
		await json(archive, "docker-cancel.json", { before, after, signal: "SIGKILL" });
	} finally {
		await ledger.close();
	}
}, 150_000);

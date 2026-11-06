// Exercises the AXIOM extension through native Pi sessions, faux tool calls and real CPU training.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import axiomTiny from "../../../../axiom/extensions/axiom-tiny.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const python =
	process.env.AXIOM_PYTHON || join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function start(approved = true) {
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		initialActiveToolNames: ["read"],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			(pi) => {
				api = pi;
				axiomTiny(pi);
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm: async () => approved }) });
	const sessionId = harness.sessionManager.getSessionId();
	await harness.session.prompt("/axiom-tiny");
	expect(harness.sessionManager.getSessionId()).toBe(sessionId);
	if (!api) throw new Error("Extension was not initialized");
	return { harness, api };
}

async function call(harness: Harness, name: string, args: JsonObject = {}) {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("Offline test turn completed."),
	]);
	await harness.session.prompt("Execute the scripted offline test step.");
	return getToolResult(harness, name);
}

describe("AXIOM native extension", () => {
	it("does not enable training tools without approval", async () => {
		const { harness } = await start(false);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		expect(harness.session.getAllTools().some((tool) => tool.name.startsWith("axiom_"))).toBe(false);
	});

	it.skipIf(!existsSync(python))(
		"registers tools, validates arguments, gates other tools and restores selection",
		async () => {
			const { harness, api } = await start();
			expect(harness.session.getActiveToolNames()).toHaveLength(9);
			expect(harness.session.getActiveToolNames().every((name) => name.startsWith("axiom_"))).toBe(true);
			const inspected = await call(harness, "axiom_inspect_task");
			expect(inspected.isError).not.toBe(true);
			const details = inspected.details as { workspace: string; task_id: string };
			cleanups.push(() => rm(details.workspace, { recursive: true, force: true }));
			expect(details.task_id).toBe("wp03-single-candidate-v1");
			expect(existsSync(join(details.workspace, "task-spec.json"))).toBe(true);
			const invalid = await call(harness, "axiom_run_checks", { action: "shell" });
			expect(invalid.isError).toBe(true);
			expect(JSON.stringify(invalid.content)).toMatch(/Validation failed/);
			// Simulate another trusted extension re-enabling a tool: the AXIOM call gate still blocks it.
			api.setActiveTools([...api.getActiveTools(), "read"]);
			const blocked = await call(harness, "read", { path: join(repo, "README.md") });
			expect(blocked.isError).toBe(true);
			expect(JSON.stringify(blocked.content)).toMatch(/permits only reviewed/);
			await harness.session.prompt("/axiom-stop");
			expect(harness.session.getActiveToolNames()).toEqual(["read"]);
			const inactive = await harness.session.extensionRunner
				.getAllRegisteredTools()
				.find((tool) => tool.definition.name === "axiom_inspect_task")?.definition;
			if (!inactive) throw new Error("Registered tool missing");
			await expect(
				inactive.execute(
					"offline",
					{},
					undefined,
					undefined,
					harness.session.extensionRunner.createToolContext("offline", undefined),
				),
			).rejects.toThrow(/First start/);
		},
		30000,
	);

	it.skipIf(!existsSync(python)).each(["stop", "signal", "shutdown"] as const)(
		"cancels real executor on %s before restoring ordinary tools",
		async (method) => {
			const { harness } = await start();
			const inspected = await call(harness, "axiom_inspect_task");
			const { workspace } = inspected.details as { workspace: string };
			cleanups.push(() => rm(workspace, { recursive: true, force: true }));
			const tool = harness.session.extensionRunner
				.getAllRegisteredTools()
				.find((entry) => entry.definition.name === "axiom_run_baseline")?.definition;
			if (!tool) throw new Error("Baseline tool missing");
			const cancellation = new AbortController();
			const execution = tool
				.execute(
					"offline-cancel",
					{},
					cancellation.signal,
					undefined,
					harness.session.extensionRunner.createToolContext("offline-cancel", cancellation.signal),
				)
				.then(
					() => "unexpected success",
					(error) => String(error),
				);
			await new Promise((resolve) => setTimeout(resolve, 500));
			if (method === "stop") await harness.session.prompt("/axiom-stop");
			else if (method === "signal") cancellation.abort();
			else await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
			expect(await execution).toMatch(/aborted/i);
			const commands = await readdir(join(workspace, "commands"));
			const metadata = await Promise.all(
				commands
					.filter((name) => name.endsWith(".json"))
					.map(
						async (name) =>
							JSON.parse(await readFile(join(workspace, "commands", name), "utf8")) as {
								stopped: string | null;
							},
					),
			);
			expect(metadata.some((command) => command.stopped === "aborted")).toBe(true);
			if (method === "signal") await harness.session.prompt("/axiom-stop");
			expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		},
		30000,
	);

	it.skipIf(!existsSync(python))(
		"exports the real baseline after a Python Smoke failure",
		async () => {
			const { harness } = await start();
			const inspected = await call(harness, "axiom_inspect_task");
			const { workspace } = inspected.details as { workspace: string };
			cleanups.push(() => rm(workspace, { recursive: true, force: true }));
			expect((await call(harness, "axiom_run_baseline")).isError).not.toBe(true);
			const source = await call(harness, "axiom_read_candidate_file", { path: "model.py" });
			const { sha256 } = source.details as { sha256: string };
			expect(
				(
					await call(harness, "axiom_edit_candidate_file", {
						path: "model.py",
						expectedSha256: sha256,
						content:
							"from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.ReLU(), nn.Linear(8, 2))\n",
						rationale: "Offline fault-injection fixture, not autonomous optimization.",
					})
				).isError,
			).not.toBe(true);
			// Real filesystem fault: the trusted trainer must refuse an existing output directory.
			await mkdir(join(workspace, "smoke"));
			const smoke = await call(harness, "axiom_run_checks", { action: "smoke" });
			expect(smoke.isError).toBe(true);
			expect(JSON.stringify(smoke.content)).toMatch(/train.py failed/);
			expect((await call(harness, "axiom_get_run_result")).isError).not.toBe(true);
			const reverted = await call(harness, "axiom_finalize_candidate", {
				choice: "revert",
				reason: "Real Smoke process failed; preserve independently verified baseline.",
			});
			expect(reverted.isError).not.toBe(true);
			expect(reverted.details).toMatchObject({
				choice: "revert",
				outcome: "candidate_failed",
				selected_role: "baseline",
			});
			expect(await readFile(join(workspace, "selected", "checkpoint.pt"))).toEqual(
				await readFile(join(workspace, "baseline", "checkpoint.pt")),
			);
			await harness.session.prompt("/axiom-stop");
		},
		120000,
	);

	it.skipIf(!existsSync(python))(
		"runs baseline, reviewed candidate, Smoke, independent validation and keep through Pi",
		async () => {
			const { harness } = await start();
			const inspected = await call(harness, "axiom_inspect_task");
			const { workspace } = inspected.details as { workspace: string };
			// Keep real local evidence under ignored private/ for manual inspection.
			console.log(`AXIOM real CPU evidence: ${workspace}`);
			const early = await call(harness, "axiom_run_candidate");
			expect(early.isError).toBe(true);
			const baseline = await call(harness, "axiom_run_baseline");
			expect(baseline.isError).not.toBe(true);
			const source = await call(harness, "axiom_read_candidate_file", { path: "model.py" });
			const { sha256 } = source.details as { sha256: string };
			// Human-authored calibration input, not an autonomously proposed model.
			const edited = await call(harness, "axiom_edit_candidate_file", {
				path: "model.py",
				expectedSha256: sha256,
				content:
					"from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 16), nn.Tanh(), nn.Linear(16, 2))\n",
				rationale: "Offline fixture: nonlinear hidden layer for XOR; no autonomous model claim.",
			});
			expect(edited.isError).not.toBe(true);
			expect((await call(harness, "axiom_run_checks", { action: "l0" })).isError).not.toBe(true);
			const smoke = await call(harness, "axiom_run_checks", { action: "smoke" });
			expect(smoke.isError).not.toBe(true);
			expect(smoke.details).toMatchObject({ status: "passed", level: "smoke", train_samples: 16, epochs: 2 });
			expect((await call(harness, "axiom_run_candidate")).isError).not.toBe(true);
			const evidence = await call(harness, "axiom_get_run_result");
			expect(evidence.isError).not.toBe(true);
			expect(evidence.details).toMatchObject({
				baseline: { accuracy: 0.5 },
				candidate: { dataset_access_log: ["validation"] },
			});
			const finalized = await call(harness, "axiom_finalize_candidate", {
				choice: "keep",
				reason: "Independent validation accuracy improved.",
			});
			expect(finalized.isError).not.toBe(true);
			expect(finalized.details).toMatchObject({
				choice: "keep",
				selected_artifact: "selected/",
				final_test_used: false,
			});
			const decision = JSON.parse(await readFile(join(workspace, "decision.json"), "utf8")) as {
				candidate_accuracy: number;
			};
			expect(decision.candidate_accuracy).toBeGreaterThan(0.9);
			for (const path of ["selected/checkpoint.pt", "selected/validation.json", "patch.diff", "decision.json"])
				expect(existsSync(join(workspace, path))).toBe(true);
			expect(await readFile(join(workspace, "patch.diff"), "utf8")).toContain("nn.Tanh");
			await harness.session.prompt("/axiom-stop");
			expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		},
		180000,
	);
});

// Verifies WP-04 tools, native usage/admission and real CPU failure/cancellation without paid APIs.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import axiomTiny from "../../../../axiom/extensions/axiom-tiny.ts";
import { DEFAULT_BUDGET, TASK_RULES } from "../../src/axiom/execution/task-spec.ts";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const python =
	process.env.AXIOM_PYTHON || join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});
const taskSpec = (maxTokens = 500000) => ({
	version: 1,
	task: "tiny-xor-v1",
	goal: "Offline native Pi acceptance fixture",
	target_accuracy: null,
	rules: TASK_RULES,
	budget: { ...DEFAULT_BUDGET, max_tokens: maxTokens },
});

async function start(approved = true, maxTokens = 500000) {
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
	await harness.session.prompt(`/axiom-task ${JSON.stringify(taskSpec(maxTokens))}`);
	expect(harness.sessionManager.getSessionId()).toBe(sessionId);
	if (!api) throw new Error("Extension not loaded");
	return { harness, api };
}
async function call(harness: Harness, name: string, args: JsonObject = {}) {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("Scripted offline turn completed."),
	]);
	await harness.session.prompt("Execute the next scripted offline acceptance step.");
	return getToolResult(harness, name);
}
function definition(harness: Harness, name: string) {
	const tool = harness.session.extensionRunner
		.getAllRegisteredTools()
		.find((entry) => entry.definition.name === name)?.definition;
	if (!tool) throw new Error(`Missing ${name}`);
	return tool;
}
async function inspectDirect(harness: Harness) {
	const result = await definition(harness, "axiom_task_inspect").execute(
		"inspect",
		{},
		undefined,
		undefined,
		harness.session.extensionRunner.createToolContext("inspect", undefined),
	);
	return result.details as { workspace: string };
}
async function summary(root: string) {
	return JSON.parse(await readFile(join(root, "summary.json"), "utf8")) as {
		status: string;
		stop_reason: string;
		budget: { tokens_actual: number; model_requests: number; usage_uncertain: boolean };
	};
}

describe("AXIOM WP-04 native Pi extension", () => {
	it.skipIf(!existsSync(python)).each(["--no-tools", "--no-builtin-tools"])(
		"checks actual SDK tool declarations after approval with %s",
		async (flag) => {
			const harness = await createHarness({
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
			});
			cleanups.push(() => harness.cleanup());
			const loader = new DefaultResourceLoader({
				cwd: repo,
				agentDir: harness.tempDir,
				settingsManager: harness.settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [axiomTiny],
			});
			await loader.reload();
			const args = parseArgs([flag]);
			const { session } = await createAgentSession({
				cwd: repo,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				model: harness.getModel(),
				resourceLoader: loader,
				settingsManager: harness.settingsManager,
				sessionManager: SessionManager.inMemory(),
				noTools: args.noTools ? "all" : "builtin",
			});
			let workspace: string | undefined;
			cleanups.push(async () => {
				await session.prompt("/axiom-task-stop");
				session.dispose();
				if (workspace) await rm(workspace, { recursive: true, force: true });
			});
			await session.bindExtensions({
				uiContext: createTestUiContext({
					confirm: async () => true,
					notify: (message) => {
						if (message.startsWith("Task ready: ")) workspace = message.slice(12).split(". Ask Pi")[0];
					},
				}),
			});
			const names = [
				"axiom_task_inspect",
				"axiom_task_baseline",
				"axiom_task_candidate",
				"axiom_task_finish",
			].sort();
			expect(session.getActiveToolNames()).toEqual([]);
			if (args.noTools) {
				const errors: string[] = [];
				session.extensionRunner.onError((error) => errors.push(error.error));
				await session.prompt(`/axiom-task ${JSON.stringify(taskSpec())}`);
				expect(errors).toHaveLength(1);
				expect(errors[0]).toContain("Use --no-builtin-tools");
				expect(session.getActiveToolNames()).toEqual([]);
				expect(harness.faux.state.callCount).toBe(0);
				expect(workspace).toBeUndefined();
				workspace = errors[0].split("Evidence: ")[1];
				expect(await summary(workspace)).toMatchObject({
					status: "cancelled",
					budget: { tokens_actual: 0, model_requests: 0 },
				});
				return;
			}
			await session.prompt(`/axiom-task ${JSON.stringify(taskSpec())}`);
			expect(workspace).toBeDefined();
			expect(session.getActiveToolNames().sort()).toEqual(names);
			harness.setResponses([
				(context) => {
					const declarations = context.messages.flatMap((message) =>
						message.role === "system" ? (message.toolsAdded ?? []) : [],
					);
					expect(declarations.map((tool) => tool.name).sort()).toEqual(names);
					expect(declarations.find((tool) => tool.name === "axiom_task_candidate")?.parameters).toMatchObject({
						type: "object",
						properties: { content: { type: "string" }, rationale: { type: "string" } },
					});
					return fauxAssistantMessage([fauxToolCall("axiom_task_inspect", {})], { stopReason: "toolUse" });
				},
				fauxAssistantMessage("Offline schema acceptance complete."),
			]);
			await session.prompt("Execute the free tool-declaration regression.");
			const results = session.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ toolName: "axiom_task_inspect", isError: false });
			await session.prompt("/axiom-task-stop");
			expect(session.getActiveToolNames()).toEqual([]);
		},
		30000,
	);

	it("does not register or enable task tools without approval", async () => {
		const { harness } = await start(false);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		expect(harness.session.getAllTools().some((tool) => tool.name.startsWith("axiom_task_"))).toBe(false);
	});

	it.skipIf(!existsSync(python))(
		"rejects a request before provider invocation when admission fails",
		async () => {
			const { harness } = await start(true, 1);
			const { workspace } = await inspectDirect(harness);
			cleanups.push(async () => {
				await harness.session.prompt("/axiom-task-stop");
				await rm(workspace, { recursive: true, force: true });
			});
			harness.setResponses([fauxAssistantMessage("Must never be requested")]);
			await harness.session.prompt("Attempt an over-budget request");
			expect(harness.faux.state.callCount).toBe(0);
			expect(await summary(workspace)).toMatchObject({
				stop_reason: "token_budget_exhausted",
				budget: { tokens_actual: 0, model_requests: 0 },
			});
		},
		30000,
	);

	it.skipIf(!existsSync(python))(
		"stops after uncertain native usage rather than admitting a retry",
		async () => {
			const { harness } = await start();
			const { workspace } = await inspectDirect(harness);
			cleanups.push(async () => {
				await harness.session.prompt("/axiom-task-stop");
				await rm(workspace, { recursive: true, force: true });
			});
			harness.setResponses([
				fauxAssistantMessage([], {
					stopReason: "error",
					errorMessage: "Scripted provider failure with uncertain usage",
				}),
			]);
			await harness.session.prompt("Simulate an offline provider failure");
			expect(harness.faux.state.callCount).toBe(1);
			const partialTokens = harness.session.messages.reduce(
				(total, message) => total + (message.role === "assistant" ? message.usage.totalTokens : 0),
				0,
			);
			expect(partialTokens).toBeGreaterThan(0);
			expect((await summary(workspace)).budget.tokens_actual).toBe(partialTokens);
			expect(await summary(workspace)).toMatchObject({
				stop_reason: "token_usage_uncertain",
				budget: { model_requests: 1, usage_uncertain: true },
			});
			await harness.session.prompt("No retry allowed");
			expect(harness.faux.state.callCount).toBe(1);
		},
		30000,
	);

	it.skipIf(!existsSync(python))(
		"accounts native usage, restricts tools and delivers first real model after second worker fails",
		async () => {
			const { harness, api } = await start();
			const { workspace } = await inspectDirect(harness);
			console.log(`AXIOM WP-04 native failure evidence: ${workspace}`);
			expect(harness.session.getActiveToolNames()).toHaveLength(4);
			const beforeMode = harness.session.getActiveToolNames();
			await harness.session.prompt("/axiom-tiny");
			expect(harness.session.getActiveToolNames()).toEqual(beforeMode);
			const inspected = await call(harness, "axiom_task_inspect");
			expect(inspected.details).toMatchObject({
				final_test_used: false,
				task: { rules: { evaluation: "validation", network: false } },
			});
			const invalid = await call(harness, "axiom_task_candidate", {
				content: "x",
				rationale: "x",
				split: "final-test",
			});
			expect(invalid.isError).toBe(true);
			api.setActiveTools([...api.getActiveTools(), "read"]);
			expect((await call(harness, "read", { path: join(repo, "README.md") })).isError).toBe(true);
			api.setActiveTools(beforeMode);
			expect((await call(harness, "axiom_task_baseline")).isError).not.toBe(true);
			const model =
				"from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.Tanh(), nn.Linear(8, 2))\n";
			const first = await call(harness, "axiom_task_candidate", {
				content: model,
				rationale: "Human-authored CPU fixture, not autonomous model discovery",
			});
			expect(first.details).toMatchObject({ best: { id: "exp-1" } });
			await mkdir(join(workspace, "runs/exp-2-smoke"));
			const failed = await call(harness, "axiom_task_candidate", {
				content: "from torch import nn\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 2))\n",
				rationale: "Real filesystem fault must preserve first success",
			});
			expect(failed.isError).toBe(true);
			expect(failed.details).toMatchObject({
				status: "failed",
				stop_reason: "execution_failure",
				delivery: { best_id: "exp-1" },
				final_test_used: false,
				budget: { experiments: 2, training_steps_reserved: 244 },
			});
			expect(await readFile(join(workspace, "best_model.pt"))).toEqual(
				await readFile(join(workspace, "runs/exp-1/checkpoint.pt")),
			);
			const nativeTokens = harness.session.messages.reduce(
				(total, message) => total + (message.role === "assistant" ? message.usage.totalTokens : 0),
				0,
			);
			expect((await summary(workspace)).budget.tokens_actual).toBe(nativeTokens);
			expect((await summary(workspace)).budget.model_requests).toBe(harness.faux.state.callCount);
			const usageEvents = (await readFile(join(workspace, "events.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as { type: string; detail: { source: string; usage: { totalTokens: number } } },
				)
				.filter((event) => event.type === "native_pi_usage");
			expect(usageEvents).toHaveLength(harness.faux.state.callCount);
			expect(usageEvents.every((event) => event.detail.source === "Pi message_end")).toBe(true);
			expect(usageEvents.reduce((total, event) => total + event.detail.usage.totalTokens, 0)).toBe(nativeTokens);
			const count = harness.faux.state.callCount;
			await harness.session.prompt("Do not launch a third experiment");
			expect(harness.faux.state.callCount).toBe(count);
			await harness.session.prompt("/axiom-task-stop");
			expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		},
		180000,
	);

	it.skipIf(!existsSync(python)).each(["signal", "stop", "shutdown"] as const)(
		"kills a real CPU training process on %s and prevents queued work",
		async (method) => {
			const { harness } = await start();
			const { workspace } = await inspectDirect(harness);
			cleanups.push(async () => {
				await harness.session.prompt("/axiom-task-stop");
				await rm(workspace, { recursive: true, force: true });
			});
			const cancellation = new AbortController();
			const baseline = definition(harness, "axiom_task_baseline").execute(
				"baseline",
				{},
				cancellation.signal,
				undefined,
				harness.session.extensionRunner.createToolContext("baseline", cancellation.signal),
			);
			const until = Date.now() + 30000;
			while (true) {
				const events = await readFile(join(workspace, "events.jsonl"), "utf8").catch(() => "");
				if (events.includes('"script":"experiment.py"')) break;
				if (Date.now() > until) throw new Error("Training process did not start");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const queued = definition(harness, "axiom_task_candidate").execute(
				"queued",
				{ content: "x", rationale: "Never launch queued work after cancel" },
				undefined,
				undefined,
				harness.session.extensionRunner.createToolContext("queued", undefined),
			);
			const rejected = expect(queued).rejects.toThrow(/Task stopped/);
			if (method === "signal") cancellation.abort();
			else if (method === "stop") await harness.session.prompt("/axiom-task-stop");
			else await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
			await rejected;
			const result = await baseline;
			expect(result.details).toMatchObject({
				status: "cancelled",
				stop_reason: "user_cancelled",
				budget: { experiments: 0 },
			});
			const logs = await Promise.all(
				(await readdir(join(workspace, "commands"))).map(
					async (name) =>
						JSON.parse(await readFile(join(workspace, "commands", name), "utf8")) as {
							script: string;
							stopped: string;
						},
				),
			);
			expect(logs.some((log) => log.script === "experiment.py" && log.stopped === "aborted")).toBe(true);
			await harness.session.prompt("/axiom-task-stop");
			expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		},
		60000,
	);
});

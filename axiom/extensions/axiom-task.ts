// Bridges WP-04 domain tools and budget accounting into the existing native Pi session.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { BudgetStop } from "../../packages/coding-agent/src/axiom/execution/task-budget.ts";
import { TaskController } from "../../packages/coding-agent/src/axiom/execution/task-controller.ts";
import { DEFAULT_BUDGET, TASK_RULES, validateTaskSpec } from "../../packages/coding-agent/src/axiom/execution/task-spec.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const empty = Type.Object({}, { additionalProperties: false });
const tools = [
  { name: "inspect", description: "Read immutable Tiny Task rules, fixed model/config, real history best, validation evidence and budget.", parameters: empty },
  { name: "baseline", description: "Train the fixed baseline once and independently evaluate validation. Required before candidates.", parameters: empty },
  { name: "candidate", description: "Submit one complete model.py and rationale. Host reviews AST, deduplicates, runs Smoke/full training and independent validation synchronously. No polling. Only nn.Linear/Sequential/ReLU/Tanh, literal dimensions, 2 inputs/outputs, <=1024 parameters. No config changes.", parameters: Type.Object({ content: Type.String({ maxLength: 8192 }), rationale: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }) },
  { name: "finish", description: "Stop experiments and deliver the independently validated history best. Never self-report metrics.", parameters: empty },
] as const;
const names = tools.map(tool => `axiom_task_${tool.name}`);

/** Registers multi-round tools without creating a Pi session or wrapping model requests. */
export function registerTaskExtension(pi: ExtensionAPI, tinyActive: () => boolean) {
  let task: TaskController | undefined;
  let active = false;
  let prior: string[] = [];
  let registered = false;
  const close = async () => {
    if (!active || !task) return;
    if (task.budget.pendingUsage) task.budget.settleTokens(undefined);
    await task.stop("user_cancelled");
    pi.setActiveTools(prior);
    active = false;
  };
  pi.on("session_shutdown", close);
  pi.on("tool_call", event => {
    if (active && !names.includes(event.toolName)) return { block: true, reason: "AXIOM task permits only reviewed ML tools" };
  });
  pi.on("cache_warming_decision", () => active ? { action: "stop" } : undefined);
  // Compaction can start its own summary request outside this experiment admission path.
  pi.on("session_before_compact", () => active ? { cancel: true } : undefined);
  pi.on("session_before_tree", () => active ? { cancel: true } : undefined);
  pi.on("input", (_event, ctx) => {
    if (active && task?.stopped) {
      ctx.ui.notify(`Task stopped. Evidence: ${task.root}. Use /axiom-task-stop to restore ordinary tools.`, "info");
      return { action: "handled" };
    }
  });
  pi.on("before_agent_start", event => {
    if (active) event.systemPromptOptions.sections.axiom_task = "Trusted Tiny Task Optimize: use axiom_task_inspect, then baseline, then propose candidates from independent validation feedback. The host enforces budgets, selects best and stops. Candidate tool waits for CPU work; do not poll. No final-test, arbitrary shell, config edits or reference implementation access.";
  });
  pi.on("context_with_system", async (event, ctx) => {
    if (!active || !task) return;
    if (task.stopped) { ctx.abort(); return; }
    try {
      // Native full transcript includes active tool schemas. This is admission headroom, not an output cap.
      const estimate = Buffer.byteLength(JSON.stringify(event.messages), "utf8") + 8192 + 2048;
      task.budget.reserveTokens(estimate);
      await task.checkpoint();
    } catch (error) {
      ctx.abort();
      await task.stop(error instanceof BudgetStop ? error.reason : "execution_failure");
    }
  });
  pi.on("message_end", async event => {
    if (!active || !task || event.message.role !== "assistant" || !task.budget.pendingUsage) return;
    const message = event.message;
    await task.recordUsage({ provider: message.provider, model: message.model, stop_reason: message.stopReason, usage: message.usage });
  });
  pi.on("agent_settled", async event => {
    if (!active || !task) return;
    const pending = task.budget.pendingUsage;
    if (pending) task.budget.settleTokens(undefined);
    if (!task.stopped && (event.aborted || pending)) await task.stop(event.aborted ? "user_cancelled" : "token_usage_uncertain");
    await task.checkpoint();
  });

  pi.registerCommand("axiom-task", {
    description: "Start an approved multi-round Tiny Task; optional argument is a full TaskSpec JSON",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      if (active || tinyActive()) { ctx.ui.notify("Stop the current AXIOM mode before starting another task.", "warning"); return; }
      if (!ctx.hasUI) throw new Error("Task requires interactive approval");
      const spec = validateTaskSpec(args.trim() ? JSON.parse(args) as unknown : { version: 1, task: "tiny-xor-v1", goal: "Improve Tiny XOR validation accuracy within approved budgets", target_accuracy: null, rules: TASK_RULES, budget: DEFAULT_BUDGET });
      if (!await ctx.ui.confirm("AXIOM multi-round Tiny Task", `${JSON.stringify(spec, null, 2)}\nAllow local CPU experiments? Chat uses the selected Pi model and may incur fees. Token admission is estimated, not an absolute provider billing cap.`)) return;
      const python = process.env.AXIOM_PYTHON || join(repo, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      if (!existsSync(python)) throw new Error("Create .venv or set AXIOM_PYTHON to a trusted executable");
      task = await TaskController.create(repo, python, spec, () => ctx.abort());
      if (!registered) {
        for (const tool of tools) pi.registerTool({
          name: `axiom_task_${tool.name}`, label: `AXIOM ${tool.name}`, description: tool.description,
          defaultActive: false, executionMode: "sequential", parameters: tool.parameters,
          async execute(_id, params, signal) {
            if (!active || !task) throw new Error("Start /axiom-task first");
            const result = await task.invoke(tool.name, params as Record<string, unknown>, signal);
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, terminate: task.stopped, isError: result.status === "failed" };
          },
        });
        registered = true;
      }
      prior = pi.getActiveTools();
      active = true;
      pi.setActiveTools(names);
      // Native CLI allowlists can filter dynamic tools; fail before accepting a paid task prompt.
      const activated = pi.getActiveTools();
      if (activated.length !== names.length || names.some(name => !activated.includes(name))) {
        await close();
        throw new Error(`AXIOM task tools are disabled by the native tool selection. Use --no-builtin-tools instead of --no-tools, or allow all four axiom_task tools. Evidence: ${task.root}`);
      }
      ctx.ui.notify(`Task ready: ${task.root}. Ask Pi to inspect, run baseline and optimize. /axiom-task-stop restores tools.`, "info");
    },
  });
  pi.registerCommand("axiom-task-stop", {
    description: "Cancel multi-round task, deliver history best and restore previous tools",
    handler: async (_args, ctx) => {
      if (active && task) {
        const stopping = task.stop("user_cancelled");
        ctx.abort();
        await ctx.waitForIdle();
        await stopping;
      }
      await close();
      ctx.ui.notify(`AXIOM task closed. Evidence: ${task?.root ?? "none"}`, "info");
    },
  });
  return { isActive: () => active };
}

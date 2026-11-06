/**
 * AXIOM Tiny Task bridge for the fixed Pi 1.5.0 source tree.
 *
 * /axiom-tiny: create one reviewed Tiny ML single-candidate task.
 * /axiom-stop: restore the previous Pi tool selection.
 *
 * Reuses Pi TUI, model configuration, session, and Agent Loop.
 * This is NOT an OS sandbox for arbitrary ML repositories.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SmokeWorkspace } from "../../packages/coding-agent/dist/axiom/execution/smoke-workspace.js";
import { SingleOptimize } from "../../packages/coding-agent/dist/axiom/execution/single-optimize.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const specs = [
  {
    name: "inspect_task", label: "AXIOM Task",
    description: "Read fixed Tiny ML rules and validation criterion; no reference implementation or final test.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "read_candidate_file", label: "AXIOM Read",
    description: "Read only the candidate model.py or read-only config.json; return exact text and source SHA256.",
    parameters: Type.Object({ path: Type.Union([Type.Literal("model.py"), Type.Literal("config.json")]) }, { additionalProperties: false }),
  },
  {
    name: "run_baseline", label: "AXIOM Baseline",
    description: "Train original linear baseline at fixed config and independently evaluate validation; run before editing.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "edit_candidate_file", label: "AXIOM Edit",
    description: "Submit ONE self-authored allowed architecture candidate. Only model.py may change, with latest SHA256 and rationale. Narrow Python AST: Linear, ReLU, Tanh.",
    parameters: Type.Object({
      path: Type.Literal("model.py"),
      expectedSha256: Type.String(),
      content: Type.String({ maxLength: 8192 }),
      rationale: Type.String({ maxLength: 2000 }),
    }, { additionalProperties: false }),
  },
  {
    name: "run_checks", label: "AXIOM Checks",
    description: "Run only L0 check or tiny Smoke test. Smoke (16 samples, 2 updates) does not measure full model quality.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("l0"), Type.Literal("smoke")]) }, { additionalProperties: false }),
  },
  {
    name: "run_candidate", label: "AXIOM Candidate",
    description: "After smoke, run the single full candidate training and independent validation. No additional candidates.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "get_run_result", label: "AXIOM Evidence",
    description: "Independently reload and compare baseline/candidate validation results; only real metrics, no final-test.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "finalize_candidate", label: "AXIOM Finalize",
    description: "Choose keep or revert with an evidence-based reason; deterministic controller rejects wrong decision.",
    parameters: Type.Object({
      choice: Type.Union([Type.Literal("keep"), Type.Literal("revert")]),
      reason: Type.String({ maxLength: 2000 }),
    }, { additionalProperties: false }),
  },
  {
    name: "show_diff", label: "AXIOM Diff",
    description: "Show actual candidate source patch and resulting artifact location.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
] as const;

const allowedNames = specs.map((spec) => "axiom_" + spec.name);
const allowed = new Set<string>(allowedNames);

export default function (pi: ExtensionAPI) {
  let controller: SingleOptimize | undefined;
  let active = false;
  let toolsRegistered = false;
  let previouslyActive: string[] = [];

  // Defense in depth: stop other Pi tools from being used by the model
  // while a restricted Tiny Task is active. NOT an OS security boundary.
  pi.on("tool_call", async (event) => {
    if (active && !allowed.has(event.toolName)) {
      return { block: true, reason: "AXIOM Tiny Task permits only reviewed ML tools." };
    }
  });

  pi.registerCommand("axiom-tiny", {
    description: "Start supervised Tiny ML Optimize task using reviewed Python scripts",
    handler: async (_args, ctx) => {
      if (active) {
        ctx.ui.notify("AXIOM Tiny Task already active in " + controller?.workspace.root, "info");
        return;
      }
      if (!ctx.hasUI) throw new Error("AXIOM Tiny Task requires interactive user confirmation");
      const approved = await ctx.ui.confirm(
        "AXIOM Tiny Task",
        "Allow local CPU model training in an isolated candidate directory? Only model.py may be edited by the AXIOM tools.",
      );
      if (!approved) return;
      const python = process.env.AXIOM_PYTHON ||
        join(repoRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      if (!existsSync(python)) {
        ctx.ui.notify("Python not found: create .venv or set AXIOM_PYTHON to a trusted Python executable.", "error");
        return;
      }

      const workspace = await SmokeWorkspace.create(repoRoot, python, "optimize");
      const task = new SingleOptimize(workspace);
      await task.initialize();
      controller = task;

      if (!toolsRegistered) {
        for (const spec of specs) {
          pi.registerTool({
            name: "axiom_" + spec.name,
            label: spec.label,
            description: spec.description,
            defaultActive: false,
            executionMode: "sequential",
            parameters: spec.parameters,
            async execute(_id, params, signal) {
              if (!active || !controller) throw new Error("First start /axiom-tiny");
              const result = await controller.invoke(spec.name, params as Record<string, unknown>, "model", signal);
              return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
            },
          });
        }
        toolsRegistered = true;
      }

      previouslyActive = pi.getActiveTools().filter((name) => !allowed.has(name));
      active = true;
      pi.setActiveTools(allowedNames);
      ctx.ui.notify(
        "AXIOM Tiny Task started. Artifacts at " + workspace.root +
        ". Describe the task in chat; all other Pi model tools are disabled in this mode.",
        "info",
      );
    },
  });

  pi.registerCommand("axiom-stop", {
    description: "End AXIOM Tiny Task and restore Pi tools",
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify("No AXIOM Tiny Task is active.", "info");
        return;
      }
      active = false;
      pi.setActiveTools(previouslyActive);
      ctx.ui.notify("AXIOM mode ended. Artifacts remain at " + controller?.workspace.root, "info");
    },
  });
}

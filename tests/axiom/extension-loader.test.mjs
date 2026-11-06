// Check the actual compiled Pi extension loader without credentials or model requests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadExtensions } from "../../packages/coding-agent/dist/core/extensions/loader.js";

test("compiled Pi RPC starts offline and exposes AXIOM commands without a model request", async (t) => {
  const agentDir = await mkdtemp(resolve(tmpdir(), "axiom-pi-rpc-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["packages/coding-agent/dist/bundle/cli.js", "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "-e", resolve("axiom/extensions/axiom-tiny.ts")], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    input: JSON.stringify({ id: "commands", type: "get_commands" }) + "\n",
    encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const response = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === "commands");
  assert.equal(response?.success, true, result.stdout);
  assert.ok(response.data.commands.some(command => command.name === "axiom-tiny"));
  assert.ok(response.data.commands.some(command => command.name === "axiom-stop"));
});

test("AXIOM is opt-in and loads with the native compiled Pi extension loader", async () => {
  const automatic = await readdir(".pi/extensions");
  assert.ok(!automatic.some(name => name.startsWith("axiom")), "Development Pi must not auto-load the ML extension");
  const result = await loadExtensions([resolve("axiom/extensions/axiom-tiny.ts")], resolve("."));
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.deepEqual([...result.extensions[0].commands.keys()], ["axiom-tiny", "axiom-stop"]);
  assert.equal(result.extensions[0].tools.size, 0, "No training tools before human approval");
});

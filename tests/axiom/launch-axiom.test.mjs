// Verify launcher routing with fixture children and native AuthStorage, never a live provider or real key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const launcher = resolve("scripts/launch-axiom.mjs");
const authModule = pathToFileURL(resolve("packages/coding-agent/dist/core/auth-storage.js")).href;
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "axiom-launch-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "repository with spaces");
  const localAppData = join(parent, "Local AppData");
  const home = join(parent, "developer-home");
  const developerDir = join(home, ".pi", "agent");
  for (const path of [join(root, "scripts"), join(root, "packages/coding-agent/dist/bundle"), join(root, "axiom/extensions"), localAppData, developerDir]) await mkdir(path, { recursive: true });
  await copyFile(launcher, join(root, "scripts/launch-axiom.mjs"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "axiom/extensions/axiom-tiny.ts"), "// Fixture, not loaded by the stub CLI.\n");
  await writeFile(join(developerDir, "auth.json"), '{"fixture":"untouched developer credentials"}');
  await writeFile(join(root, "packages/coding-agent/dist/bundle/cli.js"), `
import { AuthStorage } from ${JSON.stringify(authModule)};
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'login') await AuthStorage.create().modify(args[2], async () => ({ type: 'api_key', key: 'offline-placeholder-not-a-real-key' }));
if (args[0] === 'auth' && args[1] === 'logout') await AuthStorage.create().delete(args[2]);
console.log(JSON.stringify({ cwd: process.cwd(), args, agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR }));
process.exitCode = args.includes('--fixture-exit') ? Number(args.at(-1)) : 0;
`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: localAppData, PI_CODING_AGENT_DIR: developerDir, PI_CODING_AGENT_SESSION_DIR: join(developerDir, "sessions") };
  const run = (args = [], overrides = {}) => spawnSync(process.execPath, [join(root, "scripts/launch-axiom.mjs"), ...args], { cwd: parent, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30000 });
  return { parent, root, localAppData, developerDir, env, run, agentDir: join(localAppData, "Research-Harness/agent") };
}

test("launcher isolates child directories, uses repository cwd and forwards arguments without a shell", async t => {
  const f = await fixture(t);
  const before = process.env.PI_CODING_AGENT_DIR;
  const result = f.run(["--offline", "--model", "name with spaces"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.cwd, f.root);
  assert.equal(output.agentDir, f.agentDir);
  assert.equal(output.sessionDir, join(f.agentDir, "sessions"));
  assert.deepEqual(output.args, ["-ne", "-e", join(f.root, "axiom/extensions/axiom-tiny.ts"), "--tui-mode", "regular", "--offline", "--model", "name with spaces"]);
  assert.equal(process.env.PI_CODING_AGENT_DIR, before);
  assert.equal(await readFile(join(f.developerDir, "auth.json"), "utf8"), '{"fixture":"untouched developer credentials"}');
});

test("auth routing omits experiment/TUI flags and native AuthStorage writes only to the isolated directory", async t => {
  const f = await fixture(t);
  const result = f.run(["auth", "login", "deepseek", "--api-key"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, ["auth", "login", "deepseek", "--api-key"]);
  const saved = JSON.parse(await readFile(join(f.agentDir, "auth.json"), "utf8"));
  assert.equal(saved.deepseek.type, "api_key");
  assert.equal(saved.deepseek.key, "offline-placeholder-not-a-real-key");
  assert.ok(!result.stdout.includes(saved.deepseek.key));
  assert.equal(await readFile(join(f.developerDir, "auth.json"), "utf8"), '{"fixture":"untouched developer credentials"}');
  const logout = f.run(["auth", "logout", "deepseek"]);
  assert.equal(logout.status, 0, logout.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(f.agentDir, "auth.json"), "utf8")), {});
});

test("other providers use the same native auth pass-through", async t => {
  const f = await fixture(t);
  const result = f.run(["auth", "login", "another-provider", "--api-key"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, ["auth", "login", "another-provider", "--api-key"]);
});

test("launcher preserves ordinary and Ctrl+C-style child exit codes", async t => {
  const f = await fixture(t);
  for (const code of [7, 130]) assert.equal(f.run(["--fixture-exit", String(code)]).status, code);
});

test("missing build and missing launcher have actionable path errors", async t => {
  const f = await fixture(t);
  await rm(join(f.root, "packages/coding-agent/dist/bundle/cli.js"));
  const unbuilt = f.run();
  assert.equal(unbuilt.status, 1); assert.match(unbuilt.stderr, /npm run build/);
  await rm(join(f.root, "scripts/launch-axiom.mjs"));
  const missing = f.run();
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /MODULE_NOT_FOUND/); assert.match(missing.stderr, /launch-axiom\.mjs/);
});

test("missing or relative LOCALAPPDATA never falls back into the repository", async t => {
  const f = await fixture(t);
  for (const value of ["", "relative"]) {
    const result = f.run([], { LOCALAPPDATA: value });
    assert.equal(result.status, 1); assert.match(result.stderr, /LOCALAPPDATA/);
  }
});

test("a configuration directory inside the repository or redirected into it is rejected", async t => {
  const f = await fixture(t);
  const inside = f.run([], { LOCALAPPDATA: f.root });
  assert.equal(inside.status, 1); assert.match(inside.stderr, /outside the Git repository/);
  await mkdir(join(f.localAppData, "Research-Harness"));
  await symlink(f.root, f.agentDir, process.platform === "win32" ? "junction" : "dir");
  const redirected = f.run();
  assert.equal(redirected.status, 1); assert.match(redirected.stderr, /must not resolve/);
  await rm(f.agentDir, { recursive: true });
  await symlink(f.developerDir, f.agentDir, process.platform === "win32" ? "junction" : "dir");
  const globalAlias = f.run();
  assert.equal(globalAlias.status, 1); assert.match(globalAlias.stderr, /must not resolve/);
});

test("missing extension blocks normal launch but not native credential commands", async t => {
  const f = await fixture(t);
  await rm(join(f.root, "axiom/extensions/axiom-tiny.ts"));
  assert.match(f.run().stderr, /extension is missing/);
  assert.equal(f.run(["auth", "logout", "deepseek"]).status, 0);
});

test("real compiled CLI starts offline through the isolated launcher and exposes only explicit AXIOM commands", async t => {
  const localAppData = await mkdtemp(join(tmpdir(), "axiom-launch-rpc-"));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [launcher, "--offline", "--mode", "rpc", "--no-session", "-na"], {
    cwd: tmpdir(), env: { ...process.env, LOCALAPPDATA: localAppData },
    input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`, encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(line => line.id === "commands");
  assert.equal(response?.success, true, result.stdout);
  const extensions = response.data.commands.filter(command => command.source === "extension");
  assert.deepEqual(extensions.map(command => command.name).sort(), ["axiom-stop", "axiom-task", "axiom-task-stop", "axiom-tiny"]);
  const env = { ...process.env, LOCALAPPDATA: localAppData, PI_OFFLINE: "1" };
  const logout = spawnSync(process.execPath, [launcher, "auth", "logout", "deepseek"], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(logout.status, 0, logout.stderr);
  const login = spawnSync(process.execPath, [launcher, "auth", "login", "deepseek", "--api-key"], { env, input: "", encoding: "utf8", timeout: 30000 });
  assert.equal(login.status, 1);
  assert.match(login.stderr, /requires an interactive terminal/);
});

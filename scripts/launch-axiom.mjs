// Launch the repository's Pi with an external, AXIOM-only native agent directory.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const cli = join(repo, "packages/coding-agent/dist/bundle/cli.js");
const extension = join(repo, "axiom/extensions/axiom-tiny.ts");
const args = process.argv.slice(2);

try {
  if (!existsSync(cli)) throw new Error("Pi CLI is not built. Run npm run build from the repository root.");
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) throw new Error("LOCALAPPDATA must be an absolute Windows user-data directory; no repository fallback is allowed.");
  const agentDir = join(await realpath(localAppData), "Research-Harness", "agent");
  if (inside(repo, agentDir)) throw new Error("AXIOM configuration must be outside the Git repository.");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const resolvedAgentDir = await realpath(agentDir);
  const globalDir = await realpath(join(homedir(), ".pi", "agent")).catch(error => {
    if (error.code === "ENOENT") return join(homedir(), ".pi", "agent");
    throw error;
  });
  if (inside(repo, resolvedAgentDir) || inside(globalDir, resolvedAgentDir)) throw new Error("AXIOM configuration must not resolve into the repository or the global Pi agent directory.");
  const authCommand = args[0] === "auth";
  if (!authCommand && !existsSync(extension)) throw new Error("AXIOM extension is missing. Restore axiom/extensions/axiom-tiny.ts.");
  const cliArgs = authCommand ? args : ["-ne", "-e", extension, "--tui-mode", "regular", ...args];
  const child = spawn(process.execPath, [cli, ...cliArgs], {
    cwd: repo,
    env: { ...process.env, PI_CODING_AGENT_DIR: resolvedAgentDir, PI_CODING_AGENT_SESSION_DIR: join(resolvedAgentDir, "sessions") },
    stdio: "inherit",
    shell: false,
  });
  // The child shares our foreground console. Forwarding Ctrl+C again can force Pi past its cleanup.
  const interrupt = () => {};
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  child.once("error", error => {
    console.error(`Cannot start repository Pi (${error.code ?? "spawn error"}).`);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1);
  });
} catch (error) {
  console.error(`AXIOM launch failed: ${error.message}`);
  process.exitCode = 1;
}

function inside(parent, path) {
  const offset = relative(parent, path);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

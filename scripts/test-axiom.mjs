// Run AXIOM's local CPU regressions without any paid model requests. Build first.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const python = process.env.AXIOM_PYTHON || join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const commands = [
  [python, ["-m", "unittest", "discover", "-s", "tests/python", "-v"]],
  [process.execPath, ["--test", ...readdirSync("tests/axiom").filter(name => name.endsWith(".test.mjs")).map(name => join("tests/axiom", name))]],
  [process.execPath, ["../../node_modules/vitest/dist/cli.js", "--run", "test/suite/axiom-tiny.test.ts"], "packages/coding-agent"],
];
for (const [executable, args, cwd] of commands) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", env: { ...process.env, AXIOM_PYTHON: python } });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}

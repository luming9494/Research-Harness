// Run AXIOM's local CPU regressions without any paid model requests. Build first.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const python = process.env.AXIOM_PYTHON || join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
// 机制组包含六项串行 CPU 训练场景。单独调度可避免共享 540 秒期限被其他测试挤占。
const mechanisms = "bench-comparison.test.mjs";
const tests = readdirSync("tests/axiom").filter(name => name.endsWith(".test.mjs"));
const commands = [
  [python, ["-m", "unittest", "discover", "-s", "tests/python", "-v"]],
  [process.execPath, ["--test", ...tests.filter(name => name !== mechanisms).map(name => join("tests/axiom", name))]],
  [process.execPath, ["--test", join("tests/axiom", mechanisms)]],
  [process.execPath, ["../../node_modules/vitest/dist/cli.js", "--run", "test/suite/axiom-tiny.test.ts", "test/suite/axiom-task.test.ts"], "packages/coding-agent"],
];
// 即使一组失败，仍保留后续组的原始结果及失败退出码。
let failure = 0;
for (const [executable, args, cwd] of commands) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", env: { ...process.env, AXIOM_PYTHON: python } });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failure ||= result.status || 1;
}
process.exitCode = failure;

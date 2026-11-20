// 操作者专用的固定 CPU 隔离验收。不会从 Agent 暴露 Docker，也不会回退到宿主训练。
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runProcess } from "../../packages/coding-agent/src/axiom/execution/process.ts";
import { digest, file, json, sha256 } from "./io.ts";

const assets = ["task.json", "common.py", "train.py", "evaluate.py", "judge.py"];
const endpoint = process.platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";

/** 容器参数完全由宿主生成，拒绝标签漂移、参数注入和根目录绑定。 */
export function sandboxArguments(id: string, image: string, input: string, output: string): string[] {
	if (!/^axiom-cpu-[a-f0-9-]{36}$/.test(id) || !/^[a-z0-9][a-z0-9./_:-]*@sha256:[a-f0-9]{64}$/.test(image))
		throw new Error("Sandbox requires a generated operation and a digest-pinned image");
	for (const path of [input, output])
		if (!isAbsolute(path) || /[,\r\n"]/.test(path) || basename(path) !== (path === input ? "input" : "output"))
			throw new Error("Invalid sandbox mount");
	if (input === output || dirname(input) !== dirname(output))
		throw new Error("Sandbox mounts must share only the isolated workspace");
	return [
		"run",
		"--rm",
		"--name",
		id,
		"--label",
		`axiom.operation=${id}`,
		"--pull=never",
		"--network=none",
		"--read-only",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges:true",
		"--user=65532:65532",
		"--cpus=1",
		"--memory=1g",
		"--memory-swap=1g",
		"--pids-limit=64",
		"--ulimit=cpu=60:65",
		"--ipc=none",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,nodev,size=128m",
		"--env",
		"HOME=/tmp",
		"--env",
		"PYTHONDONTWRITEBYTECODE=1",
		"--env",
		"OMP_NUM_THREADS=1",
		"--env",
		"MKL_NUM_THREADS=1",
		"--mount",
		`type=bind,src=${input},dst=/input,readonly`,
		"--mount",
		`type=bind,src=${output},dst=/output`,
		"--entrypoint",
		"python",
		image,
		"/input/eval/train.py",
		"--candidate",
		"/input/candidate",
		"--output",
		"/output/run",
	];
}

/** 有 Linux Docker 时仅执行已审查的固定模型，并在宿主独立复验输出。 */
export async function sandboxSmoke(
	repo: string,
	dockerPath: string,
	python: string,
	image: string,
	parent: string,
): Promise<string> {
	if (!isAbsolute(dockerPath)) throw new Error("Set AXIOM_DOCKER to an approved absolute Docker CLI path");
	const docker = await realpath(dockerPath).catch((): never => {
		throw new Error("Docker CLI unavailable; sandbox training was not launched");
	});
	const root = await mkdtemp(join(await realpath(parent), "axiom-sandbox-"));
	const input = join(root, "input");
	const output = join(root, "output");
	const home = join(root, "docker-config");
	await Promise.all([mkdir(home), mkdir(output), mkdir(join(input, "candidate"), { recursive: true })]);
	await mkdir(join(input, "eval"));
	if (process.platform !== "win32") await chmod(output, 0o777);
	const call = (args: string[], timeoutMs = 12_000): ReturnType<typeof runProcess> =>
		runProcess(docker, ["--host", endpoint, "--config", home, ...args], { cwd: root, home, timeoutMs });
	const engine = await call(["info", "--format", "{{.OSType}}"]);
	if (engine.code !== 0 || engine.stopped || engine.stdout.trim() !== "linux")
		throw new Error("Local Linux Docker engine unavailable; sandbox training was not launched");
	for (const name of assets) await copyFile(join(repo, "examples/tiny-ml-eval", name), join(input, "eval", name));
	for (const name of ["model.py", "config.json"])
		await copyFile(join(repo, "examples/tiny-ml-task", name), join(input, "candidate", name));
	const id = `axiom-cpu-${randomUUID()}`;
	const args = sandboxArguments(id, image, input, output);
	// 执行意图只写一次。客户端超时后按独立容器名核对，无自动重启。
	await json(root, "intent.json", { schema_version: 1, id, mode: "docker", image, args });
	const trained = await call(args, 90_000).catch((): undefined => undefined);
	if (trained?.code !== 0 || trained?.stopped) {
		const probe = await call([
			"container",
			"inspect",
			"--format",
			'{{index .Config.Labels "axiom.operation"}}',
			id,
		]).catch((): undefined => undefined);
		const removed =
			probe?.code === 0 && probe.stdout.trim() === id
				? await call(["container", "rm", "--force", id]).catch((): undefined => undefined)
				: undefined;
		await json(root, "failure.json", {
			code: trained?.code ?? null,
			stopped: trained?.stopped ?? null,
			reconciliation: removed?.code === 0 ? "removed_owned_container" : "unknown",
		});
		throw new Error("Isolated training failed; see the operation receipt");
	}
	const run = join(output, "run");
	for (const path of [run, join(run, "candidate")]) {
		const stat = await lstat(path);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
			throw new Error("Unexpected sandbox output directory");
	}
	const evidence = [];
	for (const name of ["checkpoint.pt", "run.json", "history.json", "candidate/model.py", "candidate/config.json"]) {
		const stat = await lstat(join(run, name));
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304)
			throw new Error("Unexpected sandbox output file");
		const entry = await digest(run, name);
		if (name.startsWith("candidate/") && entry.sha256 !== sha256(await file(input, name)))
			throw new Error("Sandbox changed approved candidate inputs");
		evidence.push(entry);
	}
	const scored = await runProcess(
		await realpath(python),
		[join(repo, "examples/tiny-ml-eval/validate_only.py"), "--run", run],
		{ cwd: root, home, timeoutMs: 60_000 },
	);
	if (scored.code !== 0 || scored.stopped) throw new Error("Independent sandbox output verification failed");
	await json(root, "result.json", {
		schema_version: 1,
		id,
		safety: "docker",
		result: JSON.parse(scored.stdout) as unknown,
		evidence,
	});
	return root;
}

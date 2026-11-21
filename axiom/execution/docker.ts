// Docker 分离运行，使用固定名称与 label 找回原容器，确认收据后再清理。
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExecutionObservation } from "../../packages/coding-agent/src/axiom/execution/execution-backend.ts";
import { runProcess } from "../../packages/coding-agent/src/axiom/execution/process.ts";
import { sandboxArguments } from "../bench/sandbox.ts";
import {
	type Command,
	commandSucceeded,
	type DockerProfile,
	type ExecutionBackend,
	type ExecutionWorkspace,
	unknown,
} from "./backend.ts";

// Windows WSL 启动器只连接已批准的发行版和 Unix socket。
function wslPath(path: string): string {
	const match = /^([A-Za-z]):[\\/](.+)$/.exec(path);
	if (!match) throw new Error("Docker WSL bind mounts require absolute drive paths");
	return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

interface Container {
	Id: string;
	Image: string;
	Config: { Image: string; User: string; Labels: Record<string, string> };
	State: { Status: string; ExitCode: number; StartedAt: string; FinishedAt: string; Error?: string };
	HostConfig: {
		NetworkMode: string;
		ReadonlyRootfs: boolean;
		CapDrop: string[];
		SecurityOpt: string[];
		Memory: number;
		MemorySwap: number;
		NanoCpus: number;
		PidsLimit: number;
		Privileged: boolean;
	};
	Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
}

function mounts(profile: DockerProfile, work: ExecutionWorkspace): [string, string] {
	return profile.transport === "wsl" ? [wslPath(work.input), wslPath(work.output)] : [work.input, work.output];
}

export function dockerBackend(profile: DockerProfile, root: string, testCommand?: Command): ExecutionBackend {
	if (!isAbsolute(profile.executable) || (profile.transport === "wsl") !== (process.platform === "win32"))
		throw new Error("Docker executable and transport do not match the host");
	const home = profile.transport === "wsl" ? wslPath(join(root, "cli-home")) : join(root, "cli-home");
	const prefix =
		profile.transport === "wsl" ? ["-d", profile.distribution ?? "", "-u", "root", "--exec", "/usr/bin/docker"] : [];
	const endpoint = "unix:///var/run/docker.sock";
	const call: Command =
		testCommand ??
		((args, signal, maxBytes) =>
			runProcess(profile.executable, [...prefix, "--host", endpoint, "--config", home, ...args], {
				cwd: root,
				home: join(root, "cli-home"),
				signal,
				maxBytes,
				timeoutMs: 15_000,
			}));
	async function inspect(work: ExecutionWorkspace): Promise<ExecutionObservation> {
		const engine = await call(["info", "--format", "{{.ID}}|{{.OSType}}"]);
		if (!commandSucceeded(engine) || engine.stdout.trim() !== `${profile.engine}|linux`)
			return unknown("docker_engine_identity_unavailable");
		const result = await call(["container", "inspect", work.receipt.token]);
		if (!commandSucceeded(result)) return unknown("docker_container_missing_or_unavailable");
		const [item] = JSON.parse(result.stdout) as Container[];
		const id = item?.Id;
		const [input, output] = mounts(profile, work);
		const expected = work.receipt.submit?.id ?? work.receipt.observation?.id;
		const h = item?.HostConfig;
		if (
			!id ||
			!/^[a-f0-9]{64}$/.test(id) ||
			(expected && expected !== id) ||
			item.Config.Image !== profile.image ||
			item.Config.Labels?.["axiom.operation"] !== work.receipt.token ||
			item.Config.Labels?.["axiom.spec"] !== work.receipt.specSha256 ||
			item.Config.User !== "65532:65532" ||
			!h ||
			h.Privileged ||
			h.NetworkMode !== "none" ||
			!h.ReadonlyRootfs ||
			!h.CapDrop?.includes("ALL") ||
			!h.SecurityOpt?.includes("no-new-privileges:true") ||
			h.Memory !== 1073741824 ||
			h.MemorySwap !== h.Memory ||
			h.NanoCpus !== 1e9 ||
			h.PidsLimit !== 64 ||
			item.Mounts.length !== 2 ||
			!item.Mounts.some((m) => m.Type === "bind" && m.Source === input && m.Destination === "/input" && !m.RW) ||
			!item.Mounts.some((m) => m.Type === "bind" && m.Source === output && m.Destination === "/output" && m.RW)
		)
			return unknown("docker_container_identity_or_limits_conflict");
		const state = item.State;
		// daemon 明确报告创建失败且未产生启动时间时，可核对此次执行没有跑训练。
		if (state.Status === "created" && state.Error && state.StartedAt.startsWith("0001-"))
			return {
				id,
				status: "failed",
				exitCode: state.ExitCode,
				elapsedMs: 0,
				evidence: "docker_daemon_start_rejected",
			};
		if (["created", "running"].includes(state.Status))
			return { id, status: state.Status === "created" ? "submitted" : "running", evidence: "docker_inspect" };
		if (state.Status !== "exited" && state.Status !== "dead") return unknown("docker_container_state_unrecognized");
		const elapsedMs = Date.parse(state.FinishedAt) - Date.parse(state.StartedAt);
		const resources = { cpus: 1, memory_bytes: h.Memory, pid_limit: h.PidsLimit };
		return {
			id,
			status:
				state.ExitCode === 0
					? "completed"
					: work.receipt.cancelRequested && [137, 143].includes(state.ExitCode)
						? "cancelled"
						: "failed",
			exitCode: state.ExitCode,
			...(Number.isFinite(elapsedMs) && elapsedMs >= 0 ? { elapsedMs } : {}),
			resources,
			evidence: "docker_inspect",
		};
	}
	return {
		async preflight(work, signal): Promise<void> {
			const engine = await call(["info", "--format", "{{.ID}}|{{.OSType}}"], signal);
			const image = await call(["image", "inspect", "--format", "{{.Id}}", profile.image], signal);
			if (
				!commandSucceeded(engine) ||
				engine.stdout.trim() !== `${profile.engine}|linux` ||
				!commandSucceeded(image) ||
				!/^sha256:[0-9a-f]{64}$/.test(image.stdout.trim())
			)
				throw new Error("Approved Linux Docker engine or pinned image unavailable");
			mounts(profile, work);
		},
		async submit(work, signal): Promise<ExecutionObservation> {
			const [input, output] = mounts(profile, work);
			const args = sandboxArguments(work.receipt.token, profile.image, input, output);
			const isolation = args.slice(2, args.indexOf("--entrypoint"));
			const seconds = Math.max(
				1,
				Math.floor(Math.min(work.receipt.reservedMs, work.receipt.deadline - Date.now()) / 1000) - 2,
			);
			const started = await call(
				[
					"run",
					"--detach",
					...isolation,
					"--label",
					`axiom.spec=${work.receipt.specSha256}`,
					"--restart=no",
					"--log-driver=local",
					"--log-opt=max-size=1m",
					"--log-opt=max-file=1",
					"--log-opt=compress=false",
					"--entrypoint",
					"/usr/bin/timeout",
					profile.image,
					"--signal=TERM",
					"--kill-after=2s",
					`${seconds}s`,
					"python",
					"/input/eval/experiment.py",
					"--candidate",
					"/input/candidate",
					"--output",
					"/output/run",
					...(work.smoke ? ["--smoke-output", "/output/smoke"] : []),
				],
				signal,
			);
			const id = started.stdout.trim();
			return commandSucceeded(started) && /^[a-f0-9]{64}$/.test(id)
				? { id, status: "submitted", evidence: "docker_detached_id" }
				: unknown("docker_submit_receipt_missing");
		},
		inspect,
		async cancel(work, id): Promise<void> {
			const state = await inspect(work);
			if (state.id === id && ["running", "submitted"].includes(state.status))
				await call(["container", "stop", "--time", "2", id]);
		},
		async collect(work, id): Promise<void> {
			const logs = await call(["container", "logs", "--tail", "100", id]);
			if (!commandSucceeded(logs)) throw new Error("Docker log receipt unavailable");
			await writeFile(join(work.output, "worker.log"), logs.stdout + logs.stderr, { flag: "wx" }).catch(
				(error: NodeJS.ErrnoException): void => {
					if (error.code !== "EEXIST") throw error;
				},
			);
		},
		async cleanup(work, id): Promise<void> {
			const state = await inspect(work);
			if (state.id === id && ["completed", "failed", "cancelled"].includes(state.status))
				await call(["container", "rm", id]);
		},
	};
}

import { spawn } from "node:child_process";
import { delimiter, dirname, join } from "node:path";

export interface ProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
	stopped: "timeout" | "aborted" | "output_limit" | null;
}

// 每次授权绑定到独立租约，PID 只用于审计。
export interface WorkerIdentity {
	pid: number;
	nonce: string;
	observedAt: number;
}

export interface PythonLease {
	entry: string;
	nonce: string;
	authorize(identity: WorkerIdentity): Promise<void>;
}

// No provider credentials, PYTHONPATH, shell startup files or inherited proxy config.
export function childEnvironment(executable: string, home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: [
			dirname(executable),
			...(process.platform === "win32"
				? [join(process.env.SystemRoot || "C:\\Windows", "System32")]
				: ["/usr/bin", "/bin"]),
		].join(delimiter),
		HOME: home,
		USERPROFILE: home,
		TEMP: home,
		TMP: home,
		PYTHONNOUSERSITE: "1",
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONUTF8: "1",
		OMP_NUM_THREADS: "1",
		MKL_NUM_THREADS: "1",
	};
	for (const name of ["SystemRoot", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
	return env;
}

export async function runProcess(
	executable: string,
	args: string[],
	options: {
		cwd: string;
		home: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		maxBytes?: number;
		lease?: PythonLease;
	},
): Promise<ProcessResult> {
	options.signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const lease = options.lease;
		const child = spawn(executable, lease ? [lease.entry, lease.nonce, ...args] : args, {
			cwd: options.cwd,
			env: childEnvironment(executable, options.home),
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: [lease ? "pipe" : "ignore", "pipe", "pipe"],
		});
		let stdout = "",
			stderr = "",
			bytes = 0;
		let stopped: ProcessResult["stopped"] = null;
		let authorizationError: unknown;
		let authorization = Promise.resolve();
		let handshake = "";
		let handshook = false;
		const limit = options.maxBytes ?? 64 * 1024;
		const stop = (reason: NonNullable<ProcessResult["stopped"]>) => {
			if (stopped) return;
			stopped = reason;
			// 受管 Python 观察写端关闭，由自己的 Job 或进程组处理终止。
			if (lease) {
				child.stdin?.destroy();
				return;
			}
			if (!child.pid) return;
			if (process.platform === "win32") {
				const killer = spawn(
					join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
					["/PID", String(child.pid), "/T", "/F"],
					{ windowsHide: true, stdio: "ignore" },
				);
				killer.on("error", () => child.kill());
				killer.on("exit", (code) => {
					if (code !== 0) child.kill();
				});
			} else {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		};
		const capture = (data: Buffer, target: "stdout" | "stderr") => {
			const text = data.subarray(0, Math.max(0, limit - bytes)).toString("utf8");
			if (target === "stdout") stdout += text;
			else stderr += text;
			bytes += data.length;
			if (bytes > limit) stop("output_limit");
		};
		child.stdin?.on("error", (error: Error) => {
			if (!stopped) authorizationError = error;
		});
		child.stdout?.on("data", (data: Buffer) => {
			if (!lease || handshook) {
				capture(data, "stdout");
				return;
			}
			// 工作脚本在授权前不会写 stdout，第一行只用于建立租约。
			handshake += data.toString("utf8");
			const end = handshake.indexOf("\n");
			if (end < 0 && handshake.length < 1024) return;
			handshook = true;
			authorization = (async (): Promise<void> => {
				try {
					const ready = JSON.parse(handshake.slice(0, end)) as { pid?: unknown; nonce?: unknown };
					if (
						end < 0 ||
						end > 1024 ||
						ready.nonce !== lease.nonce ||
						typeof ready.pid !== "number" ||
						!Number.isSafeInteger(ready.pid) ||
						ready.pid <= 0
					)
						throw new Error("Invalid AXIOM worker lease handshake");
					if (stopped) return;
					await lease.authorize({ pid: ready.pid, nonce: lease.nonce, observedAt: Date.now() });
					if (!stopped) child.stdin?.write("g");
				} catch (error) {
					authorizationError = error;
					child.stdin?.destroy();
				}
			})();
		});
		child.stderr?.on("data", (data: Buffer) => capture(data, "stderr"));
		const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 60_000);
		const abort = () => stop("aborted");
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		};
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code) => {
			cleanup();
			// 确保授权回调结算后才返回，避免退出与账本提交异步交叉。
			void authorization.then(
				() =>
					authorizationError === undefined
						? resolve({ code, stdout, stderr, stopped })
						: reject(authorizationError),
				reject,
			);
		});
	});
}

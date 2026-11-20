// 统一管理受控子进程、运行目录与证据摘要。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export interface Digest {
	path: string;
	sha256: string;
	bytes: number;
}
export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
export function inside(root: string, target: string): boolean {
	const offset = relative(root, target);
	return Boolean(offset && offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}
export async function file(root: string, name: string): Promise<Buffer> {
	const path = join(root, name);
	if (!inside(root, path) || !(await lstat(path)).isFile() || !inside(root, await realpath(path)))
		throw new Error(`Untrusted evidence path: ${name}`);
	return readFile(path);
}
export async function digest(root: string, path: string): Promise<Digest> {
	const value = await file(root, path);
	return { path, sha256: sha256(value), bytes: value.length };
}
export async function save(root: string, path: string, body: string | Buffer): Promise<void> {
	const dest = join(root, path);
	if (!inside(root, dest)) throw new Error("Output escaped case workspace");
	await mkdir(dirname(dest), { recursive: true });
	await writeFile(dest, body, { flag: "wx" });
}
export async function json(root: string, path: string, value: unknown): Promise<void> {
	await save(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

// 只向由本 Runner 创建的子进程发信号。等待 close 后再读取 SQLite。
export async function childOutput(
	executable: string,
	argv: string[],
	cwd: string,
	signal: AbortSignal,
	syncPoint = false,
): Promise<{ stdout: string; interrupted: boolean }> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(executable, argv, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "",
			stderr = "",
			interrupted = false;
		let overflow = false;
		const cancel = (): void => {
			child.kill("SIGKILL");
		};
		signal.addEventListener("abort", cancel, { once: true });
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > 2_000_000) {
				overflow = true;
				cancel();
			}
			if (syncPoint && !interrupted && stdout.includes("\n")) interrupted = child.kill("SIGKILL");
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			if (stderr.length < 4096) stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			signal.removeEventListener("abort", cancel);
			if (signal.aborted) reject(signal.reason);
			else if (overflow || (code !== 0 && !interrupted) || (syncPoint && !interrupted))
				reject(new Error(`Case subprocess failed (${code}): ${stderr.slice(0, 4096)}`));
			else resolve({ stdout, interrupted });
		});
	});
}

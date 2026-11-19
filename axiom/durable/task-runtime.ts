// 为 AXIOM 打开带单写者保护的 Pi Durable 任务运行时。
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Context, withoutAbortSignal } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export interface AxiomTaskRuntime {
	readonly harness: Harness;
	close(): Promise<void>;
}

/** 为已存在的任务目录取得单写者所有权，持锁直到 Durable 关闭。 */
export async function openAxiomTaskRuntime(
	directory: string,
	options: Parameters<typeof Harness.open>[1],
	context: Context,
): Promise<AxiomTaskRuntime> {
	const root = await realpath(directory);
	context.abortSignal?.throwIfAborted();
	const guard = new DatabaseSync(join(root, "owner.sqlite"));
	try {
		// 独立锁库不阻塞 Durable 的正常提交，进程退出时由 SQLite 释放系统文件锁。
		guard.exec("BEGIN IMMEDIATE");
	} catch (error) {
		guard.close();
		// SQLite 的 BUSY 表示已有写入者，其他存储故障保留原始错误。
		if ((error as { errcode?: number }).errcode === 5) {
			throw new Error("AXIOM task already has an active owner", { cause: error });
		}
		throw error;
	}
	let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
	const closingContext = withoutAbortSignal(context);
	try {
		storage = await openNodeSqliteStorage(join(root, "runtime.sqlite"));
		const harness = await Harness.open(storage, options, context);
		let closing: Promise<void> | undefined;
		return {
			harness,
			close(): Promise<void> {
				// 收尾失败时继续持锁，避免其他进程在旧运行时尚未退出时接管。
				return (closing ??= harness.close(closingContext).then(() => guard.close()));
			},
		};
	} catch (error) {
		// 打开失败也先关闭 Durable 存储，再允许其他进程取得所有权。
		await storage?.close(closingContext);
		guard.close();
		throw error;
	}
}

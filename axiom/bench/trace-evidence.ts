// 归因只读取清单已绑定的归档字节。派生报告和历史原判不作为原始证据。
import { type Digest, file, sha256 } from "./io.ts";

export interface EvidenceReference extends Digest {
	locator: string;
}

export interface EvidenceDocument<T> {
	value: T;
	ref: (locator: string) => EvidenceReference;
}

export class TraceEvidence {
	private readonly root: string;
	private readonly entries = new Map<string, Digest>();

	constructor(root: string, entries: readonly Digest[]) {
		this.root = root;
		for (const entry of entries) {
			// 拒绝重复、跨目录和 Windows 混合分隔符，防止清单指向归档外。
			if (
				!/^[\w.-]+(?:\/[\w.-]+)*$/.test(entry.path) ||
				entry.path.split("/").some((segment) => segment === ".." || segment === ".") ||
				this.entries.has(entry.path) ||
				!/^[a-f0-9]{64}$/.test(entry.sha256) ||
				!Number.isSafeInteger(entry.bytes) ||
				entry.bytes < 0
			)
				throw new Error("Invalid trace evidence manifest");
			this.entries.set(entry.path, { path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
		}
	}

	// 只对已列入清单的证据授予引用，缺少的选填证据由归因规则处理。
	async document<T>(path: string, kind: "json" | "jsonl" = "json"): Promise<EvidenceDocument<T> | undefined> {
		const entry = this.entries.get(path);
		if (!entry) return undefined;
		const bytes = await this.checked(entry);
		const raw = bytes.toString("utf8");
		const value: unknown =
			kind === "json"
				? JSON.parse(raw)
				: raw.length
					? raw
							.replace(/\r?\n$/, "")
							.split(/\r?\n/)
							.map((line) => JSON.parse(line) as unknown)
					: [];
		return {
			value: value as T,
			ref: (locator): EvidenceReference => {
				validateLocator(value, locator, kind);
				return { ...entry, locator };
			},
		};
	}

	// 工件可以是权重等二进制文件，归因只需要核验字节及摘要。
	async artifact(path: string): Promise<EvidenceReference | undefined> {
		const entry = this.entries.get(path);
		if (!entry) return undefined;
		await this.checked(entry);
		return { ...entry, locator: "" };
	}

	// 历史归档整体复核，包含二进制资产。归因只引用随后成功解码的证据。
	async verifyAll(): Promise<void> {
		for (const entry of this.entries.values()) await this.checked(entry);
	}

	private async checked(entry: Digest): Promise<Buffer> {
		const bytes = await file(this.root, entry.path).catch((): never => {
			throw new Error("Trace evidence unavailable");
		});
		if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256)
			throw new Error("Trace evidence digest mismatch");
		return bytes;
	}
}

// RFC 6901 只访问对象自身字段。JSONL 按物理行号定位；空行属于坏证据。
function validateLocator(value: unknown, locator: string, kind: "json" | "jsonl"): void {
	if (!locator) return;
	if (kind === "jsonl") {
		const match = /^line:([1-9]\d*)$/.exec(locator);
		if (match && Array.isArray(value) && Number(match[1]) <= value.length) return;
		throw new Error("Invalid JSONL evidence line");
	}
	if (!locator.startsWith("/") || /~(?![01])/.test(locator)) throw new Error("Invalid JSON Pointer");
	let current = value;
	for (const escaped of locator.slice(1).split("/")) {
		const key = escaped.replaceAll("~1", "/").replaceAll("~0", "~");
		if (
			current === null ||
			typeof current !== "object" ||
			(Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(key)) ||
			!Object.hasOwn(current, key)
		)
			throw new Error("JSON Pointer does not locate evidence");
		current = (current as Record<string, unknown>)[key];
	}
}

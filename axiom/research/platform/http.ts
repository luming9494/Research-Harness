// 外部投影默认只允许本机服务，并拒绝跟随重定向。
export class PlatformHttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`Platform service HTTP ${status}`);
		this.status = status;
	}
}

export function localEndpoint(value: string): URL {
	const endpoint = new URL(value);
	if (
		endpoint.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.pathname !== "/" ||
		endpoint.hash ||
		endpoint.search
	)
		throw new Error("Platform endpoint must be a credential-free local origin");
	return endpoint;
}

// 传输失败只影响投影，响应不进入模型上下文。
export async function request<T>(origin: URL, path: string, method = "GET", body?: object): Promise<T> {
	const response = await fetch(new URL(path, origin), {
		method,
		redirect: "error",
		signal: AbortSignal.timeout(6_000),
		headers: { "content-type": "application/json" },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	if (!response.ok) throw new PlatformHttpError(response.status);
	const raw = await response.text();
	return (raw ? JSON.parse(raw) : {}) as T;
}

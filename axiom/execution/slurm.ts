// Slurm 通过已批准的 SSH 端点访问。提交结果不明时仅查队列和历史。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ExecutionObservation } from "../../packages/coding-agent/src/axiom/execution/execution-backend.ts";
import { runProcess } from "../../packages/coding-agent/src/axiom/execution/process.ts";
import {
	type Command,
	commandSucceeded,
	type ExecutionBackend,
	type ExecutionWorkspace,
	type SlurmProfile,
	unknown,
} from "./backend.ts";

export const artifacts = [
	"run/checkpoint.pt",
	"run/run.json",
	"run/history.json",
	"run/candidate/model.py",
	"run/candidate/config.json",
];
export const workerFiles = [
	"task.json",
	"common.py",
	"train.py",
	"evaluate.py",
	"judge.py",
	"experiment.py",
	"review_candidate.py",
];

// SSH 远端接收一条命令字符串，因此对每个参数统一做 POSIX 字面量引用。
function quote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const stageSource = `import sys, pathlib, json, base64, os, gzip
os.umask(0o077)
root=pathlib.Path(sys.argv[1]); assert root.parent.resolve()==root.parent and root.parent.is_dir()
root.mkdir(); (root/'output').mkdir()
for key, value in json.loads(gzip.decompress(base64.b64decode(sys.argv[2]))).items():
 target=root/key; target.parent.mkdir(parents=True, exist_ok=True)
 with target.open('xb') as f: f.write(base64.b64decode(value))`;
const readSource = `import sys,pathlib,base64
root=pathlib.Path(sys.argv[1]); p=root / sys.argv[2]
assert root.resolve()==root and p.resolve()==p and not p.is_symlink() and p.is_file()
if sys.argv[2]=='job.log':
 with p.open('rb') as f:
  f.seek(max(0,p.stat().st_size-65536)); data=f.read(65536)
else:
 with p.open('rb') as f: data=f.read(4194305)
 assert len(data)<=4194304
print(base64.b64encode(data).decode('ascii'))`;

interface SlurmRow {
	id: string;
	name: string;
	user: string;
	partition: string;
	account: string;
	state: string;
	exit?: string;
	elapsed?: string;
	allocation?: string;
	rss?: string;
	comment?: string;
	cluster?: string;
	submit?: string;
	workDir?: string;
}

function rows(output: string): SlurmRow[] {
	return output
		.trim()
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line): SlurmRow => {
			const [
				id,
				name,
				user,
				partition,
				account,
				state,
				exit,
				elapsed,
				allocation,
				rss,
				comment,
				cluster,
				submit,
				workDir,
			] = line.split("|").map((part) => part.trim());
			return {
				id,
				name,
				user,
				partition,
				account,
				state,
				exit,
				elapsed,
				allocation,
				rss,
				comment,
				cluster,
				submit,
				workDir,
			};
		});
}

// 保留未识别状态，成功必须同时具备控制器终态和零退出信号。
function observation(row: SlurmRow, source: string): ExecutionObservation {
	const state = row.state?.split(/[ +]/)[0];
	if (["PENDING", "CONFIGURING", "REQUEUED", "RESV_DEL_HOLD"].includes(state))
		return { id: row.id, status: "queued", evidence: source };
	if (["RUNNING", "COMPLETING", "SUSPENDED", "STAGE_OUT"].includes(state))
		return { id: row.id, status: "running", evidence: source };
	if (!row.exit || !/^\d+:\d+$/.test(row.exit) || !/^\d+$/.test(row.elapsed ?? ""))
		return unknown("slurm_terminal_accounting_incomplete");
	const [exitCode, signal] = row.exit.split(":").map(Number);
	const elapsedMs = Number(row.elapsed) * 1000;
	const resources = { allocation: row.allocation ?? null, max_rss: row.rss || null, exit_signal: signal };
	const terminal = { id: row.id, exitCode, elapsedMs, resources, evidence: source };
	if (state === "COMPLETED" && exitCode === 0 && signal === 0) return { ...terminal, status: "completed" };
	if (state === "CANCELLED" || state === "DEADLINE") return { ...terminal, status: "cancelled" };
	if (
		["FAILED", "COMPLETED", "TIMEOUT", "NODE_FAIL", "PREEMPTED", "OUT_OF_MEMORY", "BOOT_FAIL", "REVOKED"].includes(
			state,
		)
	)
		return { ...terminal, status: "failed" };
	return unknown("slurm_state_unrecognized");
}

export function slurmBackend(profile: SlurmProfile, root: string, testCommand?: Command): ExecutionBackend {
	for (const path of [profile.executable, profile.known_hosts, profile.identity_file].filter(
		(path): path is string => path !== undefined,
	))
		if (!isAbsolute(path) || /["\r\n]/.test(path))
			throw new Error("SSH client, known-hosts and identity paths must be absolute");
	const ssh = [
		"-F",
		"none",
		"-T",
		"-oBatchMode=yes",
		"-oStrictHostKeyChecking=yes",
		"-oConnectTimeout=8",
		"-oClearAllForwardings=yes",
		"-oIdentitiesOnly=yes",
		"-oGlobalKnownHostsFile=none",
		"-oForwardAgent=no",
		"-oUpdateHostKeys=no",
		"-oControlMaster=no",
		`-oUserKnownHostsFile="${profile.known_hosts}"`,
		...(profile.identity_file ? ["-i", profile.identity_file] : []),
		"--",
		`${profile.user}@${profile.host}`,
	];
	const call: Command =
		testCommand ??
		((args, signal, maxBytes) =>
			runProcess(profile.executable, [...ssh, `LC_ALL=C TZ=UTC ${args.map(quote).join(" ")}`], {
				cwd: root,
				home: join(root, "cli-home"),
				signal,
				maxBytes,
				timeoutMs: 15_000,
			}));
	const cluster = `--clusters=${profile.cluster}`;
	const directory = (work: ExecutionWorkspace): string => `${profile.remote_root}/${work.receipt.token}`;
	const comment = (work: ExecutionWorkspace): string => `axiom-${work.receipt.specSha256}-${work.receipt.fingerprint}`;

	async function inspect(work: ExecutionWorkspace): Promise<ExecutionObservation> {
		const name = work.receipt.token;
		const since = new Date(work.receipt.createdAt - 60_000).toISOString().slice(0, 19);
		const [queue, history] = await Promise.all([
			call(["squeue", cluster, "--noheader", "--states=all", `--name=${name}`, "--format=%i|%j|%u|%P|%a|%T"]),
			call([
				"sacct",
				cluster,
				"--noheader",
				"--allocations",
				"--duplicates",
				"--parsable2",
				`--name=${name}`,
				`--starttime=${since}`,
				"--format=JobIDRaw,JobName%60,User%64,Partition%64,Account%64,State%48,ExitCode,ElapsedRaw,AllocTRES%200,MaxRSS,Comment%160,Cluster%64,Submit,WorkDir%400",
			]),
		]);
		if (!commandSucceeded(queue) || !commandSucceeded(history))
			return unknown("slurm_queue_or_accounting_unavailable");
		const q = rows(
			queue.stdout
				.split(/\r?\n/)
				.filter((line) => line.trim() !== `CLUSTER: ${profile.cluster}`)
				.join("\n"),
		);
		const h = rows(history.stdout);
		const all = [...q, ...h];
		const known = work.receipt.submit?.id ?? work.receipt.observation?.id;
		if (!all.length) return unknown("slurm_no_visible_job_not_proof_of_non_submission");
		if (
			new Set(all.map((row) => row.id)).size !== 1 ||
			q.length > 1 ||
			h.length > 1 ||
			all.some(
				(row) =>
					!/^[1-9][0-9]{0,17}$/.test(row.id) ||
					(known && known !== row.id) ||
					row.name !== name ||
					row.user !== profile.user ||
					row.partition !== profile.partition ||
					row.account !== profile.account,
			)
		)
			return unknown("slurm_job_identity_conflict");
		const historical = h[0];
		if (
			historical &&
			(historical.cluster !== profile.cluster ||
				historical.workDir !== directory(work) ||
				(historical.comment && historical.comment !== comment(work)) ||
				!historical.submit ||
				historical.submit < since)
		)
			return unknown("slurm_historical_job_identity_conflict");
		if (q.length) {
			const job = await call(["scontrol", "-M", profile.cluster, "show", "job", "-o", q[0].id]);
			const record = job.stdout.trim();
			const fields = [
				`JobId=${q[0].id}`,
				`JobName=${name}`,
				`Partition=${profile.partition}`,
				`Account=${profile.account}`,
				`WorkDir=${directory(work)}`,
				`Comment=${comment(work)}`,
			];
			if (!commandSucceeded(job) || !fields.every((field) => record.split(/\s+/).includes(field)))
				return unknown("slurm_live_job_identity_unconfirmed");
		}
		return historical && !q.length
			? observation(historical, "slurm_sacct")
			: observation(q[0], "slurm_squeue_scontrol");
	}
	return {
		async preflight(work, signal): Promise<void> {
			if (work.receipt.reservedMs < profile.seconds * 1000)
				throw new Error("Slurm time exceeds approved remaining resource budget");
			const config = await readFile(join(work.input, "candidate", "config.json"));
			const files = [...workerFiles, "gpu_train.py"];
			const payload: Record<string, string> = {
				"input/candidate/config.json": config.toString("base64"),
				"input/candidate/model.py": (await readFile(join(work.input, "candidate", "model.py"))).toString("base64"),
			};
			for (const file of files)
				payload[`input/eval/${file}`] = (await readFile(join(work.input, "eval", file))).toString("base64");
			// 模板固定所有脚本、产物和日志路径，排队计时与实际分配期限均引用原预算。
			const dir = directory(work);
			const script = `#!/bin/sh\nset -eu\numask 077\nexport PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1\ncd ${quote(dir)}\nremaining=$((${Math.floor(work.receipt.deadline / 1000)} - $(/usr/bin/date +%s)))\n[ "$remaining" -gt 2 ]\nif [ "$remaining" -gt ${profile.seconds} ]; then remaining=${profile.seconds}; fi\nexec /usr/bin/timeout --signal=TERM --kill-after=2s "$((remaining - 2))s" ${quote(profile.python)} input/eval/gpu_train.py --candidate input/candidate --output output/run --min-vram-mib ${profile.min_vram_mib}${work.smoke ? " --smoke-output output/smoke" : ""}\n`;
			payload["job.sh"] = Buffer.from(script).toString("base64");
			const [partition, account] = await Promise.all([
				call(["sinfo", cluster, `--partition=${profile.partition}`, "--noheader", "--format=%R"], signal),
				call(
					[
						"sacctmgr",
						"--noheader",
						"--parsable2",
						"show",
						"association",
						`where`,
						`user=${profile.user}`,
						`cluster=${profile.cluster}`,
						`account=${profile.account}`,
						"format=Cluster,Account,User,Partition",
					],
					signal,
				),
			]);
			if (
				!commandSucceeded(partition) ||
				!partition.stdout.split(/\s+/).includes(profile.partition) ||
				!commandSucceeded(account) ||
				!account.stdout.split(/\r?\n/).some((line) => {
					const [c, a, u, p] = line.split("|");
					return (
						c === profile.cluster &&
						a === profile.account &&
						u === profile.user &&
						(!p || p === profile.partition)
					);
				})
			)
				throw new Error("Slurm SSH, partition or account preflight failed");
			// 保持单次传输低于 Windows OpenSSH 的 argv 上限。远端脚本仍只写固定资产。
			const transfer = gzipSync(JSON.stringify(payload)).toString("base64");
			if (transfer.length > 24_000) throw new Error("Fixed Slurm workload exceeds staging limit");
			const prepared = await call([profile.python, "-c", stageSource, dir, transfer], signal);
			if (!commandSucceeded(prepared)) throw new Error("Slurm immutable input staging failed before submission");
		},
		async submit(work, signal): Promise<ExecutionObservation> {
			const dir = directory(work);
			const seconds = profile.seconds;
			const wall = `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
			const result = await call(
				[
					"sbatch",
					cluster,
					"--parsable",
					"--no-requeue",
					"--export=NIL",
					`--partition=${profile.partition}`,
					`--account=${profile.account}`,
					"--nodes=1",
					"--ntasks=1",
					`--cpus-per-task=${profile.cpu}`,
					`--gpus=${profile.gpus}`,
					`--mem=${profile.memory_mib}M`,
					`--time=${wall}`,
					`--deadline=${new Date(work.receipt.deadline).toISOString().slice(0, 19)}`,
					`--job-name=${work.receipt.token}`,
					`--comment=${comment(work)}`,
					`--chdir=${dir}`,
					`--output=${dir}/output/job.log`,
					`${dir}/job.sh`,
				],
				signal,
			);
			const [id, foundCluster, extra] = result.stdout.trim().split(";");
			return commandSucceeded(result) &&
				/^[1-9][0-9]{0,17}$/.test(id) &&
				foundCluster === profile.cluster &&
				extra === undefined
				? { id, status: "submitted", evidence: "slurm_sbatch_parsable" }
				: unknown("slurm_submission_receipt_missing");
		},
		inspect,
		async cancel(work, id): Promise<void> {
			const state = await inspect(work);
			if (state.id === id && ["queued", "running"].includes(state.status)) await call(["scancel", cluster, id]);
		},
		async collect(work, _id): Promise<void> {
			const name = `job.log`;
			for (const path of [name, ...(work.receipt.observation?.status === "completed" ? artifacts : [])]) {
				const result = await call(
					[profile.python, "-c", readSource, `${directory(work)}/output`, path],
					undefined,
					6_000_000,
				);
				const encoded = result.stdout.trim();
				if (!commandSucceeded(result) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
					throw new Error(`Missing remote artifact ${path}`);
				const target = join(work.output, path === name ? "worker.log" : path);
				const content = Buffer.from(encoded, "base64");
				await mkdir(dirname(target), { recursive: true });
				// 提交丢失后允许读回同一工件，只接受完全相同的已存在字节。
				try {
					await writeFile(target, content, { flag: "wx" });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(target)).equals(content))
						throw error;
				}
			}
		},
		async cleanup(): Promise<void> {
			/* 远程证据保留于批准目录，不删除远端科研数据。 */
		},
	};
}

// SQLite 是批准策略和发布审计的唯一权威来源，任务恢复仍只读取原有 Durable 账本。
import { DatabaseSync } from "node:sqlite";
import {
	approvedPolicy,
	type PolicyBinding,
	verifyPolicy,
} from "../../packages/coding-agent/src/axiom/execution/harness-policy.ts";

export interface ReleaseApproval {
	version: 1;
	outcome: "eligible" | "rejected" | "inconclusive";
	candidate_id: string;
	active_before: string;
	parent_sha256: string;
	policy_sha256: string;
	plan_sha256: string;
	proofs: { run_id: string; manifest_sha256: string; result_sha256: string }[];
}

type Pointer = { active: string; previous: string | null };
type AuditEvidence = { type: "operator" | "benchmark" | "binding_integrity"; reference: string; reason: string };
type Row = { payload: string };

export class PolicyRegistry {
	private readonly db: DatabaseSync;

	constructor(path: string, access: "write" | "read" = "write") {
		this.db = new DatabaseSync(path, { readOnly: access === "read" });
		try {
			// 预演和查询不能建库，也不能触发新任务使用的自愈写事务。
			if (access === "read") {
				this.db.exec("PRAGMA busy_timeout=5000");
				return;
			}
			this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
				CREATE TABLE IF NOT EXISTS policies (sha TEXT PRIMARY KEY, version INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL, approval TEXT);
				CREATE TABLE IF NOT EXISTS pointer (id INTEGER PRIMARY KEY CHECK(id=1), active TEXT NOT NULL, previous TEXT);
				CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, event TEXT NOT NULL, prior TEXT NOT NULL, next TEXT NOT NULL, evidence TEXT NOT NULL, at TEXT NOT NULL);`);
			this.write(() => {
				const base = approvedPolicy(true);
				this.db
					.prepare("INSERT OR IGNORE INTO policies VALUES (?, 1, ?, NULL)")
					.run(base.sha256, JSON.stringify(base));
				this.db.prepare("INSERT OR IGNORE INTO pointer VALUES (1, ?, NULL)").run(base.sha256);
			});
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	/** 查询接口只核验当前指针，实际自愈由新任务加载或显式宿主操作负责。 */
	inspect(): PolicyBinding {
		return this.binding(this.pointer().active);
	}

	/** 返回原子指针快照，并为新任务核验实际策略字节。 */
	active(): { policy: PolicyBinding; rolled_back: boolean } {
		return this.write(() => {
			const point = this.pointer();
			try {
				return { policy: this.binding(point.active), rolled_back: false };
			} catch {
				const policy = this.rollbackTo(point, {
					type: "binding_integrity",
					reference: point.active,
					reason: "active_policy_integrity_failure",
				});
				return { policy, rolled_back: true };
			}
		});
	}

	/** 仅由宿主在重算审批后调用。旧版本、指针和审计在同一事务提交。 */
	publish(policy: PolicyBinding, approval: ReleaseApproval): void {
		const checked = verifyPolicy(policy);
		if (
			approval.version !== 1 ||
			approval.outcome !== "eligible" ||
			approval.policy_sha256 !== checked.sha256 ||
			checked.config.source !== "operator" ||
			!checked.enhanced ||
			!approval.proofs.length ||
			!/^([a-f0-9]{64})$/.test(approval.plan_sha256) ||
			!/^[a-f0-9]{64}$/.test(approval.parent_sha256)
		)
			throw new Error("Candidate is not authorized for release");
		this.write(() => {
			const point = this.pointer();
			if (point.active !== approval.active_before) throw new Error("Active policy changed since evaluation");
			this.binding(point.active);
			this.db
				.prepare("INSERT INTO policies VALUES (?, ?, ?, ?)")
				.run(checked.sha256, checked.config.version, JSON.stringify(checked), JSON.stringify(approval));
			this.db.prepare("UPDATE pointer SET active=?, previous=? WHERE id=1").run(checked.sha256, point.active);
			this.record("published", point.active, checked.sha256, approval);
		});
	}

	/** 绑定当前身份避免来自旧部署的告警回滚后续版本。 */
	rollback(expected: string, evidence: AuditEvidence): PolicyBinding {
		return this.write(() => {
			const point = this.pointer();
			if (point.active !== expected) throw new Error("Rollback evidence applies to a different active policy");
			return this.rollbackTo(point, evidence);
		});
	}

	/** 查询持久化的发布和回滚证据。 */
	audit(): Record<string, unknown>[] {
		return this.db.prepare("SELECT * FROM audit ORDER BY id").all();
	}

	close(): void {
		this.db.close();
	}

	// 事务断电回放由 SQLite 负责。指针、版本和审计不会单独出现。
	private write<T>(work: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private pointer(): Pointer {
		const row = this.db.prepare("SELECT active, previous FROM pointer WHERE id=1").get() as Pointer | undefined;
		if (!row) throw new Error("Missing active policy pointer");
		return row;
	}

	private binding(sha: string): PolicyBinding {
		const row = this.db.prepare("SELECT payload FROM policies WHERE sha=?").get(sha) as Row | undefined;
		if (!row) throw new Error("Missing registered policy");
		const policy = verifyPolicy(JSON.parse(row.payload) as PolicyBinding);
		if (policy.sha256 !== sha || !policy.enhanced) throw new Error("Registered policy identity mismatch");
		return policy;
	}

	private rollbackTo(point: Pointer, evidence: AuditEvidence): PolicyBinding {
		const base = approvedPolicy(true);
		if (point.active === base.sha256) {
			if (evidence.type !== "binding_integrity") throw new Error("The built-in policy is already active");
			throw new Error("Failed to verify the built-in registry row");
		}
		let target = base;
		if (point.previous) {
			try {
				target = this.binding(point.previous);
			} catch {
				target = this.binding(base.sha256);
			}
		}
		// 上一个已验收版本恢复原来的前任，连续回滚仍可回到安全基线。
		const history = this.db
			.prepare("SELECT prior FROM audit WHERE event='published' AND next=? ORDER BY id DESC LIMIT 1")
			.get(target.sha256) as { prior: string } | undefined;
		this.db.prepare("UPDATE pointer SET active=?, previous=? WHERE id=1").run(target.sha256, history?.prior ?? null);
		this.record("rolled_back", point.active, target.sha256, evidence);
		return target;
	}

	private record(event: string, prior: string, next: string, evidence: object): void {
		this.db
			.prepare("INSERT INTO audit(event,prior,next,evidence,at) VALUES (?,?,?,?,?)")
			.run(event, prior, next, JSON.stringify(evidence), new Date().toISOString());
	}
}

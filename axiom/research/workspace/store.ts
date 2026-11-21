// 工作区只持久化研究关系、审批和来源引用。运行状态仍由原矩阵和 Durable 账本读取。
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../../bench/io.ts";

export type EvidenceStatus = "verified" | "reported" | "pending";
export interface Node {
	id: string;
	kind:
		| "question"
		| "paper"
		| "claim"
		| "hypothesis"
		| "plan"
		| "dataset"
		| "implementation"
		| "protocol"
		| "run"
		| "metric"
		| "artifact"
		| "finding";
	data: object;
}
export interface Relation {
	from: string;
	to: string;
	kind: string;
	source: string;
	status: EvidenceStatus;
}
export interface Project {
	id: string;
	name: string;
	objective: string;
	status: "active" | "paused" | "closed";
	created: string;
}
export interface Graph {
	project: Project;
	revisions: { status: Project["status"]; at: string }[];
	nodes: Node[];
	relations: Relation[];
}

// 项目 ID 仅作为数据库键。所有项目共享一个受控的本地工作区数据库。
export class Workspace {
	private readonly db: DatabaseSync;
	constructor(root: string) {
		mkdirSync(root, { recursive: true });
		this.db = new DatabaseSync(join(root, "workspace.sqlite"));
		this.db.exec(`
			PRAGMA foreign_keys=ON;
			PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY, project TEXT REFERENCES projects(id), payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS nodes(project TEXT REFERENCES projects(id), id TEXT, payload TEXT NOT NULL, PRIMARY KEY(project,id));
			CREATE TABLE IF NOT EXISTS links(project TEXT, id TEXT, origin TEXT, target TEXT, payload TEXT NOT NULL,
				PRIMARY KEY(project,id), FOREIGN KEY(project,origin) REFERENCES nodes(project,id),
				FOREIGN KEY(project,target) REFERENCES nodes(project,id));
		`);
	}

	create(name: string, objective: string): Project {
		if (!name.trim() || !objective.trim() || name.length > 200 || objective.length > 1000)
			throw new Error("Invalid research project metadata");
		const project: Project = {
			id: randomUUID(),
			name,
			objective,
			status: "active",
			created: new Date().toISOString(),
		};
		this.db.prepare("INSERT INTO projects VALUES (?,?)").run(project.id, JSON.stringify(project));
		return project;
	}

	setStatus(id: string, status: Project["status"]): void {
		if (this.read(id).project.status === status) return;
		this.db
			.prepare("INSERT INTO revisions(project,payload) VALUES (?,?)")
			.run(id, JSON.stringify({ status, at: new Date().toISOString() }));
	}

	read(id: string): Graph {
		// 同一快照读取节点及边，避免其他进程提交新关系时出现悬空引用。
		return this.transaction("BEGIN", (): Graph => {
			const row = this.db.prepare("SELECT metadata FROM projects WHERE id=?").get(id);
			if (!row) throw new Error("Research project not found");
			const project = JSON.parse(String(row.metadata)) as Project;
			const revisions = this.rows<Graph["revisions"][number]>(
				"SELECT payload FROM revisions WHERE project=? ORDER BY seq",
				id,
			);
			project.status = revisions.at(-1)?.status ?? project.status;
			return {
				project,
				revisions,
				nodes: this.rows<Node>("SELECT payload FROM nodes WHERE project=? ORDER BY id", id),
				relations: this.rows<Relation>("SELECT payload FROM links WHERE project=? ORDER BY id", id),
			};
		});
	}

	// 整个证据批次原子提交，相同身份允许幂等重放，拒绝改写原事实。
	link(project: string, nodes: Node[], relations: Relation[]): void {
		this.transaction("BEGIN IMMEDIATE", (): void => {
			for (const node of nodes) {
				const payload = JSON.stringify(node);
				this.db.prepare("INSERT OR IGNORE INTO nodes VALUES (?,?,?)").run(project, node.id, payload);
				if (
					this.db.prepare("SELECT payload FROM nodes WHERE project=? AND id=?").get(project, node.id)?.payload !==
					payload
				)
					throw new Error("Research evidence identity conflict");
			}
			for (const edge of relations) {
				const payload = JSON.stringify(edge);
				this.db
					.prepare("INSERT OR IGNORE INTO links VALUES (?,?,?,?,?)")
					.run(project, sha256(payload), edge.from, edge.to, payload);
			}
		});
	}

	close(): void {
		this.db.close();
	}

	// 读写共用同一 SQLite 提交或回滚边界。
	private transaction<T>(begin: "BEGIN" | "BEGIN IMMEDIATE", work: () => T): T {
		this.db.exec(begin);
		try {
			const value = work();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private rows<T>(sql: string, id: string): T[] {
		return this.db
			.prepare(sql)
			.all(id)
			.map(({ payload }) => JSON.parse(String(payload)) as T);
	}
}

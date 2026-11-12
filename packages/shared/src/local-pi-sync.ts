/** Encodes a project cwd the same way pi names its session dir (pi session-manager getDefaultSessionDirPath). */
export function encodePiSessionDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** One project (working directory) that has sessions in the local Pi agent dir. */
export interface LocalPiSyncProject {
	/** Encoded session directory name under <source>/sessions/ (pi's safePath encoding). */
	project: string;
	/** Total .jsonl session files in the source project directory. */
	sessions: number;
	/** .jsonl files already present in Percho storage (same name). */
	synced: number;
	/** .jsonl session files in Percho storage for this project (可导出的数量). */
	inStorage: number;
	/** 已登记：启动时自动对该项目做增量导入. */
	auto: boolean;
	/** 在 Percho 里被删过、因此同步不再导回的会话数（墓碑）. */
	removed: number;
	/** ISO mtime of the newest session file on either side, or null when both are empty. */
	newestMtime: string | null;
}
export interface LocalPiSyncProjects {
	/** Source agent directory, or null when no local Pi data dir exists. */
	source: string | null;
	available: boolean;
	projects: LocalPiSyncProject[];
}
export interface LocalPiSyncResult {
	project: string;
	added: number;
	skipped: number;
	/** 因墓碑（用户在 Percho 里删过）而没有导回的数量. */
	blocked: number;
}
/** 一条墓碑：用户在 Percho 里删掉的本地 Pi 会话（同步从此不再把它导回）. */
export interface LocalPiRemoval {
	project: string;
	/** 会话文件名（<source>/sessions/<project>/ 下的 .jsonl 名）. */
	file: string;
	/** 删除时间（ISO）. */
	at: string;
}
export interface LocalPiRestoreResult {
	project: string;
	file: string;
	/** 是否已经把会话取回 Percho 存储（本地 Pi 里已没有该文件时为 false）. */
	restored: boolean;
}
export interface LocalPiAutoSyncResult {
	project: string;
	auto: boolean;
}
/** 启动自动同步的汇总（只覆盖账本里登记过的项目）. */
export interface LocalPiAutoSyncSummary {
	/** 账本里登记为自动同步的项目名. */
	attempted: string[];
	added: number;
	skipped: number;
	/** 因墓碑（用户在 Percho 里删过）而没有导回的数量. */
	blocked: number;
	/** 复制出错的项目名（不影响其他项目）. */
	failed: string[];
}

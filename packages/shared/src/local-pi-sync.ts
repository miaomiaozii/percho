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
	/** 复制出错的项目名（不影响其他项目）. */
	failed: string[];
}

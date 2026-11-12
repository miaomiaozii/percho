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
	/** ISO mtime of the newest source session file, or null when the directory is empty. */
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

import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
	LocalPiAutoSyncResult,
	LocalPiAutoSyncSummary,
	LocalPiSyncProject,
	LocalPiSyncProjects,
	LocalPiSyncResult,
} from "@percho/shared";
import { sessionNameFromUserText } from "../session/naming";
import { inside } from "./path-policy";

/** 可以用这个环境变量指定要跟随的本地 Pi 安装目录（优先于默认候选）。 */
export const LOCAL_PI_SOURCE_ENV = "PERCHO_LOCAL_PI_DIR";
/** Local Pi CLI agent directories, in sync priority order. */
export function localPiSourceCandidates(): string[] {
	const home = homedir();
	const candidates = [join(home, ".pi", "agent"), join(home, ".pi", "agent-dev")];
	const override = process.env[LOCAL_PI_SOURCE_ENV]?.trim();
	if (override) candidates.unshift(isAbsolute(override) ? override : resolve(override));
	return candidates;
}
async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
async function isPlainDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}
/** First local Pi data dir that exists and does not overlap the Percho storage target. */
export async function resolveLocalPiSource(target: string): Promise<string | null> {
	for (const candidate of localPiSourceCandidates()) {
		if (inside(target, candidate) || inside(candidate, target)) continue;
		if (await isDirectory(candidate)) return candidate;
	}
	return null;
}
const CREDENTIAL_FILES = ["models.json", "auth.json"] as const;
/** An empty JSON placeholder counts as "no data yet", so it never blocks a sync. */
async function isEmptyCredentialFile(path: string): Promise<boolean> {
	try {
		const text = (await readFile(path, "utf8")).trim();
		if (text === "") return true;
		const parsed: unknown = JSON.parse(text);
		if (parsed === null) return true;
		if (Array.isArray(parsed)) return parsed.length === 0;
		return typeof parsed === "object" && Object.keys(parsed as Record<string, unknown>).length === 0;
	} catch {
		// Unreadable or malformed: keep whatever is there rather than overwriting it.
		return false;
	}
}
/**
 * Copy model/auth files from the local Pi agent dir into Percho storage.
 * A file is copied when missing, when it is still an empty placeholder, or when
 * the source is newer; anything else is left untouched. Best-effort per file:
 * one unreadable file never blocks startup.
 */
export async function syncLocalPiCredentials(source: string, target: string): Promise<{ copied: string[] }> {
	const copied: string[] = [];
	await mkdir(target, { recursive: true });
	for (const name of CREDENTIAL_FILES) {
		try {
			const from = join(source, name);
			const to = join(target, name);
			const [s, t] = await Promise.all([stat(from).catch(() => null), stat(to).catch(() => null)]);
			if (!s?.isFile()) continue;
			if (t && t.mtimeMs >= s.mtimeMs && !(await isEmptyCredentialFile(to))) continue;
			const tmp = `${to}.local-pi-sync-tmp`;
			await copyFile(from, tmp);
			await rename(tmp, to);
			copied.push(name);
		} catch {
			// best-effort: ignore individual file failures
		}
	}
	return { copied };
}
async function sessionFiles(dir: string): Promise<Map<string, number>> {
	const files = new Map<string, number>();
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return files;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			const info = await lstat(join(dir, name));
			if (info.isFile()) files.set(name, info.mtimeMs);
		} catch {
			// unreadable entry: skip
		}
	}
	return files;
}
function isValidProjectName(project: string): boolean {
	return (
		project.length > 0 &&
		project !== "." &&
		project !== ".." &&
		!isAbsolute(project) &&
		!project.includes(sep) &&
		!project.includes("\0")
	);
}
export async function listLocalPiProjects(
	target: string,
	options?: { source?: string },
): Promise<LocalPiSyncProjects> {
	const source = options?.source ?? (await resolveLocalPiSource(target));
	if (!source) return { source: null, available: false, projects: [] };
	const sourceRoot = join(source, "sessions");
	const targetRoot = join(target, "sessions");
	const ledger = await readSyncLedger(target);
	const names = new Set<string>();
	for (const root of [sourceRoot, targetRoot]) {
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch {
			continue;
		}
		for (const name of entries)
			if (isValidProjectName(name) && (await isPlainDirectory(join(root, name)))) names.add(name);
	}
	const projects: LocalPiSyncProject[] = [];
	for (const name of names) {
		const sourceFiles = await sessionFiles(join(sourceRoot, name));
		const storageFiles = await sessionFiles(join(targetRoot, name));
		if (sourceFiles.size === 0 && storageFiles.size === 0) continue;
		let synced = 0;
		for (const file of sourceFiles.keys()) if (storageFiles.has(file)) synced += 1;
		const newestMtime = [...sourceFiles.values(), ...storageFiles.values()].reduce<number | null>(
			(max, m) => (max === null || m > max ? m : max),
			null,
		);
		projects.push({
			project: name,
			sessions: sourceFiles.size,
			synced,
			inStorage: storageFiles.size,
			auto: ledger.projects[name]?.auto === true,
			newestMtime: newestMtime === null ? null : new Date(newestMtime).toISOString(),
		});
	}
	projects.sort(
		(a, b) => (b.newestMtime ?? "").localeCompare(a.newestMtime ?? "") || a.project.localeCompare(b.project),
	);
	return { source, available: true, projects };
}
/**
 * Copy the selected project's session files from the local Pi agent dir into
 * Percho storage. Files already present with a newer-or-equal mtime are skipped,
 * so re-syncing appends new local-Pi activity without clobbering local edits.
 * A manual sync also enrolls the project for automatic incremental sync at startup.
 */
export async function syncLocalPiProject(
	target: string,
	project: string,
	options?: { source?: string },
): Promise<LocalPiSyncResult> {
	if (!isValidProjectName(project)) throw new Error(`Invalid project name: ${project}`);
	const source = options?.source ?? (await resolveLocalPiSource(target));
	if (!source) throw new Error("No local Pi agent directory found");
	const sourceRoot = join(source, "sessions");
	const from = join(sourceRoot, project);
	if (!inside(sourceRoot, from) || !(await isPlainDirectory(from)))
		throw new Error(`Unknown local Pi project: ${project}`);
	const result = await copyProjectSessions(from, join(target, "sessions", project), { nameImported: true });
	const ledger = await readSyncLedger(target);
	ledger.projects[project] = { auto: true, syncedAt: new Date().toISOString() };
	await writeSyncLedger(target, ledger);
	return { project, ...result };
}
/**
 * 回流：把 Percho 存储里该项目的会话导出到本地 Pi 会话目录。
 * 对端同名文件更新时跳过，绝不覆盖本地 Pi 里更新的版本；不会删除对端任何文件。
 */
export async function exportLocalPiProject(
	target: string,
	project: string,
	options?: { source?: string },
): Promise<LocalPiSyncResult> {
	if (!isValidProjectName(project)) throw new Error(`Invalid project name: ${project}`);
	const source = options?.source ?? (await resolveLocalPiSource(target));
	if (!source) throw new Error("No local Pi agent directory found");
	const storageRoot = join(target, "sessions");
	const from = join(storageRoot, project);
	if (!inside(storageRoot, from) || !(await isPlainDirectory(from)))
		throw new Error(`Unknown Percho project: ${project}`);
	const result = await copyProjectSessions(from, join(source, "sessions", project));
	return { project, ...result };
}
/** 开关某个项目的启动自动同步（关掉 = 从账本移出，不再自动拉）。 */
export async function setLocalPiAutoSync(
	target: string,
	project: string,
	auto: boolean,
): Promise<LocalPiAutoSyncResult> {
	if (!isValidProjectName(project)) throw new Error(`Invalid project name: ${project}`);
	const ledger = await readSyncLedger(target);
	if (auto) ledger.projects[project] = { auto: true, syncedAt: new Date().toISOString() };
	else delete ledger.projects[project];
	await writeSyncLedger(target, ledger);
	return { project, auto };
}
/** 启动自动同步：只对账本里登记过的项目做增量导入；单个项目出错不影响其它。 */
export async function autoSyncLocalPiProjects(
	target: string,
	options?: { source?: string },
): Promise<LocalPiAutoSyncSummary> {
	// 早期版本导入的会话没补名字，启动时一次性补齐（只写 Percho 存储，不碰本地 Pi）。
	const titled = await nameUntitledSessions(join(target, "sessions"));
	if (titled > 0) console.log(`[local-pi-sync] 补会话标题 ${titled} 个`);
	const ledger = await readSyncLedger(target);
	const names = Object.entries(ledger.projects)
		.filter(([name, entry]) => entry?.auto === true && isValidProjectName(name))
		.map(([name]) => name);
	const summary: LocalPiAutoSyncSummary = { attempted: names, added: 0, skipped: 0, failed: [] };
	if (names.length === 0) return summary;
	const source = options?.source ?? (await resolveLocalPiSource(target));
	if (!source) return summary;
	const sourceRoot = join(source, "sessions");
	const stamp = new Date().toISOString();
	let changed = false;
	for (const name of names) {
		const from = join(sourceRoot, name);
		if (!(await isPlainDirectory(from))) continue;
		try {
			const { added, skipped } = await copyProjectSessions(from, join(target, "sessions", name), {
				nameImported: true,
			});
			summary.added += added;
			summary.skipped += skipped;
			if (added > 0) {
				ledger.projects[name] = { auto: true, syncedAt: stamp };
				changed = true;
			}
		} catch {
			summary.failed.push(name);
		}
	}
	if (changed) await writeSyncLedger(target, ledger);
	return summary;
}

const LEDGER_FILE = "local-pi-sync.json";
interface LedgerProject {
	auto: boolean;
	syncedAt: string;
}
interface SyncLedger {
	version: 1;
	projects: Record<string, LedgerProject>;
}
/** 同步账本存在 Percho 存储根目录（不往本地 Pi 目录写东西）。 */
export function localPiSyncLedgerPath(target: string): string {
	return join(target, LEDGER_FILE);
}
async function readSyncLedger(target: string): Promise<SyncLedger> {
	try {
		const parsed = JSON.parse(await readFile(localPiSyncLedgerPath(target), "utf8")) as Partial<SyncLedger>;
		const projects: Record<string, LedgerProject> = {};
		for (const [name, value] of Object.entries(parsed?.projects ?? {})) {
			if (!isValidProjectName(name) || typeof value !== "object" || value === null) continue;
			const entry = value as Partial<LedgerProject>;
			projects[name] = {
				auto: entry.auto === true,
				syncedAt: typeof entry.syncedAt === "string" ? entry.syncedAt : "",
			};
		}
		return { version: 1, projects };
	} catch {
		return { version: 1, projects: {} };
	}
}
async function writeSyncLedger(target: string, ledger: SyncLedger): Promise<void> {
	await mkdir(target, { recursive: true });
	const to = localPiSyncLedgerPath(target);
	const tmp = `${to}.local-pi-sync-tmp`;
	await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
	await rename(tmp, to);
}
/** 一个方向的增量复制：同名且对端 mtime 更新则跳过，写入走 tmp + rename 保证原子。 */
async function copyProjectSessions(
	fromDir: string,
	toDir: string,
	options?: { nameImported?: boolean },
): Promise<{ added: number; skipped: number }> {
	await mkdir(toDir, { recursive: true });
	let added = 0;
	let skipped = 0;
	for (const [name, mtimeMs] of await sessionFiles(fromDir)) {
		const toFile = join(toDir, name);
		const existing = await lstat(toFile).catch(() => null);
		if (existing?.isFile() && existing.mtimeMs >= mtimeMs) {
			skipped += 1;
			continue;
		}
		const tmp = `${toFile}.local-pi-sync-tmp`;
		await copyFile(join(fromDir, name), tmp);
		if (options?.nameImported) await nameImportedSession(tmp);
		await rename(tmp, toFile);
		added += 1;
	}
	return { added, skipped };
}
/** 给存储里所有还没名字的会话补上标题，返回补了几个（递归扫项目目录）。 */
async function nameUntitledSessions(sessionsDir: string): Promise<number> {
	const projectDirs = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
	let titled = 0;
	for (const entry of projectDirs) {
		if (!entry.isDirectory()) continue;
		for (const [name] of await sessionFiles(join(sessionsDir, entry.name))) {
			const path = join(sessionsDir, entry.name, name);
			if (await readSessionNameFrom(path)) continue;
			await nameImportedSession(path);
			if (await readSessionNameFrom(path)) titled += 1;
		}
	}
	return titled;
}

/** 读会话已有的 session_info 名字（取最后一个）。 */
async function readSessionNameFrom(path: string): Promise<string | undefined> {
	const text = await readFile(path, "utf8").catch(() => "");
	let name: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const record = entry as { type?: string; name?: string } | null;
		if (record?.type === "session_info" && typeof record.name === "string" && record.name.trim())
			name = record.name;
	}
	return name;
}

/**
 * 给会话补一个标题（只写 Percho 这边的副本，不碰本地 Pi 原文件）。
 * Pi CLI 不会自动命名，没名的会话在 Percho 侧栏会退回成项目名（一个项目下一排同名）。
 * 取名规则与 packages/backend/src/session/naming.ts 一致：首行截 30 字，skill 命令还原成 /skill。
 */
async function nameImportedSession(path: string): Promise<void> {
	const text = await readFile(path, "utf8");
	let lastId = "";
	let hasHeader = false;
	let titled = false;
	let firstUser = "";
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.id === "string") lastId = record.id;
		if (record.type === "session") hasHeader = true;
		else if (record.type === "session_info" && typeof record.name === "string" && record.name.trim())
			titled = true;
		else if (!firstUser && record.type === "message") firstUser = firstUserText(record.message);
	}
	if (!hasHeader || titled || !firstUser) return;
	const name = sessionNameFromUserText(firstUser);
	if (!name) return;
	const entry = {
		type: "session_info",
		id: randomUUID().replace(/-/g, "").slice(0, 8),
		parentId: lastId,
		timestamp: new Date().toISOString(),
		name,
	};
	const body = text.endsWith("\n") ? text : `${text}\n`;
	await writeFile(path, `${body}${JSON.stringify(entry)}\n`, "utf8");
}
/** 会话首条用户消息的文本；取名交给 sessionNameFromUserText，与顶栏自动命名同一套。 */
function firstUserText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const record = message as Record<string, unknown>;
	if (record.role !== "user") return "";
	const content = record.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(block): block is Record<string, unknown> =>
								!!block && typeof block === "object" && (block as Record<string, unknown>).type === "text",
						)
						.map((block) => (typeof block.text === "string" ? block.text : ""))
						.join(" ")
				: "";
	return text;
}

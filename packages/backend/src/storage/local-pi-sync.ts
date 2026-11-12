import { copyFile, lstat, mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { LocalPiSyncProject, LocalPiSyncProjects, LocalPiSyncResult } from "@percho/shared";
import { inside } from "./path-policy";

/** Local Pi CLI agent directories, in sync priority order. */
export function localPiSourceCandidates(): string[] {
	const home = homedir();
	return [join(home, ".pi", "agent"), join(home, ".pi", "agent-dev")];
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
/**
 * Copy model/auth files from the local Pi agent dir into Percho storage.
 * A file is copied when missing or when the source is newer; anything else is
 * left untouched. Best-effort per file: one unreadable file never blocks startup.
 */
export async function syncLocalPiCredentials(source: string, target: string): Promise<{ copied: string[] }> {
	const copied: string[] = [];
	await mkdir(target, { recursive: true });
	for (const name of CREDENTIAL_FILES) {
		try {
			const from = join(source, name);
			const to = join(target, name);
			const [s, t] = await Promise.all([stat(from).catch(() => null), stat(to).catch(() => null)]);
			if (!s?.isFile() || (t && t.mtimeMs >= s.mtimeMs)) continue;
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
export async function listLocalPiProjects(target: string): Promise<LocalPiSyncProjects> {
	const source = await resolveLocalPiSource(target);
	if (!source) return { source: null, available: false, projects: [] };
	const sourceRoot = join(source, "sessions");
	const targetRoot = join(target, "sessions");
	let names: string[];
	try {
		names = await readdir(sourceRoot);
	} catch {
		return { source, available: true, projects: [] };
	}
	const projects: LocalPiSyncProject[] = [];
	for (const name of names) {
		if (!isValidProjectName(name) || !(await isPlainDirectory(join(sourceRoot, name)))) continue;
		const files = await sessionFiles(join(sourceRoot, name));
		if (files.size === 0) continue;
		let synced = 0;
		if (await isDirectory(targetRoot))
			for (const file of files.keys()) {
				try {
					if ((await lstat(join(targetRoot, name, file))).isFile()) synced += 1;
				} catch {
					// not synced yet
				}
			}
		const newestMtime = [...files.values()].reduce<number | null>(
			(max, m) => (max === null || m > max ? m : max),
			null,
		);
		projects.push({
			project: name,
			sessions: files.size,
			synced,
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
 */
export async function syncLocalPiProject(target: string, project: string): Promise<LocalPiSyncResult> {
	if (!isValidProjectName(project)) throw new Error(`Invalid project name: ${project}`);
	const source = await resolveLocalPiSource(target);
	if (!source) throw new Error("No local Pi agent directory found");
	const sourceRoot = join(source, "sessions");
	const from = join(sourceRoot, project);
	if (!inside(sourceRoot, from) || !(await isPlainDirectory(from)))
		throw new Error(`Unknown local Pi project: ${project}`);
	const to = join(target, "sessions", project);
	await mkdir(to, { recursive: true });
	let added = 0;
	let skipped = 0;
	for (const name of await readdir(from)) {
		if (!name.endsWith(".jsonl")) continue;
		const fromFile = join(from, name);
		const toFile = join(to, name);
		const s = await lstat(fromFile).catch(() => null);
		if (!s?.isFile()) {
			skipped += 1;
			continue;
		}
		const t = await lstat(toFile).catch(() => null);
		if (t?.isFile() && t.mtimeMs >= s.mtimeMs) {
			skipped += 1;
			continue;
		}
		const tmp = `${toFile}.local-pi-sync-tmp`;
		await copyFile(fromFile, tmp);
		await rename(tmp, toFile);
		added += 1;
	}
	return { project, added, skipped };
}

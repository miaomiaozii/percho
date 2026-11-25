import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Without Git, only use the non-repository fallback when no ancestor has a
// .git directory, gitfile or link. Never infer a Git worktree's channel identity.
async function hasGitMarker(cwd: string): Promise<boolean> {
	for (let dir = cwd; ; dir = dirname(dir)) {
		try {
			await lstat(join(dir, ".git"));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (dirname(dir) === dir) return false;
	}
}

/** Resolve the worktree root without inheriting Git's repository overrides. */
export async function resolveChannelProject(cwd: string, boundRoot?: string): Promise<string> {
	const current = await realpath(cwd);
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
	env.LC_ALL = "C";
	let root: string | undefined;
	try {
		const result = await exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: current,
			env,
			shell: false,
			timeout: 5000,
		});
		root = await realpath(result.stdout.trim());
	} catch (error) {
		const failure = error as { code?: unknown; stderr?: unknown; syscall?: unknown };
		const gitMissing = failure.code === "ENOENT" && failure.syscall === "spawn git";
		const notARepository =
			failure.code === 128 &&
			typeof failure.stderr === "string" &&
			(/^fatal: not a git repository(?: \(or any of the parent directories\): \.git)?\s*$/i.test(
				failure.stderr,
			) ||
				/^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\s*$/i.test(
					failure.stderr,
				));
		if (!notARepository && !(gitMissing && !(await hasGitMarker(current)))) throw error;
	}
	if (root) return root;
	if (!boundRoot) return current;
	const bound = await realpath(boundRoot);
	const rel = relative(bound, current);
	if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
		throw new Error("Channel project root does not contain cwd");
	}
	return bound;
}

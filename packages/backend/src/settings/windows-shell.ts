import { statSync } from "node:fs";
import { win32 } from "node:path";
import { getPowerShellConfig, getShellConfig } from "@earendil-works/pi-coding-agent";

function isFile(path: string): boolean {
	try {
		return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
	} catch {
		return false;
	}
}

/** Git for Windows can add only its cmd directory to PATH, not the directory containing bash.exe. */
export function findGitBashOnPath(path = process.env.PATH ?? ""): string | undefined {
	for (const entry of path.split(win32.delimiter)) {
		const dir = win32.normalize(entry.trim().replace(/^"(.*)"$/, "$1"));
		if (!win32.isAbsolute(dir) || win32.basename(dir).toLowerCase() !== "cmd") continue;
		if (!isFile(win32.join(dir, "git.exe"))) continue;
		const bash = win32.join(dir, "..", "bin", "bash.exe");
		if (isFile(bash)) return bash;
	}
	return undefined;
}

interface ShellOptions {
	shellPath?: string;
	modifiers: string[];
}

/** Use PowerShell only when Bash cannot be found and the user didn't select their own tools. */
export function windowsShellOptions(
	platform: NodeJS.Platform,
	shellPath: string | undefined,
	allowFallback: boolean,
	probes = { findBash: getShellConfig, findGitBash: findGitBashOnPath, findPowerShell: getPowerShellConfig },
): ShellOptions {
	if (platform !== "win32" || shellPath) return { modifiers: [] };
	try {
		// The legacy WSL launcher alone doesn't imply an installed distro.
		if (probes.findBash().commandTransport !== "stdin") return { modifiers: [] };
	} catch {
		// Try a Git installation that exposes only git.exe on PATH.
	}
	const gitBash = probes.findGitBash();
	if (gitBash) return { shellPath: gitBash, modifiers: [] };
	if (allowFallback) {
		try {
			probes.findPowerShell();
			return { modifiers: ["-bash", "+powershell"] };
		} catch {
			// Neither shell was found; keep the SDK's default behavior.
		}
	}
	return { modifiers: [] };
}

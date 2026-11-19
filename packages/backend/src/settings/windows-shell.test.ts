import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findGitBashOnPath, windowsShellOptions } from "./windows-shell";

const unavailable = () => {
	throw new Error("shell not found");
};
const bash = () => ({ shell: "bash.exe", args: ["-c"] });
const wslLauncher = () => ({ ...bash(), commandTransport: "stdin" as const });
const powershell = () => ({ shell: "powershell.exe", args: ["-Command"] });

describe("default Windows shell selection", () => {
	it.each([unavailable, wslLauncher])("finds Git Bash even if only git.exe is on PATH", (findBash) => {
		const gitBashPath = "F:\\Program Files\\Git\\bin\\bash.exe";
		const findPowerShell = vi.fn(powershell);
		expect(
			windowsShellOptions("win32", undefined, true, {
				findBash,
				findGitBash: () => gitBashPath,
				findPowerShell,
			}),
		).toEqual({ shellPath: gitBashPath, modifiers: [] });
		expect(findPowerShell).not.toHaveBeenCalled();
	});

	it.each([unavailable, wslLauncher])("only enables PowerShell if no Bash was found", (findBash) => {
		const probes = { findBash, findGitBash: () => undefined, findPowerShell: powershell };
		expect(windowsShellOptions("win32", undefined, true, probes)).toEqual({
			modifiers: ["-bash", "+powershell"],
		});
		// A user-selected tool list is not expanded to include a different shell tool.
		expect(windowsShellOptions("win32", undefined, false, probes)).toEqual({ modifiers: [] });
	});

	it("preserves working Bash, explicit shell paths, and non-Windows defaults", () => {
		const probes = {
			findBash: vi.fn(bash),
			findGitBash: vi.fn(),
			findPowerShell: vi.fn(powershell),
		};
		expect(windowsShellOptions("win32", "custom", true, probes)).toEqual({ modifiers: [] });
		expect(windowsShellOptions("linux", undefined, true, probes)).toEqual({ modifiers: [] });
		expect(probes.findBash).not.toHaveBeenCalled();
		expect(windowsShellOptions("win32", undefined, true, probes)).toEqual({ modifiers: [] });
		expect(probes.findGitBash).not.toHaveBeenCalled();
		expect(probes.findPowerShell).not.toHaveBeenCalled();
	});
});

it.skipIf(process.platform !== "win32")(
	"finds bash.exe next to a Git for Windows cmd directory on PATH",
	() => {
		const root = mkdtempSync(join(tmpdir(), "percho-git-"));
		try {
			const git = join(root, "Git With Spaces");
			const cmd = join(git, "cmd");
			const bin = join(git, "bin");
			mkdirSync(cmd, { recursive: true });
			mkdirSync(bin);
			const bashPath = join(bin, "bash.exe");
			writeFileSync(join(cmd, "git.exe"), "");
			expect(findGitBashOnPath(cmd)).toBeUndefined();
			writeFileSync(bashPath, "");
			expect(findGitBashOnPath(`"${cmd}"`)).toBe(bashPath);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	},
);

import { describe, expect, it, vi } from "vitest";
import { windowsShellModifiers } from "./windows-shell";

const unavailable = () => {
	throw new Error("shell not found");
};
const bash = () => ({ shell: "bash.exe", args: ["-c"] });
const powershell = () => ({ shell: "powershell.exe", args: ["-Command"] });
describe("default Windows shell selection", () => {
	it("falls back to PowerShell when no Bash or only the legacy WSL launcher is found", () => {
		expect(windowsShellModifiers("win32", undefined, unavailable, powershell)).toEqual([
			"-bash",
			"+powershell",
		]);
		expect(
			windowsShellModifiers("win32", undefined, () => ({ ...bash(), commandTransport: "stdin" }), powershell),
		).toEqual(["-bash", "+powershell"]);
	});
	it("preserves working Bash, explicit shell paths, and non-Windows defaults", () => {
		const findPowerShell = vi.fn(powershell);
		expect(windowsShellModifiers("win32", undefined, bash, findPowerShell)).toEqual([]);
		expect(windowsShellModifiers("win32", "custom", unavailable, findPowerShell)).toEqual([]);
		expect(windowsShellModifiers("linux", undefined, unavailable, findPowerShell)).toEqual([]);
		expect(findPowerShell).not.toHaveBeenCalled();
	});
});

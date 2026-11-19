import { getPowerShellConfig, getShellConfig } from "@earendil-works/pi-coding-agent";

/** Keep Bash on systems that have it. The legacy WSL launcher alone doesn't imply an installed distro. */
export function windowsShellModifiers(
	platform: NodeJS.Platform,
	shellPath?: string,
	findBash = getShellConfig,
	findPowerShell = getPowerShellConfig,
): string[] {
	if (platform !== "win32" || shellPath) return [];
	try {
		if (findBash().commandTransport !== "stdin") return [];
	} catch {
		// No Bash available. Use PowerShell if available, without changing saved settings.
	}
	try {
		findPowerShell();
		return ["-bash", "+powershell"];
	} catch {
		return [];
	}
}

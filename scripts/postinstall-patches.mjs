/**
 * postinstall patch runner.
 *
 * Pi packages arrive in two shapes:
 *   - local Pi (default for this fork): installed as `file:vendor/pi/packages/*`
 *     links. Their dist already carries Percho's Pi patches, applied by
 *     scripts/vendor-local-pi.mjs, so patch-package must not apply them again.
 *   - published Pi from npm: patch-package applies patches/@earendil-works+pi-*.
 *
 * Everything else (thinking-orbs, ...) is always patched with patch-package.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const patchDir = join(root, "patches");
const isPiPatch = (name) => name.startsWith("@earendil-works+pi-") && name.endsWith(".patch");

/** True when the installed Pi packages come from the vendored (already patched) tree. */
function piIsVendored() {
	const codingAgent = join(root, "vendor", "pi", "packages", "coding-agent");
	if (!existsSync(join(codingAgent, "package.json"))) return false;
	const linked = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	return existsSync(linked) && existsSync(join(codingAgent, "dist", "core", "agent-session.js"));
}

const all = existsSync(patchDir) ? readdirSync(patchDir).filter((f) => f.endsWith(".patch")) : [];
const vendored = piIsVendored();
const selected = vendored ? all.filter((f) => !isPiPatch(f)) : all;

if (selected.length === 0) {
	console.log("postinstall-patches: nothing to patch");
	process.exit(0);
}

let dir = "patches";
if (selected.length !== all.length) {
	// patch-package resolves --patch-dir relative to the process cwd.
	dir = join("node_modules", ".percho-patch-dir");
	rmSync(join(root, dir), { recursive: true, force: true });
	mkdirSync(join(root, dir), { recursive: true });
	for (const file of selected) cpSync(join(patchDir, file), join(root, dir, file));
	console.log(
		`postinstall-patches: vendored Pi detected, skipping ${all.length - selected.length} Pi patch(es)`,
	);
}

const result = spawnSync(
	process.execPath,
	[join(root, "node_modules", "patch-package", "index.js"), "--patch-dir", dir],
	{
		stdio: "inherit",
		cwd: root,
	},
);
process.exit(result.status ?? 1);

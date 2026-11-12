import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nodePolicy from "../../packages/shared/src/runtime-node-policy.json" with { type: "json" };

export const RUNTIME_NPM_REGISTRY = "https://registry.npmjs.org";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where local Pi lives in this repo, and the npm names it is installed under. */
const PI_VENDOR_DIRS = {
	"@earendil-works/pi-coding-agent": "vendor/pi/packages/coding-agent",
	"@earendil-works/pi-ai": "vendor/pi/packages/ai",
};

/** Vendor link entries (local pi) carry no version/deps in the lock; read the real manifest. */
function vendorManifest(entry) {
	if (!entry?.link || typeof entry.resolved !== "string" || !entry.resolved.startsWith("vendor/pi/packages/"))
		return null;
	return JSON.parse(readFileSync(join(repoRoot, entry.resolved, "package.json"), "utf8"));
}

/** Select exact installed lock entries, without introducing another dependency/version solver. */
export function runtimeBuildLock(lock, version) {
	// Pi arrives in two shapes, and the stage manifest must match the committed lock:
	//   - local Pi (this fork's default): pi is installed as file: links into
	//     vendor/pi/packages; those on-disk manifests already carry Percho's Pi patches
	//     (scripts/vendor-local-pi.mjs), so the stage re-uses the same file: specs and
	//     npm ci materializes real copies of them.
	//   - published Pi from npm: pin the version the lock resolved, and patch-package
	//     applies the Pi patches during the stage install.
	const dependencies = {};
	const devDependencies = { esbuild: "0.25.12" };
	const vendoredPi = {};
	for (const [name, vendorDir] of Object.entries(PI_VENDOR_DIRS)) {
		const alias = lock.packages[`node_modules/${name}`];
		if (alias?.link === true && alias.resolved === vendorDir) {
			dependencies[name] = `file:${vendorDir}`;
			vendoredPi[name] = vendorDir;
			continue;
		}
		if (typeof alias?.version !== "string") {
			throw new Error(
				`Cannot resolve ${name} in the committed lock: neither a vendor link nor a registry version`,
			);
		}
		dependencies[name] = alias.version;
		devDependencies["patch-package"] = "8.0.1";
	}
	const packages = {};
	const production = new Set();
	const locate = (parent, name, optional = false) => {
		let current = parent;
		for (;;) {
			const candidate = posix.join(current, "node_modules", name);
			const entry = lock.packages[candidate];
			if (entry && (!entry.link || vendorManifest(entry))) return candidate;
			if (!current || current === ".") break;
			current = posix.dirname(current);
		}
		if (optional) return null;
		throw new Error(`Runtime dependency missing from committed lock: ${parent} -> ${name}`);
	};
	const visit = (key, runtime) => {
		if (runtime && production.has(key)) return;
		if (!runtime && packages[key]) return;
		const source = lock.packages[key];
		packages[key] = { ...source };
		delete packages[key].devOptional;
		if (runtime) {
			production.add(key);
			delete packages[key].dev;
		} else packages[key].dev = true;
		const manifest = vendorManifest(source) ?? source;
		// Vendor link packages keep nested deps under their vendor path (file: install),
		// so dependency lookup must start there, not at the node_modules alias.
		const searchRoot = source.link ? source.resolved : key;
		for (const name of new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
		])) {
			const optional =
				name in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[name]?.optional;
			const child = locate(searchRoot, name, optional);
			if (child) visit(child, runtime);
		}
	};
	// npm treats file: dependencies as links. Its sync check requires the lock
	// to carry each linked package as a bare {resolved, link} alias plus its
	// own directory entry (the real manifest, minus devDependencies — the
	// stage installs no dev code beyond the explicit build aliases below).
	// Rewrite the entries before the walk so visit() traverses the vendor
	// directories themselves and locks their on-disk manifests' deps.
	for (const key of Object.keys(lock.packages)) {
		const entry = lock.packages[key];
		if (
			!entry?.link ||
			typeof entry.resolved !== "string" ||
			!entry.resolved.startsWith("vendor/pi/packages/")
		)
			continue;
		const dirEntry = lock.packages[entry.resolved];
		if (!dirEntry) {
			throw new Error(`repo lock missing vendor directory entry ${entry.resolved}`);
		}
		const directory = { ...dirEntry };
		delete directory.link;
		delete directory.resolved;
		delete directory.devDependencies;
		lock.packages[entry.resolved] = directory;
		lock.packages[key] = { resolved: entry.resolved, link: true };
	}
	for (const name of Object.keys(dependencies)) {
		const key = locate("", name);
		// The file: alias resolves to a vendor directory whose on-disk manifest
		// drives the install; lock that directory (and its own deps) too.
		const dirKey = lock.packages[key]?.resolved;
		if (typeof dirKey === "string" && dirKey.startsWith("vendor/pi/packages/")) visit(dirKey, true);
		visit(key, true);
	}
	for (const name of Object.keys(devDependencies)) visit(locate("", name), false);
	// Arborist's #resolveLinks crashes when a link alias lacks its directory
	// target in the lock ("reading 'extraneous'"), so every vendor alias in the
	// stage lock — including sibling packages pulled in transitively — needs
	// its directory entry. Sibling deps were already locked while visiting the
	// alias; only the directory entries themselves are missing here.
	for (const entry of Object.values(packages)) {
		if (
			!entry?.link ||
			typeof entry.resolved !== "string" ||
			!entry.resolved.startsWith("vendor/pi/packages/")
		)
			continue;
		if (packages[entry.resolved]) continue;
		const dirEntry = lock.packages[entry.resolved];
		if (!dirEntry) {
			throw new Error(`repo lock missing vendor directory entry ${entry.resolved}`);
		}
		const directory = { ...dirEntry };
		delete directory.link;
		delete directory.resolved;
		delete directory.devDependencies;
		packages[entry.resolved] = directory;
	}
	const vendoredVersions = new Set();
	for (const [name, vendorPath] of Object.entries(vendoredPi)) {
		const entry = packages[`node_modules/${name}`];
		if (entry?.link !== true || entry?.resolved !== vendorPath) {
			throw new Error(`Runtime lock mismatch for ${name}: expected file link to ${vendorPath}`);
		}
		const version = vendorManifest(entry)?.version;
		if (typeof version !== "string") {
			throw new Error(`Runtime lock mismatch for ${name}: vendored manifest has no version`);
		}
		vendoredVersions.add(version);
	}
	if (vendoredVersions.size > 1) {
		throw new Error(`Vendored Pi versions disagree: ${[...vendoredVersions].sort().join(", ")}`);
	}
	const typebox =
		lock.packages["packages/backend/node_modules/typebox"] ?? lock.packages["node_modules/typebox"];
	if (typebox?.version !== "1.3.7" || Object.keys(typebox.dependencies ?? {}).length)
		throw new Error("Backend TypeBox build dependency changed; update the explicit runtime build alias");
	devDependencies["percho-typebox-build"] = "npm:typebox@1.3.7";
	packages["node_modules/percho-typebox-build"] = { ...typebox, name: "typebox", dev: true };
	const semver = lock.packages[locate("packages/shared", "semver")];
	if (Object.keys(semver.dependencies ?? {}).length || Object.keys(semver.optionalDependencies ?? {}).length)
		throw new Error("Shared semver build dependency changed; update the explicit runtime build alias");
	devDependencies["percho-semver-build"] = `npm:semver@${semver.version}`;
	packages["node_modules/percho-semver-build"] = { ...semver, name: "semver", dev: true };
	// The isolated build has no warm checkout cache. Avoid a regional mirror/CDN dependency,
	// while preserving the committed versions and integrity checks (and never mutating that lock).
	const mirror = "https://registry.npmmirror.com/";
	for (const entry of Object.values(packages)) {
		if (entry.resolved?.startsWith(mirror))
			entry.resolved = `${RUNTIME_NPM_REGISTRY}/${entry.resolved.slice(mirror.length)}`;
	}
	const manifest = {
		name: "percho-remote-runtime",
		version,
		private: true,
		type: "module",
		license: "MIT",
		engines: { node: nodePolicy.node },
		dependencies,
		devDependencies,
	};
	return {
		manifest,
		lock: {
			name: manifest.name,
			version,
			lockfileVersion: 3,
			requires: true,
			packages: { "": manifest, ...packages },
		},
	};
}

/** Workspace imports must resolve against the isolated install, never checkout node_modules. */
export function runtimeBuildAliases(repo, stage) {
	return {
		"@percho/shared": join(repo, "packages/shared/src/index.ts"),
		typebox: join(stage, "node_modules/percho-typebox-build"),
		semver: join(stage, "node_modules/percho-semver-build"),
	};
}

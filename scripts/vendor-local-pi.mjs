/**
 * Vendor a local Pi monorepo checkout into `vendor/pi/packages/` and apply
 * Percho's behavioral patches (vendor/pi-patches/) to the vendored dist.
 *
 * Why: Percho's backend depends on APIs that are not (yet) upstream in the
 * published @earendil-works/pi-* packages (compaction request policy, host
 * input leasing, session-operation serialization). For local development
 * against a Pi fork, we vendor the packages instead of relying on npm
 * registry versions, then apply the patches so Percho's own code (and
 * electron-builder packaging) works unchanged.
 *
 * Usage: node scripts/vendor-local-pi.mjs [--pi-src <path>] [--skip-patch]
 *   --pi-src        Path to the Pi monorepo (default: $PERCHO_PI_SRC or
 *                   C:\Users\Administrator\pi-stable-video)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PI_PKG_NAMES = ["ai", "agent", "coding-agent", "codemode", "mcp", "schema", "telemetry", "tui"];

function defaultPiSrc() {
  if (process.env.PERCHO_PI_SRC) return process.env.PERCHO_PI_SRC;
  const cfgPath = join(ROOT, "vendor", "pi-local.json");
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      if (cfg.piSrc) return cfg.piSrc;
    } catch { /* fall through */ }
  }
  return "C:\\Users\\Administrator\\pi-stable-video";
}

function parseArgs(argv) {
  const args = { piSrc: defaultPiSrc(), skipPatch: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pi-src") args.piSrc = argv[++i];
    else if (a === "--skip-patch") args.skipPatch = true;
  }
  return args;
}

// ---------- minimal unified-diff applier (no external `patch` dependency) ----------

function parsePatch(patchText) {
  const lines = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const files = [];
  let current = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("+++ ")) {
      let p = line.slice(4).trim().split("\t")[0];
      if (p.startsWith("a/")) p = p.slice(2);
      else if (p.startsWith("b/")) p = p.slice(2);
      if (current && current.path) files.push(current);
      current = { path: p, hunks: [] };
      i++;
      continue;
    }
    if (line.startsWith("--- ")) { i++; continue; }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m || !current) throw new Error(`Bad hunk header: ${line}`);
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("+++") && !lines[i].startsWith("--- ")) {
        const raw = lines[i];
        if (raw.startsWith("+")) body.push({ t: "add", x: raw.slice(1) });
        else if (raw.startsWith("-")) body.push({ t: "del", x: raw.slice(1) });
        else if (raw.startsWith(" ")) body.push({ t: "ctx", x: raw.slice(1) });
        else if (raw === "") break; // trailing blank line ends the body
        i++;
      }
      current.hunks.push({ oldStart: Number(m[1]), body });
      continue;
    }
    i++;
  }
  if (current && current.path) files.push(current);
  return files;
}

/** Strict old-side match of a hunk body at `pos`; returns old-side length or null. */
function matchOldSide(src, pos, body) {
  let p = pos;
  let oldLen = 0;
  for (const e of body) {
    if (e.t === "add") continue;
    if (p >= src.length || src[p] !== e.x) return null;
    p++;
    oldLen++;
  }
  return oldLen;
}

function applyHunk(src, hunk, label, filePath) {
  const base = hunk.baseStart - 1;
  const newSide = hunk.body.filter((e) => e.t !== "del").map((e) => e.x); // ctx + add, in order
  for (let off = -25; off <= 25; off++) {
    const pos = base + off;
    if (pos < 0) continue;
    const oldLen = matchOldSide(src, pos, hunk.body);
    if (oldLen === null) continue;
    src.splice(pos, oldLen, ...newSide);
    return { pos, oldLen, addLen: newSide.length };
  }
  throw new Error(`${label}: hunk at line ${hunk.oldStart} did not apply in ${filePath}`);
}

function applyUnifiedDiff(baseDir, patchText, label) {
  const files = parsePatch(patchText);
  for (const f of files) {
    const target = join(baseDir, f.path);
    if (!existsSync(target)) throw new Error(`${label}: target file missing: ${f.path}`);
    const src = readFileSync(target, "utf8").split("\n");
    let shift = 0;
    for (const hunk of f.hunks) {
      hunk.baseStart = hunk.oldStart + shift;
      const res = applyHunk(src, hunk, label, f.path);
      shift += res.addLen - res.oldLen + (res.pos - (hunk.baseStart - 1));
    }
    writeFileSync(target, src.join("\n"), "utf8");
  }
  console.log(`  [${label}] ${files.length} file(s) patched`);
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv);
  const vendorDir = join(ROOT, "vendor", "pi", "packages");
  const patchDir = join(ROOT, "vendor", "pi-patches");

  if (!existsSync(join(args.piSrc, "packages"))) {
    // CI / clean checkout: the patched vendor tree is committed to the repo,
    // and no local Pi source exists to re-vendor from. Use it as-is.
    const complete = PI_PKG_NAMES.every((name) => existsSync(join(vendorDir, name, "dist")));
    if (complete) {
      console.log(`Pi source not found at ${args.piSrc}; using committed vendor tree (vendor/pi/packages).`);
      return;
    }
    console.error(
      `Pi source not found at: ${args.piSrc} (and no committed vendor tree is complete). ` +
        `Pass --pi-src <path> or set PERCHO_PI_SRC.`,
    );
    process.exit(1);
  }
  console.log(`Vendoring Pi packages from ${args.piSrc}`);

  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  for (const name of PI_PKG_NAMES) {
    const srcDir = join(args.piSrc, "packages", name);
    if (!existsSync(srcDir)) {
      console.error(`  missing package in Pi source: packages/${name}`);
      process.exit(1);
    }
    const pkgJson = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
    const destDir = join(vendorDir, name);
    rmSync(destDir, { recursive: true, force: true });
    // Copy only the published surface (mirrors the npm tarball `files` list)
    // so the vendored tree stays small for electron-builder; dev artifacts
    // (src/, test/, node_modules/, tsconfigs, scripts/, install-lock) are dropped.
    const keepDirs = ["dist", "docs", "examples", "schemas"];
    const keepFiles = ["package.json", "README.md", "CHANGELOG.md", "containerization.md"];
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir)) {
      const from = join(srcDir, entry);
      if (keepDirs.includes(entry) && statSync(from).isDirectory()) {
        cpSync(from, join(destDir, entry), { recursive: true, filter: (s) => !s.endsWith(".map") });
      } else if (keepFiles.includes(entry)) {
        cpSync(from, join(destDir, entry));
      }
    }
    console.log(`  ${pkgJson.name} ${pkgJson.version} -> vendor/pi/packages/${name}`);
  }

  if (args.skipPatch) {
    console.log("Skipping patch application (--skip-patch)");
    return;
  }

  if (!existsSync(patchDir)) {
    console.error(`Patch directory missing: ${patchDir}`);
    process.exit(1);
  }

  // Apply patches into a scratch node_modules layout so paths match the
  // patch files (node_modules/@earendil-works/<pkg>/...).
  const scratch = join(ROOT, "vendor", "pi", ".patch-scratch");
  rmSync(scratch, { recursive: true, force: true });
  const nm = join(scratch, "node_modules", "@earendil-works");
  mkdirSync(nm, { recursive: true });
  const pkgDirName = { "coding-agent": "pi-coding-agent", "agent": "pi-agent-core" };
  for (const name of Object.keys(pkgDirName)) {
    cpSync(join(vendorDir, name), join(nm, pkgDirName[name]), { recursive: true });
  }
  for (const file of ["@earendil-works+pi-coding-agent+1.5.0.patch", "@earendil-works+pi-agent-core+1.5.0.patch"]) {
    const p = join(patchDir, file);
    if (!existsSync(p)) continue;
    applyUnifiedDiff(scratch, readFileSync(p, "utf8"), file.replace(/\.patch$/, ""));
  }
  // Copy patched dist back into the vendored packages.
  for (const [name, dirName] of Object.entries(pkgDirName)) {
    cpSync(join(nm, dirName, "dist"), join(vendorDir, name, "dist"), { recursive: true });
  }
  rmSync(scratch, { recursive: true, force: true });
  console.log("Vendor ready: vendor/pi/packages (patched)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

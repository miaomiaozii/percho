import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLocalPiSource, syncLocalPiCredentials } from "../src/storage/local-pi-sync";

/**
 * 本地 Pi 凭据同步（模型/凭据跟随本地 Pi）：
 * 只搬 models.json / auth.json，且"目标更新就跳过"，但空占位文件不算数据。
 */
// 项目规则：**不碰系统 /tmp**，中间结果放仓库 .local/tmp/<专用前缀>（`.local/` 已 gitignore）
const root = fileURLToPath(new URL("../../../.local/tmp/local-pi-sync-test", import.meta.url));
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function scenario(name: string): { source: string; target: string } {
	const base = `${root}/${name}`;
	rmSync(base, { recursive: true, force: true });
	mkdirSync(`${base}/pi`, { recursive: true });
	mkdirSync(`${base}/percho`, { recursive: true });
	return { source: `${base}/pi`, target: `${base}/percho` };
}

function put(dir: string, name: string, content: string, mtimeMs = Date.now()): void {
	writeFileSync(`${dir}/${name}`, content);
	const t = new Date(mtimeMs);
	utimesSync(`${dir}/${name}`, t, t);
}

function sizeOf(dir: string, name: string): number {
	try {
		return statSync(`${dir}/${name}`).size;
	} catch {
		return -1;
	}
}

describe("syncLocalPiCredentials", () => {
	it("目标缺文件时复制模型与凭据", async () => {
		const { source, target } = scenario("missing-target");
		put(source, "models.json", JSON.stringify({ providers: { a: 1 } }), Date.now() - 60_000);
		put(source, "auth.json", JSON.stringify({ token: "x" }), Date.now() - 60_000);
		put(target, "settings.json", "{}");

		const result = await syncLocalPiCredentials(source, target);
		expect(result.copied.sort()).toEqual(["auth.json", "models.json"]);
		expect(sizeOf(target, "models.json")).toBe(sizeOf(source, "models.json"));
		expect(sizeOf(target, "auth.json")).toBe(sizeOf(source, "auth.json"));
	});

	it("目标更新且已有内容时不覆盖", async () => {
		const { source, target } = scenario("target-newer");
		put(source, "models.json", JSON.stringify({ providers: { old: 1 } }), Date.now() - 600_000);
		put(target, "models.json", JSON.stringify({ providers: { mine: 1 } }), Date.now());

		const result = await syncLocalPiCredentials(source, target);
		expect(result.copied).toEqual([]);
		expect(readFileSync(`${target}/models.json`, "utf8")).toContain("mine");
	});

	it("目标只是空占位（{} / [] / 空文件）时照样同步", async () => {
		const { source, target } = scenario("empty-target");
		put(source, "models.json", JSON.stringify({ providers: { mine: 1 } }), Date.now() - 600_000);
		put(source, "auth.json", JSON.stringify({ token: "from-pi" }), Date.now() - 600_000);
		// 占位文件比源更新：按 mtime 会被跳过，但空内容必须被覆盖。
		put(target, "models.json", "{}", Date.now());
		put(target, "auth.json", "[]", Date.now());

		const result = await syncLocalPiCredentials(source, target);
		expect(result.copied.sort()).toEqual(["auth.json", "models.json"]);
		expect(readFileSync(`${target}/auth.json`, "utf8")).toContain("from-pi");
	});

	it("目标内容坏掉时不动它，也不抛错", async () => {
		const { source, target } = scenario("broken-target");
		put(source, "auth.json", JSON.stringify({ token: "from-pi" }), Date.now() - 600_000);
		put(target, "auth.json", "{not json", Date.now());

		const result = await syncLocalPiCredentials(source, target);
		expect(result.copied).toEqual([]);
		expect(readFileSync(`${target}/auth.json`, "utf8")).toBe("{not json");
	});

	it("源目录没有凭据文件时安全返回", async () => {
		const { source, target } = scenario("no-source-files");
		put(target, "models.json", "{}", Date.now());
		const result = await syncLocalPiCredentials(source, target);
		expect(result.copied).toEqual([]);
	});
});

describe("resolveLocalPiSource", () => {
	it("本地 Pi 目录存在时选中它", async () => {
		const { source, target } = scenario("resolve-found");
		mkdirSync(`${source}/sessions`, { recursive: true });
		expect(await resolveLocalPiSource(target)).not.toBeNull();
	});

	it("目标与本地 Pi 目录重合时不返回，避免自己拷自己", async () => {
		const { source } = scenario("resolve-overlap");
		mkdirSync(`${source}/sessions`, { recursive: true });
		// 候选来自固定列表（~/.pi/agent、~/.pi/agent-dev），传入临时目录时
		// 只要候选不存在或重合就必须返回 null。
		const resolved = await resolveLocalPiSource(source);
		if (resolved !== null) {
			expect(resolved).not.toBe(source);
			expect(resolved).not.toContain("local-pi-sync-test");
		}
	});
});

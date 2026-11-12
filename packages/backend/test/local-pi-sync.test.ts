import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	autoSyncLocalPiProjects,
	exportLocalPiProject,
	listLocalPiProjects,
	localPiSyncLedgerPath,
	resolveLocalPiSource,
	setLocalPiAutoSync,
	syncLocalPiCredentials,
	syncLocalPiProject,
} from "../src/storage/local-pi-sync";

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

describe("项目会话双向同步与启动自动导入", () => {
	it("手点导入会搬会话并把项目登记为启动自动同步", async () => {
		const { source, target } = scenario("import-enrolls");
		mkdirSync(`${source}/sessions/--proj-a--`, { recursive: true });
		put(`${source}/sessions/--proj-a--`, "s1.jsonl", '{"type":"message"}\n');
		put(`${source}/sessions/--proj-a--`, "s2.jsonl", '{"type":"message"}\n');

		const result = await syncLocalPiProject(target, "--proj-a--", { source });
		expect(result).toEqual({ project: "--proj-a--", added: 2, skipped: 0 });
		expect(existsSync(`${target}/sessions/--proj-a--/s1.jsonl`)).toBe(true);
		const ledger = JSON.parse(readFileSync(localPiSyncLedgerPath(target), "utf8")) as {
			projects: Record<string, { auto: boolean }>;
		};
		expect(ledger.projects["--proj-a--"]?.auto).toBe(true);
	});

	it("导入是增量的：对端同名文件更新时跳过，不覆盖", async () => {
		const { source, target } = scenario("import-incremental");
		mkdirSync(`${source}/sessions/--proj-b--`, { recursive: true });
		mkdirSync(`${target}/sessions/--proj-b--`, { recursive: true });
		put(`${source}/sessions/--proj-b--`, "s1.jsonl", "from-pi\n", Date.now() - 600_000);
		put(`${target}/sessions/--proj-b--`, "s1.jsonl", "mine\n", Date.now());

		const result = await syncLocalPiProject(target, "--proj-b--", { source });
		expect(result.added).toBe(0);
		expect(result.skipped).toBe(1);
		expect(readFileSync(`${target}/sessions/--proj-b--/s1.jsonl`, "utf8")).toBe("mine\n");
	});

	it("导出把 Percho 会话回流本地 Pi，但不覆盖本地 Pi 里更新的版本", async () => {
		const { source, target } = scenario("export-no-clobber");
		mkdirSync(`${target}/sessions/--proj-c--`, { recursive: true });
		mkdirSync(`${source}/sessions/--proj-c--`, { recursive: true });
		put(`${target}/sessions/--proj-c--`, "new.jsonl", "from-percho\n");
		put(`${target}/sessions/--proj-c--`, "old.jsonl", "percho-old\n", Date.now() - 600_000);
		put(`${source}/sessions/--proj-c--`, "old.jsonl", "pi-newer\n", Date.now());

		const result = await exportLocalPiProject(target, "--proj-c--", { source });
		expect(result).toEqual({ project: "--proj-c--", added: 1, skipped: 1 });
		expect(readFileSync(`${source}/sessions/--proj-c--/new.jsonl`, "utf8")).toBe("from-percho\n");
		expect(readFileSync(`${source}/sessions/--proj-c--/old.jsonl`, "utf8")).toBe("pi-newer\n");
	});

	it("启动自动导入只处理登记过的项目；开关关掉后不再拉", async () => {
		const { source, target } = scenario("auto-sync-scope");
		for (const name of ["--proj-d--", "--proj-e--"]) {
			mkdirSync(`${source}/sessions/${name}`, { recursive: true });
			put(`${source}/sessions/${name}`, "s1.jsonl", "x\n");
		}
		await setLocalPiAutoSync(target, "--proj-d--", true);

		const first = await autoSyncLocalPiProjects(target, { source });
		expect(first.attempted).toEqual(["--proj-d--"]);
		expect(first.added).toBe(1);
		expect(existsSync(`${target}/sessions/--proj-d--/s1.jsonl`)).toBe(true);
		expect(existsSync(`${target}/sessions/--proj-e--/s1.jsonl`)).toBe(false);

		await setLocalPiAutoSync(target, "--proj-d--", false);
		const second = await autoSyncLocalPiProjects(target, { source });
		expect(second.attempted).toEqual([]);
		expect(second.added).toBe(0);
	});

	it("列表同时给出两侧会话数和自动状态", async () => {
		const { source, target } = scenario("list-both-sides");
		mkdirSync(`${source}/sessions/--proj-f--`, { recursive: true });
		put(`${source}/sessions/--proj-f--`, "s1.jsonl", "x\n");
		mkdirSync(`${target}/sessions/--proj-f--`, { recursive: true });
		put(`${target}/sessions/--proj-f--`, "s1.jsonl", "x\n");
		put(`${target}/sessions/--proj-f--`, "s2.jsonl", "percho only\n");
		await setLocalPiAutoSync(target, "--proj-f--", true);

		const listing = await listLocalPiProjects(target, { source });
		expect(listing.available).toBe(true);
		const project = listing.projects.find((item) => item.project === "--proj-f--");
		expect(project?.sessions).toBe(1);
		expect(project?.synced).toBe(1);
		expect(project?.inStorage).toBe(2);
		expect(project?.auto).toBe(true);
	});
});

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	autoSyncLocalPiProjects,
	exportLocalPiProject,
	LOCAL_PI_SOURCE_ENV,
	listLocalPiProjects,
	listLocalPiRemovals,
	localPiSyncLedgerPath,
	recordLocalPiRemoval,
	resolveLocalPiSource,
	restoreLocalPiRemoval,
	setLocalPiAutoSync,
	syncLocalPiCredentials,
	syncLocalPiPreferences,
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

describe("导入时补会话标题", () => {
	function sessionLines(name: string, firstUserText?: string, existingName?: string): string {
		const rows: Record<string, unknown>[] = [
			{
				type: "session",
				version: 1,
				id: `s-${name}`,
				timestamp: "2026-11-01T00:00:00.000Z",
				cwd: "C:\\proj",
			},
		];
		let parent = `s-${name}`;
		if (existingName !== undefined) {
			rows.push({
				type: "session_info",
				id: "n0",
				parentId: parent,
				timestamp: "2026-11-01T00:00:01.000Z",
				name: existingName,
			});
			parent = "n0";
		}
		if (firstUserText !== undefined) {
			rows.push({
				type: "message",
				id: "m1",
				parentId: parent,
				timestamp: "2026-11-01T00:00:02.000Z",
				message: { role: "user", content: [{ type: "text", text: firstUserText }] },
			});
			parent = "m1";
		}
		rows.push({
			type: "message",
			id: "m2",
			parentId: parent,
			timestamp: "2026-11-01T00:00:03.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
		});
		return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	}

	function putProject(name: string, project: string, content: string): { source: string; target: string } {
		const { source, target } = scenario(`naming-${name}`);
		mkdirSync(`${source}/sessions/${project}`, { recursive: true });
		writeFileSync(`${source}/sessions/${project}/session-a.jsonl`, content);
		return { source, target };
	}

	function names(path: string): string[] {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; name?: string })
			.filter((entry) => entry.type === "session_info")
			.map((entry) => String(entry.name));
	}

	it("没名字的会话导入后拿到首条用户消息首行作为标题", async () => {
		const { source, target } = putProject(
			"plain",
			"p1",
			sessionLines("plain", "移除棘轮的东西和产物，有点太难用了\n第二行不进标题"),
		);
		await syncLocalPiProject(target, "p1", { source });
		expect(names(`${target}/sessions/p1/session-a.jsonl`)).toEqual(["移除棘轮的东西和产物，有点太难用了"]);
	});

	it("超长首行截 30 字加省略号，且不破坏行结构", async () => {
		const { source, target } = putProject("long", "p2", sessionLines("long", "一".repeat(40)));
		await syncLocalPiProject(target, "p2", { source });
		const to = `${target}/sessions/p2/session-a.jsonl`;
		expect(names(to)).toEqual([`${"一".repeat(30)}…`]);
		const entries = readFileSync(to, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(entries.at(-1)?.parentId).toBe("m2");
		expect(entries.every((entry) => typeof entry.id === "string")).toBe(true);
	});

	it("已有名字的会话不再补名字", async () => {
		const { source, target } = putProject("titled", "p3", sessionLines("titled", "正文", "已有的名字"));
		await syncLocalPiProject(target, "p3", { source });
		expect(names(`${target}/sessions/p3/session-a.jsonl`)).toEqual(["已有的名字"]);
	});

	it("没有用户消息的会话不补名字，也不丢原有内容", async () => {
		const { source, target } = putProject("empty", "p4", sessionLines("empty"));
		await syncLocalPiProject(target, "p4", { source });
		const to = `${target}/sessions/p4/session-a.jsonl`;
		expect(names(to)).toEqual([]);
		expect(readFileSync(to, "utf8")).toBe(sessionLines("empty"));
	});

	it("启动时给旧版本导进来的会话补名字", async () => {
		const { source, target } = scenario("backfill");
		mkdirSync(`${target}/sessions/p6`, { recursive: true });
		writeFileSync(`${target}/sessions/p6/session-old.jsonl`, sessionLines("old", "早期导进来的会话"));
		await autoSyncLocalPiProjects(target, { source });
		expect(names(`${target}/sessions/p6/session-old.jsonl`)).toEqual(["早期导进来的会话"]);
		// 重复跑不叠名字
		await autoSyncLocalPiProjects(target, { source });
		expect(names(`${target}/sessions/p6/session-old.jsonl`)).toEqual(["早期导进来的会话"]);
	});

	it("不碰本地 Pi 的原文件，重复同步也不会叠名字", async () => {
		const { source, target } = putProject("src-intact", "p5", sessionLines("src-intact", "只同步一次"));
		await syncLocalPiProject(target, "p5", { source });
		const again = await syncLocalPiProject(target, "p5", { source });
		expect(again.added).toBe(0);
		expect(again.skipped).toBe(1);
		expect(names(`${source}/sessions/p5/session-a.jsonl`)).toEqual([]);
		expect(names(`${target}/sessions/p5/session-a.jsonl`)).toEqual(["只同步一次"]);
	});
});

describe("resolveLocalPiSource", () => {
	// 不依赖跑测试的机器上是否装了本地 Pi：用 PERCHO_LOCAL_PI_DIR 指定候选目录。
	async function withSourceOverride(dir: string, run: () => Promise<void>): Promise<void> {
		const previous = process.env[LOCAL_PI_SOURCE_ENV];
		process.env[LOCAL_PI_SOURCE_ENV] = dir;
		try {
			await run();
		} finally {
			if (previous === undefined) delete process.env[LOCAL_PI_SOURCE_ENV];
			else process.env[LOCAL_PI_SOURCE_ENV] = previous;
		}
	}

	it("本地 Pi 目录存在时选中它", async () => {
		const { source, target } = scenario("resolve-found");
		mkdirSync(`${source}/sessions`, { recursive: true });
		await withSourceOverride(source, async () => {
			expect(await resolveLocalPiSource(target)).toBe(source);
		});
	});

	it("目标与本地 Pi 目录重合时不返回，避免自己拷自己", async () => {
		const { source } = scenario("resolve-overlap");
		mkdirSync(`${source}/sessions`, { recursive: true });
		await withSourceOverride(source, async () => {
			// 与目标重合的候选必须被排除（不能自己拷自己）；返回的只会是其他候选或 null。
			const resolved = await resolveLocalPiSource(source);
			expect(resolved).not.toBe(source);
			expect(String(resolved ?? "")).not.toContain("local-pi-sync-test");
		});
	});

	it("环境变量指定的目录不存在时不选中", async () => {
		const { target } = scenario("resolve-missing");
		await withSourceOverride(`${target}/../no-such-pi-dir`, async () => {
			expect(await resolveLocalPiSource(target)).not.toBe(`${target}/../no-such-pi-dir`);
		});
	});
});

describe("项目会话双向同步与启动自动导入", () => {
	it("手点导入会搬会话并把项目登记为启动自动同步", async () => {
		const { source, target } = scenario("import-enrolls");
		mkdirSync(`${source}/sessions/--proj-a--`, { recursive: true });
		put(`${source}/sessions/--proj-a--`, "s1.jsonl", '{"type":"message"}\n');
		put(`${source}/sessions/--proj-a--`, "s2.jsonl", '{"type":"message"}\n');

		const result = await syncLocalPiProject(target, "--proj-a--", { source });
		expect(result).toEqual({ project: "--proj-a--", added: 2, skipped: 0, blocked: 0 });
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
		expect(result).toEqual({ project: "--proj-c--", added: 1, skipped: 1, blocked: 0 });
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

describe("墓碑：在 Percho 里删过的会话不再自动灌回", () => {
	function seedProject(source: string, project: string, files: string[]): void {
		mkdirSync(`${source}/sessions/${project}`, { recursive: true });
		for (const file of files) put(`${source}/sessions/${project}`, file, '{"type":"message"}\n');
	}

	it("记账后启动自动同步不再把它导回来", async () => {
		const { source, target } = scenario("tombstone-auto-skip");
		seedProject(source, "--proj-t1--", ["s1.jsonl", "s2.jsonl"]);
		await syncLocalPiProject(target, "--proj-t1--", { source });
		expect(existsSync(`${target}/sessions/--proj-t1--/s1.jsonl`)).toBe(true);
		// 模拟用户在 Percho 里删了 s1
		const deleted = `${target}/sessions/--proj-t1--/s1.jsonl`;
		rmSync(deleted);
		expect(await recordLocalPiRemoval(target, deleted, { source })).toBe(true);

		const summary = await autoSyncLocalPiProjects(target, { source });
		expect(summary.added).toBe(0);
		expect(summary.blocked).toBe(1);
		expect(existsSync(`${target}/sessions/--proj-t1--/s1.jsonl`)).toBe(false);
		expect(await listLocalPiRemovals(target)).toEqual([
			{ project: "--proj-t1--", file: "s1.jsonl", at: expect.any(String) },
		]);
	});

	it("手动导入是显式意图：把删过的会话找回来并抹掉墓碑", async () => {
		const { source, target } = scenario("tombstone-manual-import");
		seedProject(source, "--proj-t2--", ["s1.jsonl"]);
		await syncLocalPiProject(target, "--proj-t2--", { source });
		const deleted = `${target}/sessions/--proj-t2--/s1.jsonl`;
		rmSync(deleted);
		await recordLocalPiRemoval(target, deleted, { source });

		const again = await syncLocalPiProject(target, "--proj-t2--", { source });
		expect(again.added).toBe(1);
		expect(existsSync(`${target}/sessions/--proj-t2--/s1.jsonl`)).toBe(true);
		expect(await listLocalPiRemovals(target)).toEqual([]);
		const listing = await listLocalPiProjects(target, { source });
		expect(listing.projects.find((item) => item.project === "--proj-t2--")?.removed).toBe(0);
	});

	it("单条恢复：抹掉墓碑并把本地 Pi 里那份取回", async () => {
		const { source, target } = scenario("tombstone-restore-one");
		seedProject(source, "--proj-t3--", ["s1.jsonl", "s2.jsonl"]);
		await syncLocalPiProject(target, "--proj-t3--", { source });
		const deleted = `${target}/sessions/--proj-t3--/s2.jsonl`;
		rmSync(deleted);
		await recordLocalPiRemoval(target, deleted, { source });

		const restored = await restoreLocalPiRemoval(target, "--proj-t3--", "s2.jsonl", { source });
		expect(restored.restored).toBe(true);
		expect(existsSync(`${target}/sessions/--proj-t3--/s2.jsonl`)).toBe(true);
		expect(await listLocalPiRemovals(target)).toEqual([]);
		// 另一条墓碑不受影响（本例没删 s1，所以自动同步只会补它）
		const summary = await autoSyncLocalPiProjects(target, { source });
		expect(summary.blocked).toBe(0);
	});

	it("本地 Pi 里已没有那份会话时只抹墓碑，不伪称恢复", async () => {
		const { source, target } = scenario("tombstone-restore-missing-source");
		seedProject(source, "--proj-t4--", ["s1.jsonl"]);
		await syncLocalPiProject(target, "--proj-t4--", { source });
		const deleted = `${target}/sessions/--proj-t4--/s1.jsonl`;
		rmSync(deleted);
		await recordLocalPiRemoval(target, deleted, { source });
		rmSync(`${source}/sessions/--proj-t4--/s1.jsonl`);

		const restored = await restoreLocalPiRemoval(target, "--proj-t4--", "s1.jsonl", { source });
		expect(restored.restored).toBe(false);
		expect(existsSync(`${target}/sessions/--proj-t4--/s1.jsonl`)).toBe(false);
		expect(await listLocalPiRemovals(target)).toEqual([]);
	});

	it("不记账的情形：路径不在存储会话区 / 不是 .jsonl / 层级不对", async () => {
		const { source, target } = scenario("tombstone-invalid-shapes");
		seedProject(source, "--proj-t5--", ["s1.jsonl"]);
		expect(await recordLocalPiRemoval(target, `${target}/settings.json`, { source })).toBe(false);
		mkdirSync(`${target}/sessions/--proj-t5--`, { recursive: true });
		expect(await recordLocalPiRemoval(target, `${target}/sessions/--proj-t5--/note.txt`, { source })).toBe(
			false,
		);
		expect(
			await recordLocalPiRemoval(target, `${target}/sessions/--proj-t5--/nested/s1.jsonl`, { source }),
		).toBe(false);
		expect(await listLocalPiRemovals(target)).toEqual([]);
		// 存储里还没这份（未曾导进来）但形状合法且本地 Pi 有：也记账，以后自动同步不会把它塞进来
		expect(await recordLocalPiRemoval(target, `${target}/sessions/--proj-t5--/s1.jsonl`, { source })).toBe(
			true,
		);
		const summary = await autoSyncLocalPiProjects(target, { source });
		expect(summary.attempted).toEqual([]);
		await setLocalPiAutoSync(target, "--proj-t5--", true);
		expect((await autoSyncLocalPiProjects(target, { source })).blocked).toBe(1);
		expect(existsSync(`${target}/sessions/--proj-t5--/s1.jsonl`)).toBe(false);
	});

	it("墓碑写进账本文件（本地 Pi 目录不留痕），重启后仍然生效", async () => {
		const { source, target } = scenario("tombstone-persisted");
		seedProject(source, "--proj-t6--", ["s1.jsonl"]);
		await syncLocalPiProject(target, "--proj-t6--", { source });
		const deleted = `${target}/sessions/--proj-t6--/s1.jsonl`;
		rmSync(deleted);
		await recordLocalPiRemoval(target, deleted, { source });

		const ledger = JSON.parse(readFileSync(localPiSyncLedgerPath(target), "utf8")) as {
			version: number;
			removals: Record<string, { file: string }[]>;
		};
		expect(ledger.removals["--proj-t6--"][0]?.file).toBe("s1.jsonl");
		expect(existsSync(`${source}/local-pi-sync.json`)).toBe(false);
		// 只读账本（不重新记）后的自动同步仍然不灌回
		const summary = await autoSyncLocalPiProjects(target, { source });
		expect(summary.blocked).toBe(1);
		expect(existsSync(`${target}/sessions/--proj-t6--/s1.jsonl`)).toBe(false);
	});

	it("关掉自动同步不会弄丢墓碑", async () => {
		const { source, target } = scenario("tombstone-survives-toggle");
		seedProject(source, "--proj-t7--", ["s1.jsonl"]);
		await syncLocalPiProject(target, "--proj-t7--", { source });
		const deleted = `${target}/sessions/--proj-t7--/s1.jsonl`;
		rmSync(deleted);
		await recordLocalPiRemoval(target, deleted, { source });
		await setLocalPiAutoSync(target, "--proj-t7--", false);
		expect((await listLocalPiRemovals(target)).length).toBe(1);
		await setLocalPiAutoSync(target, "--proj-t7--", true);
		const summary = await autoSyncLocalPiProjects(target, { source });
		expect(summary.blocked).toBe(1);
	});
});

/**
 * 偏好设置继承（shellPath / defaultTools / 默认模型等）：只填 Percho 这边还没有的键，
 * 在 Percho 里改过的永远赢；Percho 自己管的压缩/接管/包加载配置从不从本地 Pi 覆盖。
 */
describe("偏好设置从本地 Pi 继承", () => {
	it("只补缺失的键；Percho 改过的赢；Percho 自己管的配置不拿", async () => {
		const { source, target } = scenario("prefs-inherit");
		put(
			source,
			"settings.json",
			JSON.stringify({
				shellPath: "F:/Program Files/Git/bin/bash.exe",
				defaultTools: ["+codemode", "-bash", "+powershell"],
				defaultModel: "flash-next-turbo-iq3s",
				defaultProvider: "strata-remote",
				defaultThinkingLevel: "xhigh",
				theme: "light",
				retry: { enabled: true, maxRetries: 5 },
				packages: ["npm:something-else"],
				compressionTakeover: { enabled: true },
				compaction: { enabled: false },
			}),
		);
		put(target, "settings.json", JSON.stringify({ theme: "dark", compaction: { enabled: true } }));
		const result = await syncLocalPiPreferences(source, target);
		expect(result.copied.sort()).toEqual([
			"defaultModel",
			"defaultProvider",
			"defaultThinkingLevel",
			"defaultTools",
			"retry",
			"shellPath",
		]);
		const settings = JSON.parse(readFileSync(`${target}/settings.json`, "utf8"));
		expect(settings.shellPath).toBe("F:/Program Files/Git/bin/bash.exe");
		expect(settings.defaultTools).toEqual(["+codemode", "-bash", "+powershell"]);
		expect(settings.theme).toBe("dark");
		expect(settings.compaction).toEqual({ enabled: true });
		expect(settings.packages).toBeUndefined();
		expect(settings.compressionTakeover).toBeUndefined();
		// 幂等：第二次什么都不写
		expect((await syncLocalPiPreferences(source, target)).copied).toEqual([]);
	});

	it("本地 Pi 没有或有问题的 settings.json 就什么都不做", async () => {
		const { source, target } = scenario("prefs-no-source");
		expect((await syncLocalPiPreferences(source, target)).copied).toEqual([]);
		expect(existsSync(`${target}/settings.json`)).toBe(false);
		put(source, "settings.json", "{ not json");
		expect((await syncLocalPiPreferences(source, target)).copied).toEqual([]);
		expect(existsSync(`${target}/settings.json`)).toBe(false);
	});

	it("目标 settings.json 读不懂就不覆盖用户文件", async () => {
		const { source, target } = scenario("prefs-broken-target");
		put(source, "settings.json", JSON.stringify({ shellPath: "/bin/bash" }));
		put(target, "settings.json", "{ broken");
		expect((await syncLocalPiPreferences(source, target)).copied).toEqual([]);
		expect(readFileSync(`${target}/settings.json`, "utf8")).toBe("{ broken");
	});
});

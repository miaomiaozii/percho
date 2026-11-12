// @vitest-environment happy-dom
import type { EnvironmentRef, LocalPiSyncProject } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalPiSyncPanel } from "./LocalPiSyncPanel";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	sync: vi.fn(),
	export: vi.fn(),
	setAuto: vi.fn(),
	listRemovals: vi.fn(),
	restore: vi.fn(),
	environment: { kind: "local" } as EnvironmentRef,
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../environment-context", () => ({
	useEnvironment: () => mocks.environment,
}));
vi.mock("../../environment-api", () => ({
	getExecutionApi: () => ({
		listLocalPiProjects: mocks.list,
		syncLocalPiProject: mocks.sync,
		exportLocalPiProject: mocks.export,
		setLocalPiAutoSync: mocks.setAuto,
		listLocalPiRemovals: mocks.listRemovals,
		restoreLocalPiRemoval: mocks.restore,
	}),
}));
vi.mock("../../stores/projects", () => ({
	useProjectsStore: (selector: (state: object) => unknown) =>
		selector({ addedProjects: ["C:\\Users\\Administrator"] }),
}));

const project: LocalPiSyncProject = {
	project: "--C--Users-Administrator--",
	sessions: 3,
	synced: 2,
	inStorage: 1,
	auto: false,
	removed: 0,
	newestMtime: "2026-11-10T00:00:00.000Z",
};

const listed = { source: "C:\\Users\\Administrator\\.pi\\agent", available: true } as const;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	mocks.list.mockReset();
	mocks.sync.mockReset();
	mocks.export.mockReset();
	mocks.setAuto.mockReset();
	mocks.listRemovals.mockReset();
	mocks.listRemovals.mockResolvedValue([]);
	mocks.restore.mockReset();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	root.unmount();
	container.remove();
});

async function render() {
	await act(async () => {
		root.render(<LocalPiSyncPanel />);
	});
	// Let the initial listLocalPiProjects round-trip settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

function buttonWith(text: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll("button")].find((button) => button.textContent === text);
}

it("lists local Pi projects with unsynced deltas and syncs per project", async () => {
	mocks.list
		.mockResolvedValueOnce({ ...listed, projects: [project] })
		.mockResolvedValue({ ...listed, projects: [{ ...project, synced: 3 }] });
	mocks.sync.mockResolvedValue({ project: project.project, added: 1, skipped: 0 });
	await render();
	expect(container.textContent).toContain("piSync.title");
	expect(container.textContent).toContain("piSync.new");
	expect(container.textContent).toContain("piSync.inStorage");
	const button = buttonWith("piSync.sync");
	expect(button).toBeTruthy();
	await act(async () => {
		button!.click();
	});
	expect(mocks.sync).toHaveBeenCalledWith({ project: project.project });
	expect(container.textContent).toContain("piSync.done");
	// Refreshed list shows everything synced: no "new" badge, no sync button.
	expect(mocks.list).toHaveBeenCalledTimes(2);
});

it("exports Percho sessions back to the local Pi on demand", async () => {
	mocks.list.mockResolvedValue({ ...listed, projects: [project] });
	mocks.export.mockResolvedValue({ project: project.project, added: 1, skipped: 0 });
	await render();
	const button = buttonWith("piSync.export");
	expect(button).toBeTruthy();
	await act(async () => {
		button!.click();
	});
	expect(mocks.export).toHaveBeenCalledWith({ project: project.project });
	expect(container.textContent).toContain("piSync.exported");
});

it("shows and toggles the startup auto-import switch", async () => {
	mocks.list
		.mockResolvedValueOnce({ ...listed, projects: [project] })
		.mockResolvedValue({ ...listed, projects: [{ ...project, auto: true }] });
	mocks.setAuto.mockResolvedValue({ project: project.project, auto: true });
	await render();
	expect(buttonWith("piSync.autoOff")).toBeTruthy();
	await act(async () => {
		buttonWith("piSync.autoOff")!.click();
	});
	expect(mocks.setAuto).toHaveBeenCalledWith({ project: project.project, auto: true });
	// Refreshed list reports the project as enrolled.
	expect(buttonWith("piSync.autoOn")).toBeTruthy();
});

it("shows the no-source hint when the local Pi directory is missing", async () => {
	mocks.list.mockResolvedValue({ source: null, available: false, projects: [] });
	await render();
	expect(container.textContent).toContain("piSync.noSource");
	expect(container.querySelectorAll("button").length).toBe(0);
});

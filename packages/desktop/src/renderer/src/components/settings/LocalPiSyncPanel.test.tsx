// @vitest-environment happy-dom
import type { EnvironmentRef, LocalPiSyncProject } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalPiSyncPanel } from "./LocalPiSyncPanel";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	sync: vi.fn(),
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
	newestMtime: "2026-11-10T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	mocks.list.mockReset();
	mocks.sync.mockReset();
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

it("lists local Pi projects with unsynced deltas and syncs per project", async () => {
	const result = { source: "C:\\Users\\Administrator\\.pi\\agent", available: true } as const;
	mocks.list
		.mockResolvedValueOnce({ ...result, projects: [project] })
		.mockResolvedValue({ ...result, projects: [{ ...project, synced: 3 }] });
	mocks.sync.mockResolvedValue({ project: project.project, added: 1, skipped: 0 });
	await render();
	expect(container.textContent).toContain("piSync.title");
	expect(container.textContent).toContain("piSync.new");
	const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "piSync.sync");
	expect(button).toBeTruthy();
	await act(async () => {
		button!.click();
	});
	expect(mocks.sync).toHaveBeenCalledWith({ project: project.project });
	expect(container.textContent).toContain("piSync.done");
	// Refreshed list shows everything synced: no "new" badge, no sync button.
	expect(mocks.list).toHaveBeenCalledTimes(2);
});

it("shows the no-source hint when the local Pi directory is missing", async () => {
	mocks.list.mockResolvedValue({ source: null, available: false, projects: [] });
	await render();
	expect(container.textContent).toContain("piSync.noSource");
	expect(container.querySelectorAll("button").length).toBe(0);
});

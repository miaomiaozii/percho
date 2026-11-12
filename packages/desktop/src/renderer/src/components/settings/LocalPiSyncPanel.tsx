import { encodePiSessionDir, type LocalPiSyncProject } from "@percho/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { useEnvironment } from "../../environment-context";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { FolderIcon } from "../icons";
import { Button } from "../ui/Button";

interface RowState {
	syncing: boolean;
	added: number | null;
}

/** 本地 Pi 同步面板：模型/凭据启动时自动跟随，会话按项目手动同步。 */
export function LocalPiSyncPanel() {
	const t = useT();
	const environment = useEnvironment();
	const addedProjects = useProjectsStore((state) => state.addedProjects);
	const [source, setSource] = useState<string | null>(null);
	const [available, setAvailable] = useState(false);
	const [projects, setProjects] = useState<LocalPiSyncProject[]>([]);
	const [rows, setRows] = useState<Record<string, RowState>>({});

	const isLocal = environment.kind === "local";

	const refresh = useCallback(async () => {
		const result = await getExecutionApi(environment).listLocalPiProjects();
		setSource(result.source);
		setAvailable(result.available);
		setProjects(result.projects);
	}, [environment]);

	useEffect(() => {
		if (!isLocal) {
			setAvailable(false);
			setProjects([]);
			return;
		}
		refresh().catch(() => setAvailable(false));
	}, [isLocal, refresh]);

	const displayName = useCallback(
		(name: string) => addedProjects.find((cwd) => encodePiSessionDir(cwd) === name) ?? null,
		[addedProjects],
	);

	const sync = useCallback(
		async (names: string[]) => {
			setRows((prev) => ({
				...prev,
				...Object.fromEntries(names.map((name) => [name, { syncing: true, added: null }])),
			}));
			const api = getExecutionApi(environment);
			for (const name of names) {
				try {
					const result = await api.syncLocalPiProject({ project: name });
					setRows((prev) => ({ ...prev, [name]: { syncing: false, added: result.added } }));
				} catch {
					setRows((prev) => ({ ...prev, [name]: { syncing: false, added: null } }));
				}
			}
			await refresh().catch(() => undefined);
		},
		[environment, refresh],
	);

	const pending = useMemo(() => projects.filter((project) => project.synced < project.sessions), [projects]);
	const anySyncing = Object.values(rows).some((row) => row.syncing);

	return (
		<section aria-label={t("piSync.title")} className="flex flex-col gap-3 text-ui-13">
			<header className="flex flex-col gap-1">
				<h2 className="font-medium text-ink">{t("piSync.title")}</h2>
				<p className="text-ink-dim">{t("piSync.description")}</p>
				<p className="text-ink-faint">{t("piSync.modelsAuto")}</p>
			</header>
			{!isLocal ? (
				<p className="text-ink-faint">{t("piSync.remoteNote")}</p>
			) : !available ? (
				<p className="text-ink-faint">{t("piSync.noSource")}</p>
			) : projects.length === 0 ? (
				<p className="text-ink-faint">{t("piSync.empty")}</p>
			) : (
				<>
					<div className="flex items-center justify-between gap-2 py-2">
						<span className="min-w-0 flex-1 truncate text-ink-faint" title={source ?? undefined}>
							{source}
						</span>
						{pending.length > 0 && (
							<Button
								size="sm"
								disabled={anySyncing}
								onClick={() => void sync(pending.map((project) => project.project))}
							>
								{anySyncing ? t("piSync.syncing") : t("piSync.syncAll", { count: pending.length })}
							</Button>
						)}
					</div>
					<ul className="flex flex-col gap-2">
						{projects.map((project) => {
							const row = rows[project.project];
							const cwd = displayName(project.project);
							const added = project.synced < project.sessions ? project.sessions - project.synced : 0;
							return (
								<li key={project.project} className="flex min-w-0 items-center gap-2 rounded-lg p-1">
									<span
										className="min-w-0 flex-1 truncate font-medium text-ink"
										title={cwd ?? project.project}
									>
										<FolderIcon size={13} className="mr-1 inline shrink-0 text-ink-faint" />
										{cwd ?? project.project}
									</span>
									<span className="shrink-0 text-ink-faint">
										{t("piSync.sessions", { count: project.sessions })}
									</span>
									{added > 0 && (
										<span className="shrink-0 rounded-lg bg-hover px-2 py-1 text-ink-dim">
											{t("piSync.new", { count: added })}
										</span>
									)}
									{row?.syncing ? (
										<span className="shrink-0 text-ink-dim">{t("piSync.syncing")}</span>
									) : row?.added ? (
										<span className="shrink-0 text-ink-dim">{t("piSync.done", { count: row.added })}</span>
									) : null}
									{added > 0 && (
										<Button size="sm" disabled={anySyncing} onClick={() => void sync([project.project])}>
											{t("piSync.sync")}
										</Button>
									)}
								</li>
							);
						})}
					</ul>
				</>
			)}
		</section>
	);
}

import { encodePiSessionDir, type LocalPiRemoval, type LocalPiSyncProject } from "@percho/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { useEnvironment } from "../../environment-context";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { FolderIcon } from "../icons";
import { Button } from "../ui/Button";

interface RowState {
	busy: boolean;
	imported: number | null;
	exported: number | null;
}

const IDLE: RowState = { busy: false, imported: null, exported: null };

/** 本地 Pi 同步面板：模型/凭据自动跟随；会话按项目导入或导出，手点过的启动时自动增量导入。 */
export function LocalPiSyncPanel() {
	const t = useT();
	const environment = useEnvironment();
	const addedProjects = useProjectsStore((state) => state.addedProjects);
	const [source, setSource] = useState<string | null>(null);
	const [available, setAvailable] = useState(false);
	const [projects, setProjects] = useState<LocalPiSyncProject[]>([]);
	const [rows, setRows] = useState<Record<string, RowState>>({});
	const [removals, setRemovals] = useState<LocalPiRemoval[]>([]);
	const [showRemovals, setShowRemovals] = useState(false);
	const [restoring, setRestoring] = useState<string | null>(null);

	const isLocal = environment.kind === "local";

	const refresh = useCallback(async () => {
		const api = getExecutionApi(environment);
		const [result, removalList] = await Promise.all([api.listLocalPiProjects(), api.listLocalPiRemovals()]);
		setSource(result.source);
		setAvailable(result.available);
		setProjects(result.projects);
		setRemovals(removalList);
	}, [environment]);

	useEffect(() => {
		if (!isLocal) {
			setAvailable(false);
			setProjects([]);
			setRemovals([]);
			return;
		}
		refresh().catch(() => setAvailable(false));
	}, [isLocal, refresh]);

	const displayName = useCallback(
		(name: string) => addedProjects.find((cwd) => encodePiSessionDir(cwd) === name) ?? null,
		[addedProjects],
	);

	const importProject = useCallback(
		async (names: string[]) => {
			setRows((prev) => ({
				...prev,
				...Object.fromEntries(names.map((name) => [name, { ...(prev[name] ?? IDLE), busy: true }])),
			}));
			const api = getExecutionApi(environment);
			for (const name of names) {
				try {
					const result = await api.syncLocalPiProject({ project: name });
					setRows((prev) => ({
						...prev,
						[name]: { busy: false, imported: result.added, exported: prev[name]?.exported ?? null },
					}));
				} catch {
					setRows((prev) => ({ ...prev, [name]: { ...IDLE } }));
				}
			}
			await refresh().catch(() => undefined);
		},
		[environment, refresh],
	);

	const exportProject = useCallback(
		async (name: string) => {
			setRows((prev) => ({ ...prev, [name]: { ...(prev[name] ?? IDLE), busy: true } }));
			const api = getExecutionApi(environment);
			try {
				const result = await api.exportLocalPiProject({ project: name });
				setRows((prev) => ({
					...prev,
					[name]: { busy: false, imported: prev[name]?.imported ?? null, exported: result.added },
				}));
			} catch {
				setRows((prev) => ({ ...prev, [name]: { ...IDLE } }));
			}
			await refresh().catch(() => undefined);
		},
		[environment, refresh],
	);

	const toggleAuto = useCallback(
		async (name: string, auto: boolean) => {
			setRows((prev) => ({ ...prev, [name]: { ...(prev[name] ?? IDLE), busy: true } }));
			const api = getExecutionApi(environment);
			try {
				await api.setLocalPiAutoSync({ project: name, auto });
			} catch {
				// 开关失败时下一次刷新会回到真实状态
			}
			await refresh().catch(() => undefined);
		},
		[environment, refresh],
	);

	const pending = useMemo(() => projects.filter((project) => project.synced < project.sessions), [projects]);
	const autoCount = useMemo(() => projects.filter((project) => project.auto).length, [projects]);
	const anyBusy = Object.values(rows).some((row) => row.busy);

	const restore = useCallback(
		async (removal: LocalPiRemoval) => {
			setRestoring(`${removal.project}/${removal.file}`);
			const api = getExecutionApi(environment);
			try {
				await api.restoreLocalPiRemoval({ project: removal.project, file: removal.file });
			} catch {
				// 失败时下面的刷新会回到真实状态
			}
			setRestoring(null);
			await refresh().catch(() => undefined);
		},
		[environment, refresh],
	);

	return (
		<section aria-label={t("piSync.title")} className="flex flex-col gap-3 text-ui-13">
			<header className="flex flex-col gap-1">
				<h2 className="font-medium text-ink">{t("piSync.title")}</h2>
				<p className="text-ink-dim">{t("piSync.description")}</p>
				<p className="text-ink-faint">{t("piSync.modelsAuto")}</p>
				<p className="text-ink-faint">{t("piSync.safetyNote")}</p>
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
								disabled={anyBusy}
								onClick={() => void importProject(pending.map((project) => project.project))}
							>
								{anyBusy ? t("piSync.syncing") : t("piSync.syncAll", { count: pending.length })}
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
									<span className="shrink-0 text-ink-faint">
										{t("piSync.inStorage", { count: project.inStorage })}
									</span>
									{added > 0 && (
										<span className="shrink-0 rounded-lg bg-hover px-2 py-1 text-ink-dim">
											{t("piSync.new", { count: added })}
										</span>
									)}
									{project.removed > 0 && (
										<span
											className="shrink-0 rounded-lg bg-hover px-2 py-1 text-ink-dim"
											title={t("piSync.removedHint")}
										>
											{t("piSync.removedCount", { count: project.removed })}
										</span>
									)}
									{row?.busy ? (
										<span className="shrink-0 text-ink-dim">{t("piSync.syncing")}</span>
									) : row?.imported ? (
										<span className="shrink-0 text-ink-dim">{t("piSync.done", { count: row.imported })}</span>
									) : row?.exported ? (
										<span className="shrink-0 text-ink-dim">
											{t("piSync.exported", { count: row.exported })}
										</span>
									) : null}
									{added > 0 && (
										<Button
											size="sm"
											disabled={anyBusy}
											onClick={() => void importProject([project.project])}
										>
											{t("piSync.sync")}
										</Button>
									)}
									{project.inStorage > 0 && (
										<Button size="sm" disabled={anyBusy} onClick={() => void exportProject(project.project)}>
											{t("piSync.export")}
										</Button>
									)}
									<Button
										size="sm"
										disabled={anyBusy}
										onClick={() => void toggleAuto(project.project, !project.auto)}
									>
										{project.auto ? t("piSync.autoOn") : t("piSync.autoOff")}
									</Button>
								</li>
							);
						})}
					</ul>
					<p className="text-ink-faint">{t("piSync.autoNote", { count: autoCount })}</p>
					{removals.length > 0 && (
						<div className="flex flex-col gap-2">
							<Button size="sm" onClick={() => setShowRemovals((value) => !value)}>
								{t("piSync.removedTitle", { count: removals.length })}
							</Button>
							{showRemovals && (
								<ul className="flex flex-col gap-1">
									{removals.map((removal) => {
										const key = `${removal.project}/${removal.file}`;
										const cwd = displayName(removal.project);
										return (
											<li key={key} className="flex min-w-0 items-center gap-2 rounded-lg p-1">
												<span
													className="min-w-0 flex-1 truncate text-ink-dim"
													title={`${cwd ?? removal.project} · ${removal.file}`}
												>
													{cwd ?? removal.project}
													<span className="ml-1 text-ink-faint">{removal.file.replace(/\.jsonl$/, "")}</span>
												</span>
												<span className="shrink-0 text-ink-faint">{removal.at.slice(0, 10)}</span>
												<Button size="sm" disabled={restoring !== null} onClick={() => void restore(removal)}>
													{restoring === key ? t("piSync.restoring") : t("piSync.restore")}
												</Button>
											</li>
										);
									})}
								</ul>
							)}
							<p className="text-ink-faint">{t("piSync.removedNote")}</p>
						</div>
					)}
				</>
			)}
		</section>
	);
}

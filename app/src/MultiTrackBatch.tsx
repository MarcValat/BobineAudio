import { useEffect, useState } from "react";
import { startSegmentedRenderJob, startSegmentsJob, type SegmentsResponse, type TrackInfo } from "./api";
import { runJob } from "./jobs";
import { prefetchNow } from "./prefetch";
import { ExportNames, exportTitle, useExportOptions } from "./exportOptions";
import { ALL_TRACKS, defaultPick, keyName, matchesAny, matchesKey, trackOptions, TrackFilterPicker, type TrackKey } from "./TrackFilter";
import {
  AnalyzeButton,
  BatchFooter,
  SubtitleModeField,
  nextStep,
  IDLE_EXPORT,
  rowState,
  useExportQueue,
  dropBlockedReason,
  type AnalysisRun,
  type ExportFields,
} from "./batchShared";
import { InfoTip } from "./InfoTip";
import {
  EmptyWorkspace,
  trackName,
  Issues,
  ListRow,
  FoldButton,
  ModeCards,
  RemoveAllButton,
  useListKeys,
  MoveButtons,
  runBadge,
  useProbes,
  type BadgeKind,
  type BatchMode,
} from "./Workspace";
import {
  DetailChart,
  DetailExport,
  DetailHeader,
  DetailTabs,
  RetimedSubs,
  SubtitleChoiceDialog,
  TracksHeading,
  useDetailView,
} from "./Detail";
import { LogPanel } from "./LogPanel";
import { describeSegments } from "./SegmentChart";
import { preloadWaveforms, TrackPreview } from "./TrackPreview";
import { DropZone } from "./DropZone";
import { pickMediaFiles } from "./mediaDialog";
import { DropOverlay, useFileDrop } from "./FileDrop";
import { basename } from "./paths";
import { SegmentEditor } from "./SegmentEditor";
import { assignSubtitles, subtitlesFor } from "./subtitles";
import { devParam, errorMessage, toggled } from "./util";
import { TrackTable } from "./TrackTable";
import { t, useT } from "./i18n";
import { WarningIcon } from "./icons";
import { useListCollapsed, useSubtitleMode } from "./settings";

/** A file's tracks ticked by hand in its detail's tracks table (and its
 * subtitles in "Changer"), instead of the top bar's pick. */
interface TrackChoice {
  reference: number;
  targets: number[];
  /** The subtitle tracks retimed with each corrected track (by its index),
   * picked by hand too; absent: per the subtitle setting. */
  subtitles?: Record<number, number[]>;
}

/** Which of a file's tracks is the reference and which get corrected, and
 * what was off when picking them by language (shown as ⚠). */
interface Resolution {
  reference: TrackInfo | null;
  targets: TrackInfo[];
  issues: string[];
  manual: boolean;
  /** The reference picked at the top names none of its tracks, or several:
   * the 1st track is the reference, every other one to correct ("(auto)"). */
  auto: boolean;
}

/** One file's analyses (one per corrected track) and its single export. Kept
 * with the reference they were made against: a different one since makes
 * them stale. */
interface FileRun extends ExportFields {
  referenceIndex: number;
  targets: Record<number, AnalysisRun>;
}

/** A file's tracks as the top bar picks them (by number, language or
 * name, see TrackFilter), or as ticked in its detail (`choice`). A
 * reference naming none of its tracks, or several, doesn't block it: its
 * first track (or first match) is the reference, and every other track is
 * to correct when the reference matched none ("(auto)"). A track to correct
 * that a ticked entry should name but can't is flagged (⚠). */
function resolve(tracks: TrackInfo[], referenceKey: TrackKey, targetKeys: TrackKey[], choice?: TrackChoice): Resolution {
  if (choice) {
    return {
      reference: tracks.find((t) => t.index === choice.reference) ?? null,
      targets: tracks.filter((t) => choice.targets.includes(t.index)),
      issues: [],
      manual: true,
      auto: false,
    };
  }
  const matches = referenceKey ? tracks.filter((t) => matchesKey(t, referenceKey)) : [];
  const reference = matches[0] ?? tracks[0] ?? null;
  if (matches.length === 0) {
    return { reference, targets: tracks.filter((t) => t !== reference), issues: [], manual: false, auto: true };
  }
  const others = tracks.filter((t) => t !== reference);
  const issues = targetKeys
    .filter((key) => key !== ALL_TRACKS && !others.some((t) => matchesKey(t, key)))
    .map((key) => t().multi.noTrack(keyName(key)));
  return { reference, targets: others.filter((t) => matchesAny(t, targetKeys)), issues, manual: false, auto: matches.length > 1 };
}

/** "Fichiers multipistes": one file or a series of files that each hold
 * both the reference and the track(s) to correct. Tracks are picked for
 * every file (by number, language or name, see TrackFilter), which survives
 * a track order that changes from one episode to the next; a file where
 * that's ambiguous or missing is flagged, and its tracks can be ticked by hand in its detail.
 * Each file's export holds all its corrected tracks. */
export function MultiTrackBatch({
  hidden,
  onModeChange,
  outputDir,
  onOutputDirChange,
  blocked,
  onBusyChange,
}: {
  hidden: boolean;
  /** Switches to pairs mode, from the empty workspace's cards. */
  onModeChange?: (mode: BatchMode) => void;
  outputDir: string | null;
  onOutputDirChange: (dir: string | null) => void;
  /** The other batch mode is working: nothing starts here meanwhile. */
  blocked: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const m = useT();
  const [files, setFiles] = useState<string[]>([]);
  // What the top bar picks in every file (see TrackFilter): the reference,
  // and the tracks to correct (any track one of these names).
  const [referenceKey, setReferenceKey] = useState<TrackKey>("");
  const [targetKeys, setTargetKeys] = useState<TrackKey[]>([]);
  const [choices, setChoices] = useState<Record<string, TrackChoice>>({});
  // Starts as the default setting (Options), and follows it when it changes.
  const [subsMode, setSubsMode] = useSubtitleMode();
  const [runs, setRuns] = useState<Record<string, FileRun>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const queue = useExportQueue(outputDir);
  // The file whose retimed subtitles are being changed ("Changer").
  const [subsEditing, setSubsEditing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; track: number } | null>(null);
  // The file shown in the detail, and which of each file's corrected tracks
  // its tabs show (absent: its first).
  const [selected, setSelected] = useState<string | null>(null);
  const [shownTracks, setShownTracks] = useState<Record<string, number>>({});
  const view = useDetailView();
  const collapsed = useListCollapsed();
  // How corrected tracks are exported (codec, names), and the names typed
  // in a file's detail for its own tracks (by "path|track index").
  const exportOptions = useExportOptions();
  const [titleOverrides, setTitleOverrides] = useState<Record<string, string>>({});
  const busy = analyzing || queue.exporting;
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  /** Adds files not in the list yet (checked against the list as it really
   * is, not a possibly stale copy: adding the same files twice in a row
   * must not list them twice). */
  function addPaths(paths: string[]) {
    setFiles((current) => [...current, ...[...new Set(paths)].filter((p) => !current.includes(p))]);
  }

  const dropBlocked = dropBlockedReason(busy, blocked);
  const fileDrag = useFileDrop(!hidden && subsEditing === null && editing === null, dropBlocked, addPaths);

  // Each file's tracks are read once, as soon as it's listed.
  const probes = useProbes(files);

  // A file is always shown while the list has some: the first one listed,
  // or the next one up when the shown one is removed.
  useEffect(() => {
    if (selected !== null && files.includes(selected)) return;
    setSelected(files[0] ?? null);
  }, [files, selected]);

  useListKeys(!hidden, files.length, selected === null ? -1 : files.indexOf(selected), (i) => setSelected(files[i]));

  // Dev only (see devParam): `?batchFiles=a|b` adds files.
  useEffect(() => {
    const list = devParam("batchFiles");
    if (list) addPaths(list.split("|"));
  }, []);

  // The picks start out from the first probed file (see defaultPick). Only
  // while none is set, so a pick of the user's is never overridden.
  const firstTracks = files.map((f) => probes[f]?.tracks).find((t) => t && t.length > 0);
  useEffect(() => {
    if (referenceKey || !firstTracks) return;
    const pick = defaultPick(firstTracks);
    setReferenceKey(pick.reference);
    setTargetKeys(pick.targets);
  }, [firstTracks, referenceKey]);

  const options = trackOptions(files.flatMap((f) => (probes[f]?.tracks ? [probes[f].tracks!] : [])));
  const resolutions: Record<string, Resolution | null> = Object.fromEntries(
    files.map((f) => {
      const tracks = probes[f]?.tracks;
      return [f, tracks ? resolve(tracks, referenceKey, targetKeys, choices[f]) : null];
    }),
  );

  /** The subtitle tracks retimed with each of a file's corrected tracks (by
   * track index), per the subtitle setting: one subtitle track goes with
   * one audio track at most. */
  function subsOf(path: string, targets: TrackInfo[]): Record<number, number[]> {
    const subtitles = probes[path]?.subtitles ?? [];
    const picked = choices[path]?.subtitles;
    return assignSubtitles(targets, (t) => picked?.[t.index] ?? subtitlesFor(subtitles, t.language, subsMode));
  }

  /** This file's analyses, if made against its current reference. */
  function runOf(path: string): FileRun | null {
    const run = runs[path];
    const reference = resolutions[path]?.reference;
    return run && reference && run.referenceIndex === reference.index ? run : null;
  }

  function updateRun(path: string, update: (run: FileRun) => FileRun) {
    setRuns((current) => (current[path] ? { ...current, [path]: update(current[path]) } : current));
  }

  function updateTarget(path: string, track: number, patch: Partial<AnalysisRun> | ((t: AnalysisRun) => Partial<AnalysisRun>)) {
    updateRun(path, (run) => {
      const target = run.targets[track];
      const next = typeof patch === "function" ? patch(target) : patch;
      return { ...run, targets: { ...run.targets, [track]: { ...target, ...next } } };
    });
  }

  /** A file's tracks to correct (as picked now) whose analysis against its
   * current reference succeeded -- what its export holds. */
  function doneTargets(path: string): [TrackInfo, AnalysisRun][] {
    const run = runOf(path);
    const res = resolutions[path];
    if (!run || !res) return [];
    return res.targets.flatMap((t) => {
      const target = run.targets[t.index];
      return target?.status === "done" && target.result ? [[t, target] as [TrackInfo, AnalysisRun]] : [];
    });
  }

  /** Analyzes the tracks to correct that aren't yet (new files, new
   * languages, failed ones), keeping the rest and any edit made to them; or
   * all of them again (`all`); of every file, or of `only` (the detail's
   * "Analyser"). */
  async function handleAnalyze(all: boolean, only?: string) {
    await runPlan(
      files.flatMap((path) => {
        if (only !== undefined && path !== only) return [];
        const res = resolutions[path];
        if (!res?.reference || res.targets.length === 0) return [];
        const run = runOf(path);
        const targets = all ? res.targets : res.targets.filter((t) => run?.targets[t.index]?.status !== "done");
        return targets.length > 0 ? [{ path, reference: res.reference, targets, keep: all ? null : run }] : [];
      }),
    );
  }

  /** "Réanalyser" on one corrected track of a file: that one alone again
   * (its edits are lost), the file's others kept. */
  function reanalyzeTrack(path: string, track: TrackInfo) {
    const reference = resolutions[path]?.reference;
    if (reference) runPlan([{ path, reference, targets: [track], keep: runOf(path) }]);
  }

  async function runPlan(plan: { path: string; reference: TrackInfo; targets: TrackInfo[]; keep: FileRun | null }[]) {
    setAnalyzing(true);
    setRuns((current) => {
      const next = { ...current };
      for (const { path, reference, targets, keep } of plan) {
        next[path] = {
          referenceIndex: reference.index,
          targets: {
            ...keep?.targets,
            ...Object.fromEntries(
              targets.map((t) => [t.index, { status: "pending", result: null, error: null, log: [] } satisfies AnalysisRun]),
            ),
          },
          // What it held changes: the last export no longer matches.
          ...IDLE_EXPORT,
        };
      }
      return next;
    });
    for (const { path, reference, targets } of plan) {
      // The file's tracks decoded in one pass first (or what's left of it,
      // if it was being done ahead): each analysis then starts from them.
      await prefetchNow(path, [reference.index, ...targets.map((t) => t.index)]);
      for (const target of targets) {
        updateTarget(path, target.index, { status: "running" });
        try {
          const result = await runJob<SegmentsResponse>(startSegmentsJob(path, reference.index, path, target.index), (message) =>
            updateTarget(path, target.index, (t) => ({ log: [...t.log, message] })),
          );
          updateTarget(path, target.index, { status: "done", result });
          preloadWaveforms(path, reference.index, path, target.index);
        } catch (err) {
          updateTarget(path, target.index, { status: "error", error: errorMessage(err) });
        }
      }
    }
    setAnalyzing(false);
  }

  /** One export per file, holding every corrected track whose analysis
   * succeeded, with its segments as edited ("Modifier"); of every file, or
   * of `only` ("Exporter ce fichier"). */
  function handleExport(only?: string) {
    queue.run(
      files
        .filter((path) => (only === undefined || path === only) && doneTargets(path).length > 0)
        .map((path) => ({
          input: path,
          start: (outputPath: string) => {
            const done = doneTargets(path);
            const subs = subsOf(
              path,
              done.map(([track]) => track),
            );
            return startSegmentedRenderJob(
              path,
              runOf(path)!.referenceIndex,
              done.map(([track, t]) => ({
                trackIndex: track.index,
                segments: t.result!.segments,
                subtitles: subs[track.index] ?? [],
                title: titleOf(path, track),
                codec: exportOptions.codec === "auto" ? null : exportOptions.codec,
              })),
              outputPath,
            );
          },
          update: (patch) => updateRun(path, (r) => ({ ...r, ...patch(r) })),
        })),
    );
  }

  /** A corrected track's name in `path`'s export (undefined: its source's). */
  const titleOf = (path: string, track: TrackInfo, own = true) =>
    exportTitle({
      track,
      language: track.language,
      options: exportOptions,
      override: own ? titleOverrides[`${path}|${track.index}`] : undefined,
    });
  // The tracks to correct's languages (a custom name each), and the first
  // one's automatic name (for the export options to show).
  const targetTracks = files.flatMap((f) => resolutions[f]?.targets ?? []);
  const targetLanguages = [...new Set(targetTracks.map((t) => t.language))];
  const nameExample = targetTracks[0]
    ? (exportTitle({ track: targetTracks[0], language: targetTracks[0].language, options: { ...exportOptions, naming: "auto" } }) ?? null)
    : null;

  // Counted over the tracks to correct as picked now, analyzed or not.
  const allTargets = files.flatMap((f) => resolutions[f]?.targets.map((t) => runOf(f)?.targets[t.index]) ?? []);
  const analyzedCount = allTargets.filter((t) => t?.status === "done").length;
  // Tracks "Analyser" would do: not analyzed yet, or failed.
  const missingCount = files.reduce((n, f) => {
    const res = resolutions[f];
    return res?.reference ? n + res.targets.length - doneTargets(f).length : n;
  }, 0);
  const exportedCount = files.filter((f) => runOf(f)?.exportStatus === "done").length;
  const flaggedCount = files.filter((f) => (resolutions[f]?.issues.length ?? 0) > 0 || probes[f]?.error).length;
  const analyzable = files.some((f) => resolutions[f]?.reference && resolutions[f]!.targets.length > 0);
  // The window's next step: the footer's with several files, the detail's
  // with one.
  const listNext =
    files.length > 1
      ? nextStep({
          analyzing,
          missing: missingCount,
          exportable: files.filter((f) => doneTargets(f).length > 0).length,
          exported: exportedCount,
        })
      : null;

  const editingRun = editing ? runOf(editing.path)?.targets[editing.track] : null;

  /** "@0 jpn → @1 fre + ST @3, @2 eng": a file's tracks as used now. */
  function tracksSummary(path: string, res: Resolution): string {
    const subs = subsOf(path, res.targets);
    const targets = res.targets.map((t) => {
      const retimed = subs[t.index]?.length ? ` + ST ${subs[t.index].map((i) => `@${i}`).join(" ")}` : "";
      return `${trackName(t.index, t)}${retimed}`;
    });
    return `${res.reference ? trackName(res.reference.index, res.reference) : "?"} → ${targets.length > 0 ? targets.join(", ") : m.multi.nothing}`;
  }

  /** A row's badge: what's running first, then what's wrong, then how far it got. */
  function rowBadge(path: string): [string, BadgeKind] {
    const s = m.multi.status;
    const probed = probes[path];
    const res = resolutions[path];
    if (!probed) return [s.reading, "idle"];
    if (probed.error || !res) return [s.unreadable, "error"];
    const run = runOf(path);
    const statuses = res.reference ? res.targets.map((t) => run?.targets[t.index]?.status) : [];
    return (
      runBadge(statuses, run?.exportStatus, { ...s, analyzed: s.analyzed(statuses.length) }) ??
      (res.issues.length > 0 || !res.reference || res.targets.length === 0 ? [s.check, "warning"] : [s.toAnalyze, "idle"])
    );
  }

  // The detail: the selected file, and the corrected track its tabs show.
  const detailPath = selected;
  const detailProbe = detailPath ? probes[detailPath] : undefined;
  const detailRes = detailPath ? resolutions[detailPath] : null;
  const detailRun = detailPath ? runOf(detailPath) : null;
  const shownTrack = detailRes?.targets.find((t) => t.index === shownTracks[detailPath!]) ?? detailRes?.targets[0] ?? null;
  const shownRun = shownTrack ? detailRun?.targets[shownTrack.index] : undefined;
  const shownResult = shownRun?.status === "done" ? shownRun.result : null;
  const detailReference = detailRes?.reference ?? null;
  const detailDone = detailPath ? doneTargets(detailPath).length : 0;
  // Tracks its "Analyser" would do: not analyzed yet, or failed.
  const detailMissing = detailRes?.reference ? detailRes.targets.length - detailDone : 0;
  const detailAnalyzing = !!detailRes?.targets.some((t) => {
    const status = detailRun?.targets[t.index]?.status;
    return status === "pending" || status === "running";
  });

  /** A change to a file's tracks in its detail: from then on they're its
   * own ("(manuel)"), starting from what the languages picked. */
  function editChoice(path: string, update: (choice: TrackChoice) => TrackChoice) {
    const res = resolutions[path];
    const tracks = probes[path]?.tracks;
    if (!res || !tracks || tracks.length === 0) return;
    setChoices((c) => ({
      ...c,
      [path]: update(c[path] ?? { reference: res.reference?.index ?? tracks[0].index, targets: res.targets.map((t) => t.index) }),
    }));
  }

  return (
    <main className="batch-main" style={hidden ? { display: "none" } : undefined}>
      {files.length === 0 ? (
        <EmptyWorkspace title={m.multi.emptyTitle} hint={m.multi.emptyHint}>
          <DropZone
            title={m.files.dropZoneMany}
            disabled={dropBlocked !== null}
            onClick={async () => {
              const picked = await pickMediaFiles(true);
              if (picked) addPaths(picked);
            }}
          >
            {m.multi.empty}
          </DropZone>
          <ModeCards mode="multi" onChange={onModeChange} />
        </EmptyWorkspace>
      ) : (
        <>
          <div className="batch-config panel">
            <span className="config-field">
              {m.multi.reference}
              <TrackFilterPicker
                label={m.common.reference}
                options={options}
                value={referenceKey ? [referenceKey] : []}
                onChange={([key]) => setReferenceKey(key)}
                single
                disabled={busy}
              />
            </span>
            <span className="config-field">
              {m.multi.toCorrect}
              <TrackFilterPicker label={m.common.toCorrect} options={options} value={targetKeys} onChange={setTargetKeys} disabled={busy} />
            </span>
            <SubtitleModeField value={subsMode} onChange={setSubsMode} disabled={busy} />
            <InfoTip>{m.multi.hint}</InfoTip>
          </div>

          <div className={`workspace${collapsed ? " list-collapsed" : ""}`}>
            <section className="panel file-list">
              <div className="file-list-header">
                <h2>{m.multi.filesCount(files.length)}</h2>
                <RemoveAllButton
                  results={Object.values(runs).some((run) => Object.values(run.targets).some((t) => t.status === "done"))}
                  disabled={busy}
                  onRemove={() => {
                    setFiles([]);
                    setChoices({});
                    setRuns({});
                    setShownTracks({});
                    setTitleOverrides({});
                    // Picked again from the next files added.
                    setReferenceKey("");
                    setTargetKeys([]);
                  }}
                />
                <FoldButton collapsed={collapsed} />
              </div>

              <ul className="file-list-rows list-scroll">
                {files.map((path, i) => {
                  const probed = probes[path];
                  const res = resolutions[path];
                  const run = runOf(path);
                  const [badge, badgeKind] = rowBadge(path);
                  return (
                    <ListRow
                      key={path}
                      name={basename(path)}
                      path={path}
                      selected={path === selected}
                      onSelect={() => setSelected(path)}
                      state={rowState(
                        res?.reference ? res.targets.map((t) => run?.targets[t.index]) : [],
                        run?.exportStatus,
                        !!(res?.issues.length || probed?.error),
                      )}
                      badge={badge}
                      badgeKind={badgeKind}
                      detail={
                        <>
                          {!probed && m.multi.readingTracks}
                          {probed?.error && <span className="error">{probed.error}</span>}
                          {res && tracksSummary(path, res)}
                          {res?.manual && <span className="list-row-manual">{m.multi.manual}</span>}
                          {res?.auto && <span className="list-row-manual">{m.multi.auto}</span>}
                          {res && res.issues.length > 0 && <Issues issues={res.issues} />}
                        </>
                      }
                      actions={<MoveButtons count={files.length} index={i} disabled={busy} onChange={(update) => setFiles(update)} />}
                    />
                  );
                })}
              </ul>
              {/* Adding more: a click picks files, or they're dropped on the window. */}
              <button
                className="file-list-add"
                disabled={busy}
                title={m.multi.addHint}
                onClick={async () => {
                  const picked = await pickMediaFiles(true);
                  if (picked) addPaths(picked);
                }}
              >
                <span>{m.multi.addMore}</span>
                <span>{m.multi.dropMore}</span>
              </button>
            </section>

            {detailPath && (
              <section className="panel file-detail">
                <DetailHeader
                  title={basename(detailPath)}
                  titleTooltip={detailPath}
                  meta={
                    detailProbe?.tracks
                      ? m.multi.meta(detailProbe.tracks.length, detailProbe.subtitles.length)
                      : !detailProbe?.error && m.multi.readingTracks
                  }
                  onReanalyze={
                    shownTrack && (shownRun?.status === "done" || shownRun?.status === "error")
                      ? () => reanalyzeTrack(detailPath, shownTrack)
                      : undefined
                  }
                  onEdit={shownTrack && shownResult ? () => setEditing({ path: detailPath, track: shownTrack.index }) : undefined}
                  editDisabled={queue.exporting}
                  missing={detailMissing}
                  analyzing={detailAnalyzing}
                  done={detailDone}
                  exported={detailRun?.exportStatus === "done"}
                  primary={files.length === 1}
                  disabled={busy || blocked}
                  analyzeDisabled={!detailRes?.reference}
                  blockedTitle={blocked ? m.batch.otherModeBusy : undefined}
                  analyzeTitle={m.multi.analyzeFileHint}
                  exportLabel={m.multi.exportFile}
                  onAnalyze={() => handleAnalyze(false, detailPath)}
                  onExport={() => handleExport(detailPath)}
                />

                {detailProbe?.error && <p className="error">{detailProbe.error}</p>}
                {detailRes && detailProbe?.tracks && (
                  <div className="detail-body" ref={view.ref}>
                    {shownTrack && (
                      <DetailTabs
                        tracks={detailRes.targets.map((t) => [String(t.index), trackName(t.index, t)] as const)}
                        value={String(shownTrack.index)}
                        onChange={(index) => setShownTracks((c) => ({ ...c, [detailPath]: Number(index) }))}
                        view={view.compact && shownResult ? { value: view.view, onChange: view.setView } : undefined}
                      />
                    )}

                    <div className={view.topClass(!!shownResult)}>
                      <div className="detail-tracks">
                        <TracksHeading
                          hint={m.multi.tracksHint}
                          auto={detailRes.auto ? m.multi.autoHint : undefined}
                          reset={
                            detailRes.manual
                              ? {
                                  label: m.multi.byLanguage,
                                  title: m.multi.byLanguageHint,
                                  disabled: busy,
                                  onClick: () =>
                                    setChoices((c) => {
                                      const next = { ...c };
                                      delete next[detailPath];
                                      return next;
                                    }),
                                }
                              : undefined
                          }
                        />
                        <div className="tracks-table-wrap list-scroll detail-tracks-table">
                          <TrackTable
                            className="batch-tracks-table"
                            tracks={detailProbe.tracks}
                            radioName={`reference-${detailPath}`}
                            reference={detailRes.reference?.index ?? null}
                            targets={detailRes.targets.map((t) => t.index)}
                            disabled={busy}
                            onReference={(index) =>
                              editChoice(detailPath, (c) => ({ ...c, reference: index, targets: c.targets.filter((i) => i !== index) }))
                            }
                            onToggleTarget={(index) => editChoice(detailPath, (c) => ({ ...c, targets: toggled(c.targets, index) }))}
                          />
                        </div>
                        {detailRes.issues.length > 0 && <Issues issues={detailRes.issues} />}
                        {detailProbe.subtitles.length > 0 && detailRes.targets.length > 0 && (
                          <RetimedSubs
                            subtitles={detailProbe.subtitles}
                            assigned={subsOf(detailPath, detailRes.targets)}
                            disabled={busy}
                            onChange={() => setSubsEditing(detailPath)}
                          />
                        )}
                        {detailRes.targets.length > 0 && (
                          <ExportNames
                            rows={detailRes.targets.map((track) => ({
                              index: track.index,
                              label: trackName(track.index, track),
                              value: titleOverrides[`${detailPath}|${track.index}`] ?? "",
                              shown: titleOf(detailPath, track, false) ?? track.title ?? null,
                            }))}
                            disabled={busy}
                            onChange={(index, value) => setTitleOverrides((c) => ({ ...c, [`${detailPath}|${index}`]: value }))}
                          />
                        )}
                      </div>

                      <DetailChart
                        summary={
                          <>
                            {detailReference && shownTrack && m.multi.againstReference(trackName(detailReference.index, detailReference))}
                            {shownResult && ` · ${describeSegments(shownResult.segments)}`}
                          </>
                        }
                        result={shownResult}
                        run={shownRun}
                        fill={view.compact}
                        noTrack={detailRes.targets.length === 0 ? m.multi.noTarget : null}
                      />
                    </div>

                    {/* Hidden rather than unmounted on the other tab, so playback
                      and zoom survive switching. Not while this track is being
                      edited: the editor has its own preview, and two playing at
                      once would overlap. */}
                    {shownTrack &&
                      shownResult &&
                      detailReference &&
                      !(editing?.path === detailPath && editing.track === shownTrack.index) && (
                        <div className={view.listenClass()}>
                          <TrackPreview
                            active={!hidden}
                            key={`${detailPath}|${shownTrack.index}`}
                            referenceFilePath={detailPath}
                            candidateFilePath={detailPath}
                            referenceIndex={detailRun!.referenceIndex}
                            trackIndex={shownTrack.index}
                            segments={shownResult.segments}
                            referenceStartTime={detailReference.start_time ?? 0}
                            trackStartTime={shownTrack.start_time}
                            extraControls={<LogPanel lines={shownRun?.log ?? []} />}
                          />
                        </div>
                      )}
                  </div>
                )}

                <DetailExport entry={detailRun} />
              </section>
            )}
          </div>

          <BatchFooter
            exportOptions={exportOptions}
            languages={targetLanguages}
            example={nameExample}
            outputDir={outputDir}
            onOutputDirChange={onOutputDirChange}
            busy={busy}
            blocked={blocked}
            progress={
              <>
                {m.multi.progressFiles(files.length)}
                {m.multi.progressAnalyzed(analyzedCount, allTargets.length)}
                {exportedCount > 0 && m.multi.progressExported(exportedCount)}
                {flaggedCount > 0 && (
                  <>
                    {" · "}
                    <WarningIcon /> {m.multi.progressFlagged(flaggedCount)}
                  </>
                )}
              </>
            }
            analyzeButton={
              <AnalyzeButton
                analyzing={analyzing}
                missing={missingCount}
                analyzed={analyzedCount}
                unit="track"
                primary={listNext === "analyze"}
                disabled={!analyzable || busy || blocked}
                blocked={blocked}
                onAnalyze={(all) => handleAnalyze(all)}
              />
            }
            queue={queue}
            canExport={analyzedCount > 0}
            exportNext={listNext === "export"}
            onExport={() => handleExport()}
          />
        </>
      )}

      {subsEditing && resolutions[subsEditing] && (
        <SubtitleChoiceDialog
          title={m.multi.subsOf(basename(subsEditing))}
          titleTooltip={subsEditing}
          tracks={resolutions[subsEditing]!.targets.map((t) => [t.index, trackName(t.index, t)] as const)}
          subtitles={probes[subsEditing]?.subtitles ?? []}
          assigned={subsOf(subsEditing, resolutions[subsEditing]!.targets)}
          onToggle={(track, sub) =>
            editChoice(subsEditing, (c) => ({
              ...c,
              subtitles: { ...c.subtitles, [track]: toggled(subsOf(subsEditing, resolutions[subsEditing]!.targets)[track] ?? [], sub) },
            }))
          }
          onClose={() => setSubsEditing(null)}
        />
      )}

      {editing && editingRun?.result && (
        <SegmentEditor
          segments={editingRun.result.segments}
          subtitle={`${basename(editing.path)} · ${trackName(
            editing.track,
            probes[editing.path]?.tracks?.find((t) => t.index === editing.track),
          )}`}
          onClose={() => setEditing(null)}
          onSave={(edited) =>
            updateTarget(editing.path, editing.track, (t) => ({
              result: t.result ? { ...t.result, segments: edited } : t.result,
            }))
          }
          preview={{
            referenceFilePath: editing.path,
            candidateFilePath: editing.path,
            referenceIndex: runOf(editing.path)!.referenceIndex,
            trackIndex: editing.track,
            referenceStartTime: probes[editing.path]?.tracks?.find((t) => t.index === runOf(editing.path)!.referenceIndex)?.start_time,
            trackStartTime: probes[editing.path]?.tracks?.find((t) => t.index === editing.track)?.start_time,
          }}
        />
      )}
      <DropOverlay drag={fileDrag} blocked={dropBlocked} label={m.files.dropToAdd} hint={m.files.folderHint} />
    </main>
  );
}

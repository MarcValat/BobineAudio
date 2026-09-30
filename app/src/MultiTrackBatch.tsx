import { useEffect, useRef, useState, type ReactNode } from "react";
import { probe, startSegmentedRenderJob, startSegmentsJob, type SegmentsResponse, type SubtitleInfo, type TrackInfo } from "./api";
import { runJob } from "./jobs";
import { languageLabel, LanguageSelect } from "./languages";
import {
  AnalysisStatus,
  AnalyzeButton,
  BatchFooter,
  ExportCell,
  FileCell,
  IDLE_EXPORT,
  RevealButton,
  useExportQueue,
  dropBlockedReason,
  writtenFile,
  type AnalysisRun,
  type ExportFields,
} from "./batchShared";
import { InfoTip } from "./InfoTip";
import { pickMediaFiles } from "./mediaDialog";
import { DropOverlay, useFileDrop } from "./FileDrop";
import { basename } from "./paths";
import { SegmentEditor } from "./SegmentEditor";
import { assignSubtitles, SUBTITLE_MODES, type SubtitleMode, subtitlesFor, takenByOthers } from "./subtitles";
import { devParam, errorMessage, toggled } from "./util";
import { Dialog, DialogHeader } from "./Dialog";
import { TrackTable } from "./TrackTable";
import { SubtitleChecks } from "./SubtitleChecks";
import { t, useT } from "./i18n";

interface FileProbe {
  tracks: TrackInfo[] | null;
  subtitles: SubtitleInfo[];
  error: string | null;
}

/** A file's tracks picked by hand ("Choisir"), instead of by language. */
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
}

/** One file's analyses (one per corrected track) and its single export. Kept
 * with the reference they were made against: a different one since makes
 * them stale. */
interface FileRun extends ExportFields {
  referenceIndex: number;
  targets: Record<number, AnalysisRun>;
}

function resolve(tracks: TrackInfo[], referenceLanguage: string, targetLanguages: string[], choice?: TrackChoice): Resolution {
  if (choice) {
    return {
      reference: tracks.find((t) => t.index === choice.reference) ?? null,
      targets: tracks.filter((t) => choice.targets.includes(t.index)),
      issues: [],
      manual: true,
    };
  }
  const issues: string[] = [];
  const withLanguage = (lang: string) => tracks.filter((t) => t.language === lang);
  const references = withLanguage(referenceLanguage);
  const reference = references[0] ?? null;
  if (references.length === 0) issues.push(t().multi.noTrack(referenceLanguage));
  if (references.length > 1) issues.push(t().multi.severalTracks(referenceLanguage));
  const targets: TrackInfo[] = [];
  for (const lang of targetLanguages) {
    if (lang === referenceLanguage) continue;
    const found = withLanguage(lang).filter((t) => t !== reference);
    if (found.length === 0) issues.push(t().multi.noTrack(lang));
    if (found.length > 1) issues.push(t().multi.severalTracks(lang));
    if (found.length > 0) targets.push(found[0]);
  }
  return { reference, targets, issues, manual: false };
}

/** "Choisir": a file's tracks, to pick its reference and the tracks to
 * correct by hand -- the same table as the single-file view's. */
function TrackChoiceModal({
  path,
  tracks,
  subtitles,
  initial,
  defaultSubtitles,
  onSave,
  onClose,
}: {
  path: string;
  tracks: TrackInfo[];
  subtitles: SubtitleInfo[];
  initial: TrackChoice;
  /** The subtitle setting's pick for a corrected track, for one newly ticked. */
  defaultSubtitles: (track: TrackInfo) => number[];
  onSave: (choice: TrackChoice) => void;
  onClose: () => void;
}) {
  const m = useT();
  const [choice, setChoice] = useState(initial);
  const targetTracks = tracks.filter((t) => choice.targets.includes(t.index));
  const assigned = assignSubtitles(targetTracks, (t) => choice.subtitles?.[t.index] ?? defaultSubtitles(t));
  function toggleSubtitle(track: number, sub: number) {
    setChoice((c) => ({ ...c, subtitles: { ...c.subtitles, [track]: toggled(assigned[track] ?? [], sub) } }));
  }
  return (
    <Dialog onClose={onClose} className="batch-choice-panel" labelledBy="choice-title">
      <DialogHeader id="choice-title" title={m.multi.tracksOf(basename(path))} titleTooltip={path} onClose={onClose} closeLabel={m.common.cancel} />
        <TrackTable
          className="batch-tracks-table"
          tracks={tracks}
          radioName="choice-reference"
          reference={choice.reference}
          targets={choice.targets}
          onReference={(index) => setChoice((c) => ({ ...c, reference: index, targets: c.targets.filter((i) => i !== index) }))}
          onToggleTarget={(index) =>
            setChoice((c) => ({
              ...c,
              targets: toggled(c.targets, index),
            }))
          }
        />
        {subtitles.length > 0 && choice.targets.length > 0 && (
          <div className="batch-choice-subs">
            <h3>
              {m.multi.subsToRetime} <InfoTip>{m.multi.subsToRetimeHint}</InfoTip>
            </h3>
            {targetTracks.map((t) => (
              <div key={t.index} className="batch-choice-subs-row">
                <span className="batch-target-name">{m.multi.withTrack(`@${t.index} ${t.language ?? "?"}`)}</span>
                <SubtitleChecks
                  subtitles={subtitles}
                  chosen={assigned[t.index] ?? []}
                  taken={takenByOthers(assigned, t.index)}
                  onToggle={(sub) => toggleSubtitle(t.index, sub)}
                />
              </div>
            ))}
          </div>
        )}
        <div className="batch-choice-actions">
          <button
            className="primary-button"
            disabled={choice.targets.length === 0}
            onClick={() => {
              onSave(choice);
              onClose();
            }}
          >
            {m.multi.confirm}
          </button>
        </div>
    </Dialog>
  );
}

/** Batch mode's "Fichiers multipistes": a series of files that each hold
 * both the reference and the track(s) to correct -- like the single-file
 * view, for many files at once. Tracks are picked by language (reference
 * language, languages to correct), which survives a track order that
 * changes from one episode to the next; a file where that's ambiguous or
 * missing is flagged, and its tracks can be picked by hand ("Choisir").
 * Each file's export holds all its corrected tracks. */
export function MultiTrackBatch({
  hidden,
  modeSwitch,
  outputDir,
  onOutputDirChange,
  blocked,
  onBusyChange,
}: {
  hidden: boolean;
  modeSwitch: ReactNode;
  outputDir: string | null;
  onOutputDirChange: (dir: string | null) => void;
  /** The other batch mode is working: nothing starts here meanwhile. */
  blocked: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const m = useT();
  const [files, setFiles] = useState<string[]>([]);
  const [probes, setProbes] = useState<Record<string, FileProbe>>({});
  const [referenceLanguage, setReferenceLanguage] = useState("");
  const [targetLanguages, setTargetLanguages] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, TrackChoice>>({});
  const [subsMode, setSubsMode] = useState<SubtitleMode>("forced");
  const [runs, setRuns] = useState<Record<string, FileRun>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const queue = useExportQueue(outputDir);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; track: number } | null>(null);
  const busy = analyzing || queue.exporting;
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  /** Adds files not in the list yet (checked against the list as it really
   * is, not a possibly stale copy: adding the same files twice in a row
   * must not list them twice). */
  function addPaths(paths: string[]) {
    setFiles((current) => [...current, ...[...new Set(paths)].filter((p) => !current.includes(p))]);
  }

  const dropBlocked = dropBlockedReason(busy, blocked);
  const fileDrag = useFileDrop(!hidden && choosing === null && editing === null, dropBlocked, addPaths);

  // Each file's tracks are read once, as soon as it's listed.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const path of files) {
      if (requested.current.has(path)) continue;
      requested.current.add(path);
      probe(path)
        .then((res) =>
          setProbes((p) => ({ ...p, [path]: { tracks: res.tracks, subtitles: res.subtitles ?? [], error: null } })),
        )
        .catch((err) =>
          setProbes((p) => ({
            ...p,
            [path]: { tracks: null, subtitles: [], error: errorMessage(err) },
          })),
        );
    }
  }, [files]);

  // Dev only (see devParam): `?batchFiles=a|b` adds files.
  useEffect(() => {
    const list = devParam("batchFiles");
    if (list) addPaths(list.split("|"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Languages start out as the first probed file's: its first track as the
  // reference, every other language to correct. Only while none is set, so a
  // pick of the user's is never overridden.
  const firstTracks = files.map((f) => probes[f]?.tracks).find((t) => t && t.length > 0);
  useEffect(() => {
    if (referenceLanguage || !firstTracks) return;
    const reference = firstTracks[0].language ?? "";
    if (!reference) return;
    setReferenceLanguage(reference);
    setTargetLanguages([
      ...new Set(firstTracks.map((t) => t.language).filter((l): l is string => !!l && l !== reference)),
    ]);
  }, [firstTracks, referenceLanguage]);

  const languages = [
    ...new Set(
      files.flatMap((f) => probes[f]?.tracks?.map((t) => t.language) ?? []).filter((l): l is string => !!l),
    ),
  ];
  const resolutions: Record<string, Resolution | null> = Object.fromEntries(
    files.map((f) => {
      const tracks = probes[f]?.tracks;
      return [f, tracks ? resolve(tracks, referenceLanguage, targetLanguages, choices[f]) : null];
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
   * all of them again (`all`). */
  async function handleAnalyze(all: boolean) {
    setAnalyzing(true);
    const plan = files.flatMap((path) => {
      const res = resolutions[path];
      if (!res?.reference || res.targets.length === 0) return [];
      const run = runOf(path);
      const targets = all ? res.targets : res.targets.filter((t) => run?.targets[t.index]?.status !== "done");
      return targets.length > 0 ? [{ path, reference: res.reference, targets, keep: all ? null : run }] : [];
    });
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
      for (const target of targets) {
        updateTarget(path, target.index, { status: "running" });
        try {
          const result = await runJob<SegmentsResponse>(
            startSegmentsJob(path, reference.index, path, target.index),
            (message) => updateTarget(path, target.index, (t) => ({ log: [...t.log, message] })),
          );
          updateTarget(path, target.index, { status: "done", result });
        } catch (err) {
          updateTarget(path, target.index, { status: "error", error: errorMessage(err) });
        }
      }
    }
    setAnalyzing(false);
  }

  /** One export per file, holding every corrected track whose analysis
   * succeeded, with its segments as edited ("Modifier"). */
  function handleExportAll() {
    queue.run(
      files
        .filter((path) => doneTargets(path).length > 0)
        .map((path) => ({
          input: path,
          start: (outputPath: string) => {
            const done = doneTargets(path);
            const subs = subsOf(path, done.map(([track]) => track));
            return startSegmentedRenderJob(
              path,
              runOf(path)!.referenceIndex,
              done.map(([track, t]) => ({ trackIndex: track.index, segments: t.result!.segments, subtitles: subs[track.index] ?? [] })),
              outputPath,
            );
          },
          update: (patch) => updateRun(path, (r) => ({ ...r, ...patch(r) })),
        })),
    );
  }

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

  const editingRun = editing ? runOf(editing.path)?.targets[editing.track] : null;
  const choosingTracks = choosing ? probes[choosing]?.tracks : null;
  const choosingRes = choosing ? resolutions[choosing] : null;

  return (
    <main className="batch-main" style={hidden ? { display: "none" } : undefined}>
      <div className="batch-config panel">
        {modeSwitch}
        <label>
          {m.multi.reference}
          <LanguageSelect
            value={referenceLanguage}
            onChange={(lang) => {
              setReferenceLanguage(lang);
              setTargetLanguages((t) => t.filter((l) => l !== lang));
            }}
            extra={languages}
            onlyExtra
            emptyLabel="—"
            disabled={busy}
          />
        </label>
        <span className="batch-languages">
          {m.multi.toCorrect}
          {languages.filter((l) => l !== referenceLanguage).length === 0 && <span className="batch-track-status">—</span>}
          {languages
            .filter((l) => l !== referenceLanguage)
            .map((lang) => (
              <label key={lang}>
                <input
                  type="checkbox"
                  checked={targetLanguages.includes(lang)}
                  disabled={busy}
                  onChange={() =>
                    setTargetLanguages((t) => toggled(t, lang))
                  }
                />
                {languageLabel(lang)}
              </label>
            ))}
        </span>
        <label>
          {m.common.labelled(m.batch.subtitles)}
          <select value={subsMode} onChange={(e) => setSubsMode(e.target.value as SubtitleMode)} disabled={busy}>
            {SUBTITLE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {m.subtitles.modes[mode]}
              </option>
            ))}
          </select>
        </label>
        <InfoTip>{m.multi.hint}</InfoTip>
      </div>

      <section className="panel batch-jobs">
        <div className="batch-jobs-header">
          <h2>{m.multi.files}</h2>
          <button
            className="small-button"
            onClick={() => {
              setFiles([]);
              setChoices({});
              setRuns({});
              // Picked again from the next files added.
              setReferenceLanguage("");
              setTargetLanguages([]);
            }}
            disabled={busy || files.length === 0}
          >
            {m.common.removeAll}
          </button>
        </div>

        {/* Always shown, even empty: its header holds the button that adds files. */}
        <div className="batch-table-wrap list-scroll">
          <table>
            <colgroup>
              <col className="batch-col-index" />
              <col />
              <col className="batch-col-tracks" />
              <col className="batch-col-status" />
              <col className="batch-col-status" />
              <col className="batch-col-folder" />
            </colgroup>
            <thead>
              <tr>
                <th className="batch-index">#</th>
                <th>
                  <div className="batch-th-add">
                    <span>{m.multi.file}</span>
                    <button
                      className="small-button"
                      disabled={busy}
                      title={m.multi.addHint}
                      onClick={async () => {
                        const selected = await pickMediaFiles(true);
                        if (selected) addPaths(selected);
                      }}
                    >
                      {m.common.add}
                    </button>
                  </div>
                </th>
                <th>{m.multi.tracks}</th>
                <th>{m.common.analysis}</th>
                <th>{m.common.export}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {files.length === 0 && (
                <tr>
                  <td colSpan={6} className="placeholder">
                    {m.multi.empty}
                  </td>
                </tr>
              )}
              {files.map((path, i) => {
                const probed = probes[path];
                const res = resolutions[path];
                const run = runOf(path);
                return (
                  <tr key={path} className={res?.issues.length || probed?.error ? "batch-row-flagged" : undefined}>
                    <td className="batch-index">{i + 1}</td>
                    <FileCell files={files} index={i} disabled={busy} onChange={(update) => setFiles(update)} />
                    <td className="batch-tracks-cell">
                      {!probed && <span className="batch-track-status">{m.multi.readingTracks}</span>}
                      {probed?.error && <span className="error">{probed.error}</span>}
                      {res && (
                        <>
                          <div className="batch-tracks-line">
                            <span className="batch-tracks-summary">
                              {res.reference ? `@${res.reference.index} ${res.reference.language ?? "?"}` : "?"} →{" "}
                              {res.targets.length > 0
                                ? res.targets
                                    .map((t) => {
                                      const subs = subsOf(path, res.targets)[t.index] ?? [];
                                      const retimed = subs.length ? ` + ST ${subs.map((i) => `@${i}`).join(" ")}` : "";
                                      return `@${t.index} ${t.language ?? "?"}${retimed}`;
                                    })
                                    .join(", ")
                                : m.multi.nothing}
                              {res.manual && <span className="batch-track-status">{m.multi.manual}</span>}
                            </span>
                            <span className="batch-tracks-actions">
                              <button className="small-button" disabled={busy} onClick={() => setChoosing(path)}>
                                {m.multi.choose}
                              </button>
                              {res.manual && (
                                <button
                                  className="small-button"
                                  disabled={busy}
                                  title={m.multi.byLanguageHint}
                                  onClick={() =>
                                    setChoices((c) => {
                                      const next = { ...c };
                                      delete next[path];
                                      return next;
                                    })
                                  }
                                >
                                  {m.multi.byLanguage}
                                </button>
                              )}
                            </span>
                          </div>
                          {res.issues.length > 0 && <span className="batch-issues">⚠ {res.issues.join(", ")}</span>}
                        </>
                      )}
                    </td>
                    <td className="batch-status">
                      {/* The tracks to correct as picked now: one picked since
                          the last analysis shows as not analyzed yet. */}
                      {(!res?.reference || res.targets.length === 0) && "—"}
                      {res?.reference &&
                        res.targets.map((info) => {
                          const t = run?.targets[info.index];
                          return (
                            <div key={info.index} className={`batch-target batch-status-${t?.status ?? "pending"}`}>
                              <span className="batch-target-name">
                                @{info.index} {info.language ?? "?"} :
                              </span>{" "}
                              <AnalysisStatus run={t} busy={busy} onEdit={() => setEditing({ path, track: info.index })} />
                            </div>
                          );
                        })}
                    </td>
                    <ExportCell entry={run} />
                    <td className="batch-row-actions">
                      <RevealButton file={writtenFile(run)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <BatchFooter
        outputDir={outputDir}
        onOutputDirChange={onOutputDirChange}
        busy={busy}
        blocked={blocked}
        progress={
          <>
            {m.multi.progressFiles(files.length)}
            {allTargets.length > 0 && m.multi.progressAnalyzed(analyzedCount, allTargets.length)}
            {exportedCount > 0 && m.multi.progressExported(exportedCount)}
            {flaggedCount > 0 && m.multi.progressFlagged(flaggedCount)}
          </>
        }
        analyzeButton={
          <AnalyzeButton
            analyzing={analyzing}
            missing={missingCount}
            analyzed={analyzedCount}
            unit="track"
            disabled={!analyzable || busy || blocked}
            blocked={blocked}
            onAnalyze={handleAnalyze}
          />
        }
        queue={queue}
        canExport={analyzedCount > 0}
        onExport={handleExportAll}
      />

      {choosing && choosingTracks && choosingRes && (
        <TrackChoiceModal
          path={choosing}
          tracks={choosingTracks}
          subtitles={probes[choosing]?.subtitles ?? []}
          initial={{
            reference: choosingRes.reference?.index ?? choosingTracks[0].index,
            targets: choosingRes.targets.map((t) => t.index),
            subtitles: subsOf(choosing, choosingRes.targets),
          }}
          defaultSubtitles={(track) => subtitlesFor(probes[choosing]?.subtitles ?? [], track.language, subsMode)}
          onSave={(choice) => setChoices((c) => ({ ...c, [choosing]: choice }))}
          onClose={() => setChoosing(null)}
        />
      )}

      {editing && editingRun?.result && (
        <SegmentEditor
          segments={editingRun.result.segments}
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
            referenceStartTime: probes[editing.path]?.tracks?.find((t) => t.index === runOf(editing.path)!.referenceIndex)
              ?.start_time,
            trackStartTime: probes[editing.path]?.tracks?.find((t) => t.index === editing.track)?.start_time,
          }}
        />
      )}
      <DropOverlay drag={fileDrag} blocked={dropBlocked} label={m.files.dropToAdd} hint={m.files.folderHint} />
    </main>
  );
}

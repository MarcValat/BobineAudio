import { useEffect, useRef, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  probe,
  cancelJob,
  startSegmentedRenderJob,
  startSegmentsJob,
  type RenderResponse,
  type SegmentsResponse,
  type SubtitleInfo,
  type TrackInfo,
} from "./api";
import { JobCancelled, runJob, type RunStatus } from "./jobs";
import { languageLabel, LanguageSelect } from "./languages";
import { AnalyzeButton, FileCell, OTHER_MODE_BUSY, OutputChooser } from "./batchShared";
import { InfoTip } from "./InfoTip";
import { LogPanel } from "./LogPanel";
import { pickMediaFiles, planOutputPaths } from "./mediaDialog";
import { basename } from "./paths";
import { describeSegments } from "./SegmentChart";
import { SegmentEditor } from "./SegmentEditor";
import {
  SUBTITLE_MODES,
  UNSHIFTABLE_HINT,
  subtitleDetails,
  subtitleLabel,
  subtitlesFor,
  type SubtitleMode,
} from "./subtitles";
import { devParam, errorMessage } from "./util";
import { Dialog, DialogHeader } from "./Dialog";

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

interface TargetRun {
  status: RunStatus;
  result: SegmentsResponse | null;
  error: string | null;
  log: string[];
}

/** One file's analyses (one per corrected track) and its single export. Kept
 * with the reference they were made against: a different one since makes
 * them stale. */
interface FileRun {
  referenceIndex: number;
  targets: Record<number, TargetRun>;
  exportStatus: RunStatus;
  exportResult: RenderResponse | null;
  exportError: string | null;
  exportLog: string[];
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
  if (references.length === 0) issues.push(`aucune piste ${referenceLanguage}`);
  if (references.length > 1) issues.push(`plusieurs pistes ${referenceLanguage}`);
  const targets: TrackInfo[] = [];
  for (const lang of targetLanguages) {
    if (lang === referenceLanguage) continue;
    const found = withLanguage(lang).filter((t) => t !== reference);
    if (found.length === 0) issues.push(`aucune piste ${lang}`);
    if (found.length > 1) issues.push(`plusieurs pistes ${lang}`);
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
  const [choice, setChoice] = useState(initial);
  const subsOfTrack = (index: number) =>
    choice.subtitles?.[index] ?? defaultSubtitles(tracks.find((t) => t.index === index)!);
  function toggleSubtitle(track: number, sub: number) {
    setChoice((c) => {
      const mine = c.subtitles?.[track] ?? defaultSubtitles(tracks.find((t) => t.index === track)!);
      const next = mine.includes(sub) ? mine.filter((i) => i !== sub) : [...mine, sub];
      return { ...c, subtitles: { ...c.subtitles, [track]: next } };
    });
  }
  return (
    <Dialog onClose={onClose} className="batch-choice-panel" labelledBy="choice-title">
      <DialogHeader id="choice-title" title={`Pistes de ${basename(path)}`} titleTooltip={path} onClose={onClose} closeLabel="Annuler" />
        <table className="batch-tracks-table">
          <thead>
            <tr>
              <th>Piste</th>
              <th>Langue</th>
              <th>Codec</th>
              <th className="batch-choice-control">Réf.</th>
              <th className="batch-choice-control">À corriger</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((t) => (
              <tr key={t.index}>
                <td>@{t.index}</td>
                <td>{t.language ?? "?"}</td>
                <td>{t.codec ?? "?"}</td>
                <td className="batch-choice-control">
                  <input
                    type="radio"
                    name="choice-reference"
                    checked={choice.reference === t.index}
                    onChange={() =>
                      setChoice((c) => ({ ...c, reference: t.index, targets: c.targets.filter((i) => i !== t.index) }))
                    }
                  />
                </td>
                <td className="batch-choice-control">
                  <input
                    type="checkbox"
                    disabled={choice.reference === t.index}
                    checked={choice.targets.includes(t.index)}
                    onChange={() =>
                      setChoice((c) => ({
                        ...c,
                        targets: c.targets.includes(t.index) ? c.targets.filter((i) => i !== t.index) : [...c.targets, t.index],
                      }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {subtitles.length > 0 && choice.targets.length > 0 && (
          <div className="batch-choice-subs">
            <h3>
              Sous-titres à recaler{" "}
              <InfoTip>
                Les pistes de sous-titres cochées subissent les mêmes sauts et la même dérive que la piste audio de leur
                ligne ; les autres sont gardées telles quelles, calées sur la vidéo.
              </InfoTip>
            </h3>
            {choice.targets.map((track) => {
              const info = tracks.find((t) => t.index === track);
              const mine = subsOfTrack(track);
              return (
                <div key={track} className="batch-choice-subs-row">
                  <span className="batch-target-name">
                    Avec @{track} {info?.language ?? "?"} :
                  </span>
                  {subtitles.map((sub) => {
                    const elsewhere = choice.targets.some((other) => other !== track && subsOfTrack(other).includes(sub.index));
                    return (
                      <label
                        key={sub.index}
                        title={!sub.shiftable ? UNSHIFTABLE_HINT : elsewhere ? "Déjà recalés avec une autre piste audio" : subtitleDetails(sub)}
                      >
                        <input
                          type="checkbox"
                          checked={mine.includes(sub.index)}
                          disabled={!sub.shiftable || elsewhere}
                          onChange={() => toggleSubtitle(track, sub.index)}
                        />
                        {subtitleLabel(sub)}
                      </label>
                    );
                  })}
                </div>
              );
            })}
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
            Valider
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
  const [files, setFiles] = useState<string[]>([]);
  const [probes, setProbes] = useState<Record<string, FileProbe>>({});
  const [referenceLanguage, setReferenceLanguage] = useState("");
  const [targetLanguages, setTargetLanguages] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, TrackChoice>>({});
  const [subsMode, setSubsMode] = useState<SubtitleMode>("forced");
  const [runs, setRuns] = useState<Record<string, FileRun>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; track: number } | null>(null);
  const busy = analyzing || exporting;
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  /** Adds files not in the list yet (checked against the list as it really
   * is, not a possibly stale copy: adding the same files twice in a row
   * must not list them twice). */
  function addPaths(paths: string[]) {
    setFiles((current) => [...current, ...[...new Set(paths)].filter((p) => !current.includes(p))]);
  }

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
    const claimed = new Set<number>();
    const out: Record<number, number[]> = {};
    for (const t of targets) {
      const wanted = picked?.[t.index] ?? subtitlesFor(subtitles, t.language, subsMode);
      out[t.index] = wanted.filter((i) => !claimed.has(i));
      out[t.index].forEach((i) => claimed.add(i));
    }
    return out;
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

  function updateTarget(path: string, track: number, patch: Partial<TargetRun> | ((t: TargetRun) => Partial<TargetRun>)) {
    updateRun(path, (run) => {
      const target = run.targets[track];
      const next = typeof patch === "function" ? patch(target) : patch;
      return { ...run, targets: { ...run.targets, [track]: { ...target, ...next } } };
    });
  }

  /** A file's tracks to correct (as picked now) whose analysis against its
   * current reference succeeded -- what its export holds. */
  function doneTargets(path: string): [TrackInfo, TargetRun][] {
    const run = runOf(path);
    const res = resolutions[path];
    if (!run || !res) return [];
    return res.targets.flatMap((t) => {
      const target = run.targets[t.index];
      return target?.status === "done" && target.result ? [[t, target] as [TrackInfo, TargetRun]] : [];
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
              targets.map((t) => [t.index, { status: "pending" as RunStatus, result: null, error: null, log: [] }]),
            ),
          },
          // What it held changes: the last export no longer matches.
          exportStatus: "idle",
          exportResult: null,
          exportError: null,
          exportLog: [],
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
  // "Annuler l'export": stop the file being exported and don't start the next ones.
  const cancelRequested = useRef(false);
  const currentExportJob = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function cancelExports() {
    cancelRequested.current = true;
    setCancelling(true);
    if (currentExportJob.current) {
      try {
        await cancelJob(currentExportJob.current);
      } catch {
        // already over: the loop stops before the next file anyway
      }
    }
  }

  async function handleExportAll() {
    setExporting(true);
    cancelRequested.current = false;
    const toExport = files.filter((path) => doneTargets(path).length > 0);
    let outputs: string[];
    try {
      outputs = await planOutputPaths(toExport, outputDir);
    } catch (err) {
      const message = errorMessage(err);
      for (const path of toExport) updateRun(path, (r) => ({ ...r, exportStatus: "error", exportError: message }));
      setExporting(false);
      return;
    }
    for (const [k, path] of toExport.entries()) {
      if (cancelRequested.current) break;
      const run = runOf(path)!;
      const done = doneTargets(path);
      updateRun(path, (r) => ({ ...r, exportStatus: "running", exportLog: [], exportError: null }));
      const subs = subsOf(
        path,
        done.map(([track]) => track),
      );
      try {
        const result = await runJob<RenderResponse>(
          startSegmentedRenderJob(
            path,
            run.referenceIndex,
            done.map(([track, t]) => ({
              trackIndex: track.index,
              segments: t.result!.segments,
              subtitles: subs[track.index] ?? [],
            })),
            outputs[k],
          ),
          (message) => updateRun(path, (r) => ({ ...r, exportLog: [...r.exportLog, message] })),
          (id) => (currentExportJob.current = id),
        );
        updateRun(path, (r) => ({ ...r, exportStatus: "done", exportResult: result }));
      } catch (err) {
        if (err instanceof JobCancelled) updateRun(path, (r) => ({ ...r, exportStatus: "cancelled" }));
        else
          updateRun(path, (r) => ({ ...r, exportStatus: "error", exportError: errorMessage(err) }));
      }
      currentExportJob.current = null;
    }
    setExporting(false);
    setCancelling(false);
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
          Référence :
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
          À corriger :
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
                    setTargetLanguages((t) => (t.includes(lang) ? t.filter((l) => l !== lang) : [...t, lang]))
                  }
                />
                {languageLabel(lang)}
              </label>
            ))}
        </span>
        <label>
          Sous-titres :
          <select value={subsMode} onChange={(e) => setSubsMode(e.target.value as SubtitleMode)} disabled={busy}>
            {SUBTITLE_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <InfoTip>
          Chaque fichier contient déjà la référence et les pistes à corriger. Les pistes sont choisies par langue, pour
          tous les fichiers : un fichier où une langue manque ou apparaît plusieurs fois est signalé ⚠, et « Choisir »
          permet de fixer ses pistes à la main. Les sous-titres choisis (texte seulement : SRT, ASS) sont recalés avec la
          piste audio de leur langue ; les autres sont gardés tels quels.
        </InfoTip>
      </div>

      <section className="panel batch-jobs">
        <div className="batch-jobs-header">
          <h2>Fichiers</h2>
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
            Tout retirer
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
                    <span>Fichier</span>
                    <button
                      className="small-button"
                      disabled={busy}
                      title="Ajouter des fichiers qui contiennent chacun la référence et les pistes à corriger"
                      onClick={async () => {
                        const selected = await pickMediaFiles(true);
                        if (selected) addPaths(selected);
                      }}
                    >
                      + Ajouter
                    </button>
                  </div>
                </th>
                <th>Pistes</th>
                <th>Analyse</th>
                <th>Export</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {files.length === 0 && (
                <tr>
                  <td colSpan={6} className="placeholder">
                    Ajoute les fichiers à traiter : chacun contient la référence et la ou les pistes à corriger.
                  </td>
                </tr>
              )}
              {files.map((path, i) => {
                const probed = probes[path];
                const res = resolutions[path];
                const run = runOf(path);
                const written = run?.exportResult?.written[0];
                return (
                  <tr key={path} className={res?.issues.length || probed?.error ? "batch-row-flagged" : undefined}>
                    <td className="batch-index">{i + 1}</td>
                    <FileCell files={files} index={i} disabled={busy} onChange={(update) => setFiles(update)} />
                    <td className="batch-tracks-cell">
                      {!probed && <span className="batch-track-status">Lecture des pistes...</span>}
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
                                : "rien"}
                              {res.manual && <span className="batch-track-status"> (manuel)</span>}
                            </span>
                            <span className="batch-tracks-actions">
                              <button className="small-button" disabled={busy} onClick={() => setChoosing(path)}>
                                Choisir
                              </button>
                              {res.manual && (
                                <button
                                  className="small-button"
                                  disabled={busy}
                                  title="Revenir au choix par langue"
                                  onClick={() =>
                                    setChoices((c) => {
                                      const next = { ...c };
                                      delete next[path];
                                      return next;
                                    })
                                  }
                                >
                                  Par langue
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
                              {!t && "À analyser"}
                              {t?.status === "pending" && "En attente"}
                              {t?.status === "running" && "Analyse en cours..."}
                              {t?.status === "done" && t.result && describeSegments(t.result.segments)}
                              {t?.status === "error" && (t.error ?? "Erreur")}
                              {t?.status === "done" && t.result && (
                                <button
                                  className="small-button"
                                  disabled={busy}
                                  onClick={() => setEditing({ path, track: info.index })}
                                >
                                  Modifier
                                </button>
                              )}
                              {t && (t.status === "running" || t.status === "error") && <LogPanel lines={t.log} />}
                            </div>
                          );
                        })}
                    </td>
                    <td className={`batch-status batch-status-${!run || run.exportStatus === "idle" ? "pending" : run.exportStatus}`}>
                      {(!run || run.exportStatus === "idle") && "—"}
                      {run?.exportStatus === "running" && "Export en cours..."}
                      {run?.exportStatus === "done" && written && <span title={written}>{basename(written)}</span>}
                      {run?.exportStatus === "error" && (run.exportError ?? "Erreur")}
                      {run?.exportStatus === "cancelled" && "Annulé"}
                      {run && (run.exportStatus === "running" || run.exportStatus === "error") && (
                        <LogPanel lines={run.exportLog} />
                      )}
                    </td>
                    <td className="batch-row-actions">
                      {written && (
                        <button className="small-button" title="Ouvrir le dossier du fichier écrit" onClick={() => revealItemInDir(written)}>
                          Dossier
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="batch-footer panel">
        <OutputChooser outputDir={outputDir} onChange={onOutputDirChange} disabled={busy} />
        <span className="batch-progress">
          {files.length} fichier{files.length > 1 ? "s" : ""}
          {allTargets.length > 0 && ` · ${analyzedCount}/${allTargets.length} piste${allTargets.length > 1 ? "s" : ""} analysée${analyzedCount > 1 ? "s" : ""}`}
          {exportedCount > 0 && ` · ${exportedCount} exporté${exportedCount > 1 ? "s" : ""}`}
          {flaggedCount > 0 && ` · ⚠ ${flaggedCount} à vérifier`}
        </span>
        <AnalyzeButton
          analyzing={analyzing}
          missing={missingCount}
          analyzed={analyzedCount}
          unit="piste"
          disabled={!analyzable || busy || blocked}
          blocked={blocked}
          onAnalyze={handleAnalyze}
        />
        {exporting ? (
          <button className="export-cancel" onClick={cancelExports} disabled={cancelling}>
            {cancelling ? "Annulation..." : "Annuler l'export"}
          </button>
        ) : (
          <button
            className="primary-button"
            onClick={handleExportAll}
            disabled={analyzedCount === 0 || busy || blocked}
            title={blocked ? OTHER_MODE_BUSY : undefined}
          >
            Exporter tout
          </button>
        )}
      </div>

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
    </main>
  );
}

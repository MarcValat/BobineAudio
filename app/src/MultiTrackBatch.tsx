import { useEffect, useRef, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  probe,
  startSegmentedRenderJob,
  startSegmentsJob,
  type RenderResponse,
  type SegmentsResponse,
  type TrackInfo,
} from "./api";
import { FileCell, languageLabel, LanguageSelect, OutputChooser, runJob, type RunStatus } from "./batchShared";
import { InfoTip } from "./InfoTip";
import { LogPanel } from "./LogPanel";
import { outputPathFor, pickMediaFiles } from "./mediaDialog";
import { basename } from "./paths";
import { describeSegments } from "./SegmentChart";
import { SegmentEditor } from "./SegmentEditor";

interface FileProbe {
  tracks: TrackInfo[] | null;
  error: string | null;
}

/** A file's tracks picked by hand ("Choisir"), instead of by language. */
interface TrackChoice {
  reference: number;
  targets: number[];
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
  initial,
  onSave,
  onClose,
}: {
  path: string;
  tracks: TrackInfo[];
  initial: TrackChoice;
  onSave: (choice: TrackChoice) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState(initial);
  return (
    <div className="batch-tracks-overlay" role="dialog" aria-modal="true">
      <div className="batch-tracks-panel batch-choice-panel">
        <div className="batch-tracks-header">
          <h2 title={path}>Pistes de {basename(path)}</h2>
          <button className="small-button" onClick={onClose}>
            Annuler
          </button>
        </div>
        <table className="batch-tracks-table">
          <thead>
            <tr>
              <th>Piste</th>
              <th>Langue</th>
              <th>Codec</th>
              <th>Réf.</th>
              <th>À corriger</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((t) => (
              <tr key={t.index}>
                <td>@{t.index}</td>
                <td>{t.language ?? "?"}</td>
                <td>{t.codec ?? "?"}</td>
                <td>
                  <input
                    type="radio"
                    name="choice-reference"
                    checked={choice.reference === t.index}
                    onChange={() =>
                      setChoice((c) => ({ reference: t.index, targets: c.targets.filter((i) => i !== t.index) }))
                    }
                  />
                </td>
                <td>
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
      </div>
    </div>
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
}: {
  hidden: boolean;
  modeSwitch: ReactNode;
  outputDir: string | null;
  onOutputDirChange: (dir: string | null) => void;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [probes, setProbes] = useState<Record<string, FileProbe>>({});
  const [referenceLanguage, setReferenceLanguage] = useState("");
  const [targetLanguages, setTargetLanguages] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, TrackChoice>>({});
  const [runs, setRuns] = useState<Record<string, FileRun>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; track: number } | null>(null);
  const busy = analyzing || exporting;

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
        .then((res) => setProbes((p) => ({ ...p, [path]: { tracks: res.tracks, error: null } })))
        .catch((err) =>
          setProbes((p) => ({ ...p, [path]: { tracks: null, error: err instanceof Error ? err.message : String(err) } })),
        );
    }
  }, [files]);

  // Dev only (stripped from production builds): `?batchFiles=a|b` adds files
  // without the system dialog, for automated screenshots.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const list = new URLSearchParams(window.location.search).get("batchFiles");
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

  async function handleAnalyzeAll() {
    setAnalyzing(true);
    const plan = files
      .map((path) => ({ path, res: resolutions[path] }))
      .filter((x): x is { path: string; res: Resolution } => !!x.res?.reference && x.res.targets.length > 0);
    setRuns((current) => {
      const next = { ...current };
      for (const { path, res } of plan) {
        next[path] = {
          referenceIndex: res.reference!.index,
          targets: Object.fromEntries(
            res.targets.map((t) => [t.index, { status: "pending" as RunStatus, result: null, error: null, log: [] }]),
          ),
          exportStatus: "idle",
          exportResult: null,
          exportError: null,
          exportLog: [],
        };
      }
      return next;
    });
    for (const { path, res } of plan) {
      for (const target of res.targets) {
        updateTarget(path, target.index, { status: "running" });
        try {
          const result = await runJob<SegmentsResponse>(
            startSegmentsJob(path, res.reference!.index, path, target.index),
            (message) => updateTarget(path, target.index, (t) => ({ log: [...t.log, message] })),
          );
          updateTarget(path, target.index, { status: "done", result });
        } catch (err) {
          updateTarget(path, target.index, { status: "error", error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    setAnalyzing(false);
  }

  /** One export per file, holding every corrected track whose analysis
   * succeeded, with its segments as edited ("Modifier"). */
  async function handleExportAll() {
    setExporting(true);
    for (const path of files) {
      const run = runOf(path);
      const done = run ? Object.entries(run.targets).filter(([, t]) => t.status === "done" && t.result) : [];
      if (!run || done.length === 0) continue;
      updateRun(path, (r) => ({ ...r, exportStatus: "running", exportLog: [], exportError: null }));
      try {
        const result = await runJob<RenderResponse>(
          startSegmentedRenderJob(
            path,
            run.referenceIndex,
            done.map(([track, t]) => ({ trackIndex: Number(track), segments: t.result!.segments })),
            outputPathFor(path, outputDir),
          ),
          (message) => updateRun(path, (r) => ({ ...r, exportLog: [...r.exportLog, message] })),
        );
        updateRun(path, (r) => ({ ...r, exportStatus: "done", exportResult: result }));
      } catch (err) {
        updateRun(path, (r) => ({ ...r, exportStatus: "error", exportError: err instanceof Error ? err.message : String(err) }));
      }
    }
    setExporting(false);
  }

  const allTargets = files.flatMap((f) => (runOf(f) ? Object.values(runOf(f)!.targets) : []));
  const analyzedCount = allTargets.filter((t) => t.status === "done").length;
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
        <InfoTip>
          Chaque fichier contient déjà la référence et les pistes à corriger. Les pistes sont choisies par langue, pour
          tous les fichiers : un fichier où une langue manque ou apparaît plusieurs fois est signalé ⚠, et « Choisir »
          permet de fixer ses pistes à la main.
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
                                ? res.targets.map((t) => `@${t.index} ${t.language ?? "?"}`).join(", ")
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
                      {!run && "—"}
                      {run &&
                        Object.entries(run.targets).map(([track, t]) => {
                          const info = probed?.tracks?.find((x) => x.index === Number(track));
                          return (
                            <div key={track} className={`batch-target batch-status-${t.status}`}>
                              <span className="batch-target-name">
                                @{track} {info?.language ?? "?"} :
                              </span>{" "}
                              {t.status === "pending" && "en attente"}
                              {t.status === "running" && "analyse en cours..."}
                              {t.status === "done" && t.result && describeSegments(t.result.segments)}
                              {t.status === "error" && (t.error ?? "erreur")}
                              {t.status === "done" && t.result && (
                                <button
                                  className="small-button"
                                  disabled={busy}
                                  onClick={() => setEditing({ path, track: Number(track) })}
                                >
                                  Modifier
                                </button>
                              )}
                              {(t.status === "running" || t.status === "error") && <LogPanel lines={t.log} />}
                            </div>
                          );
                        })}
                    </td>
                    <td className={`batch-status batch-status-${!run || run.exportStatus === "idle" ? "pending" : run.exportStatus}`}>
                      {(!run || run.exportStatus === "idle") && "—"}
                      {run?.exportStatus === "running" && "Export en cours..."}
                      {run?.exportStatus === "done" && written && <span title={written}>{basename(written)}</span>}
                      {run?.exportStatus === "error" && (run.exportError ?? "Erreur")}
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
        <button className="primary-button" onClick={handleAnalyzeAll} disabled={!analyzable || busy}>
          {analyzing ? "Analyse en cours..." : "Analyser tout"}
        </button>
        <button className="primary-button" onClick={handleExportAll} disabled={analyzedCount === 0 || busy}>
          {exporting ? "Export en cours..." : "Exporter tout"}
        </button>
      </div>

      {choosing && choosingTracks && choosingRes && (
        <TrackChoiceModal
          path={choosing}
          tracks={choosingTracks}
          initial={{
            reference: choosingRes.reference?.index ?? choosingTracks[0].index,
            targets: choosingRes.targets.map((t) => t.index),
          }}
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
          }}
        />
      )}
    </main>
  );
}

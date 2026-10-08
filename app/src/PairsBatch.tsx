import { useEffect, useState } from "react";
import { probe, startSegmentsJob, startCrossFileSegmentedRenderJob, type SegmentsResponse, type TrackInfo } from "./api";
import { runJob } from "./jobs";
import { LanguageSelect } from "./languages";
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
import { SegmentEditor } from "./SegmentEditor";
import { pickMediaFiles } from "./mediaDialog";
import { DropOverlay, useFileDrop } from "./FileDrop";
import { basename } from "./paths";
import { SUBTITLE_MODES, subtitlesFor, type SubtitleMode } from "./subtitles";
import { devParam, errorMessage } from "./util";
import { Dialog, DialogHeader } from "./Dialog";
import { TrackTable } from "./TrackTable";
import { useT } from "./i18n";
import { useSubtitleDefault } from "./settings";


/** One pair's analysis and export. */
type PairAnalysis = AnalysisRun & ExportFields;

/** Probes one file's tracks, to fill the track-picker dropdown. Only ever
 * called on the *first* file of each list, not every file: one picked
 * index applies to every pair (see PairsBatch's docstring, "a series keeps
 * the same track layout episode to episode"), so probing every file in a
 * big batch just to fill a dropdown would be slow and redundant -- the
 * "Vérifier toutes les pistes" modal below is what covers checking every
 * file individually when that assumption needs auditing. */
function useTracksOf(path: string | undefined): { tracks: TrackInfo[] | null; loading: boolean; error: string | null } {
  const [tracks, setTracks] = useState<TrackInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setTracks(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    probe(path)
      .then((res) => {
        if (!cancelled) setTracks(res.tracks);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return { tracks, loading, error };
}

interface TrackPickerProps {
  label: string;
  tracks: TrackInfo[] | null;
  loading: boolean;
  error: string | null;
  value: number;
  onChange: (index: number) => void;
  disabled?: boolean;
}

/** A dropdown of the first file's actual tracks (index/language/codec),
 * not a blind number field -- falls back to a plain number input when
 * there's nothing to probe yet or probing failed, so picking is never
 * blocked on that. */
function TrackPicker({ label, tracks, loading, error, value, onChange, disabled }: TrackPickerProps) {
  const m = useT();
  return (
    <label>
      {m.common.labelled(label)}
      {tracks && tracks.length > 0 ? (
        <select value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled}>
          {tracks.map((t) => (
            <option key={t.index} value={t.index}>
              @{t.index} — {t.language ?? "?"} ({t.codec ?? "?"})
            </option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          min={0}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        />
      )}
      {loading && <span className="batch-track-status">{m.pairs.probing}</span>}
      {error && (
        <span className="batch-track-status batch-track-status-error" title={error}>
          {m.pairs.tracksUnavailable}
        </span>
      )}
    </label>
  );
}

/** "Vérifier toutes les pistes" modal: probes *every* file in both lists
 * (unlike the track pickers above, which only ever look at the first file
 * of each) so the user can audit that every episode really does have the
 * expected tracks in the expected order before committing to one
 * reference/candidate index for the whole batch. Fetched fresh each time
 * the modal opens rather than kept live -- this is a manual spot-check,
 * not something that needs to track file-list edits in real time. */
function AllTracksModal({ referenceFiles, candidateFiles, onClose }: { referenceFiles: string[]; candidateFiles: string[]; onClose: () => void }) {
  const m = useT();
  const [entries, setEntries] = useState<Record<string, { tracks: TrackInfo[] | null; error: string | null }>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const paths = [...new Set([...referenceFiles, ...candidateFiles])];
    setLoading(true);
    Promise.all(
      paths.map((path) =>
        probe(path)
          .then((res) => [path, { tracks: res.tracks, error: null }] as const)
          .catch((err) => [path, { tracks: null, error: errorMessage(err) }] as const),
      ),
    ).then((results) => {
      if (cancelled) return;
      setEntries(Object.fromEntries(results));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally a one-shot snapshot on open, not live-tracking the lists
  }, []);

  function renderSide(title: string, files: string[]) {
    return (
      <div className="batch-tracks-side">
        <h3>{title}</h3>
        {files.length === 0 ? (
          <p className="placeholder">{m.pairs.noFiles}</p>
        ) : (
          files.map((path, i) => {
            const entry = entries[path];
            return (
              <div className="batch-tracks-file" key={`${i}-${path}`}>
                <p className="batch-tracks-filename" title={path}>
                  {i + 1}. {basename(path)}
                </p>
                {loading && !entry && <p className="placeholder">{m.pairs.probing}</p>}
                {entry?.error && <p className="error">{entry.error}</p>}
                {entry?.tracks && (
                  <TrackTable className="batch-tracks-table" tracks={entry.tracks} showChannels />
                )}
              </div>
            );
          })
        )}
      </div>
    );
  }

  return (
    <Dialog onClose={onClose} closeOnBackdrop className="batch-tracks-panel" labelledBy="all-tracks-title">
      <DialogHeader id="all-tracks-title" title={m.pairs.checkAllTracks} onClose={onClose} />
      <div className="batch-tracks-columns">
        {renderSide(m.pairs.referenceFiles, referenceFiles)}
        {renderSide(m.pairs.candidateFiles, candidateFiles)}
      </div>
    </Dialog>
  );
}

/** Batch mode's "Paires de fichiers": process a whole series of episodes in
 * one pass, each episode's corrected track coming from another file than
 * its reference (a video, or an audio-only file). Two independently-
 * imported file lists, paired
 * strictly by position (row 1 of each = pair 1, etc.) -- chosen over
 * auto-matching by filename for predictability: a wrong position is
 * visible and fixable with the up/down arrows, a wrong filename-based
 * guess could silently pair the wrong episodes. One reference/candidate
 * track index pair, applied to every pair alike -- a series is assumed to
 * keep the same track layout episode to episode (both @0 is a real,
 * expected case: a reference file with only VO and a to-correct file with
 * only VF); "Vérifier toutes les pistes" lets that assumption actually be
 * checked instead of just hoped.
 *
 * Laid out as one table, one row per pair: both files, the analysis, the
 * export and the row's actions side by side, so nothing needs lining up
 * across separate lists. The table takes the height the window leaves and
 * scrolls in its own frame; nothing else in the view scrolls.
 *
 * Always kept mounted by the caller (App.tsx) even while on the other tab
 * -- `hidden` just toggles visibility -- so switching tabs never resets
 * the imported file lists or analysis results. */
export function PairsBatch({
  hidden,
  outputDir,
  onOutputDirChange,
  blocked,
  onBusyChange,
}: {
  hidden: boolean;
  outputDir: string | null;
  onOutputDirChange: (dir: string | null) => void;
  /** The other batch mode is working: nothing starts here meanwhile. */
  blocked: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const m = useT();
  const [referenceFiles, setReferenceFiles] = useState<string[]>([]);
  const [candidateFiles, setCandidateFiles] = useState<string[]>([]);
  const [referenceTrackIndex, setReferenceTrackIndex] = useState(0);
  const [candidateTrackIndex, setCandidateTrackIndex] = useState(1);
  // "" keeps the corrected track's own language; a code tags it with that one
  // instead (a bare .wav has none).
  const [candidateLanguage, setCandidateLanguage] = useState("");
  // Starts as the default setting (Options), and follows it when it changes.
  const subtitleDefault = useSubtitleDefault();
  const [subsMode, setSubsMode] = useState<SubtitleMode>(subtitleDefault);
  useEffect(() => setSubsMode(subtitleDefault), [subtitleDefault]);
  // Keyed by what each analysis was made of (see pairKey), not by row: moving
  // files, adding more or picking other tracks never shows a pair another
  // pair's analysis, and one that comes back finds its own again.
  const [analyses, setAnalyses] = useState<Record<string, PairAnalysis>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const queue = useExportQueue(outputDir);
  const [showTracksModal, setShowTracksModal] = useState(false);
  const [editingPairIndex, setEditingPairIndex] = useState<number | null>(null);

  const referenceProbe = useTracksOf(referenceFiles[0]);
  const candidateProbe = useTracksOf(candidateFiles[0]);

  // Re-pick a sensible default the moment a *new* first file's tracks come
  // in (e.g. the reference list was just (re)populated) -- doesn't fight a
  // manual pick afterwards, since this only fires when the tracks array
  // itself changes, not on every render.
  useEffect(() => {
    if (referenceProbe.tracks && referenceProbe.tracks.length > 0) setReferenceTrackIndex(referenceProbe.tracks[0].index);
  }, [referenceProbe.tracks]);
  useEffect(() => {
    if (candidateProbe.tracks && candidateProbe.tracks.length > 0) {
      setCandidateTrackIndex(candidateProbe.tracks.length > 1 ? candidateProbe.tracks[1].index : candidateProbe.tracks[0].index);
    }
  }, [candidateProbe.tracks]);

  // Dev only (see devParam): `?batchRef=a|b&batchCand=c|d` fills the lists.
  useEffect(() => {
    const refs = devParam("batchRef");
    const cands = devParam("batchCand");
    if (refs) setReferenceFiles(refs.split("|"));
    if (cands) setCandidateFiles(cands.split("|"));
  }, []);

  function addFiles(setFiles: (update: (files: string[]) => string[]) => void) {
    return async () => {
      const selected = await pickMediaFiles(true);
      if (selected) setFiles((files) => [...files, ...selected]);
    };
  }

  const pairCount = Math.min(referenceFiles.length, candidateFiles.length);
  const rowCount = Math.max(referenceFiles.length, candidateFiles.length);

  /** Row `i`'s pair as it stands: both files and both tracks. */
  function pairKey(i: number): string {
    return JSON.stringify([referenceFiles[i], referenceTrackIndex, candidateFiles[i], candidateTrackIndex]);
  }
  const analysisOf = (i: number): PairAnalysis | undefined => (i < pairCount ? analyses[pairKey(i)] : undefined);
  const isDone = (a: PairAnalysis | undefined) => a?.status === "done" && !!a.result;

  function updatePair(key: string, patch: Partial<PairAnalysis> | ((entry: PairAnalysis) => Partial<PairAnalysis>)) {
    setAnalyses((current) =>
      current[key] ? { ...current, [key]: { ...current[key], ...(typeof patch === "function" ? patch(current[key]) : patch) } } : current,
    );
  }

  /** Analyzes the pairs that aren't yet (new ones, failed ones), keeping the
   * rest and any edit made to them; or all of them again (`all`). */
  async function handleAnalyze(all: boolean) {
    setAnalyzing(true);
    const plan = Array.from({ length: pairCount }, (_, i) => ({
      key: pairKey(i),
      reference: referenceFiles[i],
      candidate: candidateFiles[i],
    })).filter(({ key }) => all || !isDone(analyses[key]));
    const [referenceTrack, candidateTrack] = [referenceTrackIndex, candidateTrackIndex];
    setAnalyses((current) => {
      const next = { ...current };
      for (const { key } of plan) next[key] = { status: "pending", result: null, error: null, log: [], ...IDLE_EXPORT };
      return next;
    });
    for (const { key, reference, candidate } of plan) {
      updatePair(key, { status: "running" });
      try {
        const result = await runJob<SegmentsResponse>(
          startSegmentsJob(reference, referenceTrack, candidate, candidateTrack),
          (message) => updatePair(key, (a) => ({ log: [...a.log, message] })),
        );
        updatePair(key, { status: "done", result });
      } catch (err) {
        updatePair(key, { status: "error", error: errorMessage(err) });
      }
    }
    setAnalyzing(false);
  }

  const pairAnalyses = Array.from({ length: pairCount }, (_, i) => analysisOf(i));
  const analyzedCount = pairAnalyses.filter(isDone).length;
  const exportedCount = pairAnalyses.filter((a) => a?.exportStatus === "done").length;

  /** Exports every successfully-analyzed pair, in the order analyzed --
   * pairs that failed detection or never ran are left alone (exportStatus
   * stays "idle") rather than attempted, since there's no segment list to
   * render from. Uses each pair's current `result.segments`, which is
   * exactly what "Modifier" lets the user hand-adjust first -- same
   * principle as the single-file view: export must reflect a reviewed
   * edit, not silently re-run detection and discard it. Both buttons are
   * disabled while *either* operation runs, not just their own: export
   * reads `analyses` as it currently stands, so a concurrent re-analysis
   * could rewrite a pair's segments out from under an export already using
   * them. */
  function handleExportAll() {
    queue.run(
      pairAnalyses.flatMap((a, i) => {
        if (!isDone(a)) return [];
        const key = pairKey(i);
        return [
          {
            input: referenceFiles[i],
            start: async (outputPath: string) => {
              // The candidate file's subtitles in its audio's language come
              // along, retimed with it (per the subtitle setting).
              const candidate = subsMode === "none" ? null : await probe(candidateFiles[i]);
              const audioLanguage =
                candidate?.tracks.find((t) => t.index === candidateTrackIndex)?.language || candidateLanguage || null;
              return startCrossFileSegmentedRenderJob(
                referenceFiles[i],
                referenceTrackIndex,
                candidateFiles[i],
                candidateTrackIndex,
                analyses[key].result!.segments,
                {
                  outputPath,
                  language: candidateLanguage || null,
                  subtitles: candidate ? subtitlesFor(candidate.subtitles ?? [], audioLanguage, subsMode) : [],
                },
              );
            },
            update: (patch: (e: ExportFields) => Partial<ExportFields>) => updatePair(key, patch),
          },
        ];
      }),
    );
  }

  const busy = analyzing || queue.exporting;

  // Dropped on the left half: reference files; on the right: files to correct.
  const dropBlocked = dropBlockedReason(busy, blocked);
  const fileDrag = useFileDrop(!hidden && !showTracksModal && editingPairIndex === null, dropBlocked, (files, side) =>
    (side === "left" ? setReferenceFiles : setCandidateFiles)((current) => [...current, ...files]),
  );
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  // The files' own start times, for the editor's informational "delay
  // already in the file" note: probed when a pair is opened for editing.
  const [editStartTimes, setEditStartTimes] = useState<{ reference?: number; track?: number }>({});
  useEffect(() => {
    setEditStartTimes({});
    if (editingPairIndex === null) return;
    let cancelled = false;
    Promise.all([probe(referenceFiles[editingPairIndex]), probe(candidateFiles[editingPairIndex])])
      .then(([ref, cand]) => {
        if (cancelled) return;
        setEditStartTimes({
          reference: ref.tracks.find((t) => t.index === referenceTrackIndex)?.start_time,
          track: cand.tracks.find((t) => t.index === candidateTrackIndex)?.start_time,
        });
      })
      .catch(() => {
        // informational only: the editor just goes without it
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the lists and tracks can't change while the editor is open
  }, [editingPairIndex]);
  const editingAnalysis = editingPairIndex !== null ? analysisOf(editingPairIndex) : undefined;

  return (
    <main className="batch-main" style={hidden ? { display: "none" } : undefined}>
      <div className="batch-config panel">
        <TrackPicker
          label={m.common.reference}
          tracks={referenceProbe.tracks}
          loading={referenceProbe.loading}
          error={referenceProbe.error}
          value={referenceTrackIndex}
          onChange={setReferenceTrackIndex}
          disabled={busy}
        />
        <TrackPicker
          label={m.common.toCorrect}
          tracks={candidateProbe.tracks}
          loading={candidateProbe.loading}
          error={candidateProbe.error}
          value={candidateTrackIndex}
          onChange={setCandidateTrackIndex}
          disabled={busy}
        />
        <label>
          {m.pairs.language}
          <LanguageSelect
            value={candidateLanguage}
            onChange={setCandidateLanguage}
            extra={candidateProbe.tracks?.map((t) => t.language) ?? []}
            emptyLabel={m.pairs.fileLanguage(
              candidateProbe.tracks?.find((t) => t.index === candidateTrackIndex)?.language ?? null,
            )}
            disabled={busy}
          />
          <InfoTip>{m.pairs.languageHint}</InfoTip>
        </label>
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
        <InfoTip>{m.pairs.hint}</InfoTip>
      </div>

      <section className="panel batch-jobs">
        <div className="batch-jobs-header">
          <h2>{m.pairs.pairs}</h2>
          <button
            className="small-button"
            onClick={() => {
              setReferenceFiles([]);
              setCandidateFiles([]);
              setAnalyses({});
            }}
            disabled={busy || rowCount === 0}
          >
            {m.common.removeAll}
          </button>
          <button className="small-button" onClick={() => setShowTracksModal(true)} disabled={rowCount === 0}>
            {m.pairs.checkAllTracks}
          </button>
          <InfoTip>{m.pairs.pairsHint}</InfoTip>
        </div>

        {/* Always shown, even empty: its column headers hold the buttons that
            add files to each column. */}
        <div className="batch-table-wrap list-scroll">
          <table>
            <colgroup>
              <col className="batch-col-index" />
              <col />
              <col />
              <col className="batch-col-status" />
              <col className="batch-col-status" />
              <col className="batch-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th className="batch-index">#</th>
                <th>
                  <div className="batch-th-add">
                    <span>{m.common.reference}</span>
                    <button
                      className="small-button"
                      onClick={addFiles(setReferenceFiles)}
                      disabled={busy}
                      title={m.pairs.addReferenceHint}
                    >
                      {m.common.add}
                    </button>
                  </div>
                </th>
                <th>
                  <div className="batch-th-add">
                    <span>{m.common.toCorrect}</span>
                    <button
                      className="small-button"
                      onClick={addFiles(setCandidateFiles)}
                      disabled={busy}
                      title={m.pairs.addCandidateHint}
                    >
                      {m.common.add}
                    </button>
                  </div>
                </th>
                <th>{m.common.analysis}</th>
                <th>{m.common.export}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rowCount === 0 && (
                <tr>
                  <td colSpan={6} className="placeholder">
                    {m.pairs.empty}
                  </td>
                </tr>
              )}
              {Array.from({ length: rowCount }, (_, i) => {
                const a = analysisOf(i);
                return (
                  <tr key={i} className={i >= pairCount ? "batch-row-unpaired" : undefined}>
                    <td className="batch-index">{i + 1}</td>
                    <FileCell
                      files={referenceFiles}
                      index={i}
                      disabled={busy}
                      onChange={setReferenceFiles}
                    />
                    <FileCell
                      files={candidateFiles}
                      index={i}
                      disabled={busy}
                      onChange={setCandidateFiles}
                    />
                    <td className={`batch-status batch-status-${a?.status ?? "pending"}`}>
                      {i < pairCount ? (
                        <AnalysisStatus run={a} busy={busy} onEdit={() => setEditingPairIndex(i)} />
                      ) : (
                        m.pairs.unpaired
                      )}
                    </td>
                    <ExportCell entry={a} />
                    <td className="batch-row-actions">
                      <RevealButton file={writtenFile(a)} />
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
            {m.pairs.progressPairs(pairCount)}
            {analyzedCount > 0 && m.pairs.progressAnalyzed(analyzedCount, pairCount)}
            {exportedCount > 0 && m.pairs.progressExported(exportedCount)}
            {rowCount > pairCount && m.pairs.progressUnpaired(rowCount - pairCount)}
          </>
        }
        analyzeButton={
          <AnalyzeButton
            analyzing={analyzing}
            missing={pairCount - analyzedCount}
            analyzed={analyzedCount}
            unit="pair"
            disabled={pairCount === 0 || busy || blocked}
            blocked={blocked}
            onAnalyze={handleAnalyze}
          />
        }
        queue={queue}
        canExport={analyzedCount > 0}
        onExport={handleExportAll}
      />

      {showTracksModal && (
        <AllTracksModal referenceFiles={referenceFiles} candidateFiles={candidateFiles} onClose={() => setShowTracksModal(false)} />
      )}

      {editingPairIndex !== null && editingAnalysis?.result && (
        <SegmentEditor
          segments={editingAnalysis.result.segments}
          onClose={() => setEditingPairIndex(null)}
          onSave={(edited) =>
            updatePair(pairKey(editingPairIndex), (a) => ({ result: a.result ? { ...a.result, segments: edited } : a.result }))
          }
          preview={{
            referenceFilePath: referenceFiles[editingPairIndex],
            candidateFilePath: candidateFiles[editingPairIndex],
            referenceIndex: referenceTrackIndex,
            trackIndex: candidateTrackIndex,
            referenceStartTime: editStartTimes.reference,
            trackStartTime: editStartTimes.track,
          }}
        />
      )}
      <DropOverlay
        drag={fileDrag}
        blocked={dropBlocked}
        split={[m.common.reference, m.common.toCorrect]}
        hint={m.files.folderHint}
      />
    </main>
  );
}

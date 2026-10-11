import { useEffect, useState } from "react";
import {
  probe,
  startSegmentsJob,
  startCrossFileSegmentedRenderJob,
  type ProbeResponse,
  type SegmentsResponse,
  type TrackInfo,
} from "./api";
import { runJob } from "./jobs";
import { LanguageSelect } from "./languages";
import {
  AnalyzeButton,
  BatchFooter,
  IDLE_EXPORT,
  rowState,
  useExportQueue,
  dropBlockedReason,
  type AnalysisRun,
  type ExportFields,
} from "./batchShared";
import { InfoTip, Tooltip } from "./InfoTip";
import { DetailExport, MoveButtons, PairRow, type BadgeKind } from "./Workspace";
import { LogPanel } from "./LogPanel";
import { PillSwitch } from "./PillSwitch";
import { SegmentChart, SegmentChartPlaceholder, describeSegments } from "./SegmentChart";
import { TrackPreview } from "./TrackPreview";
import { RedoIcon } from "./icons";
import { useElementSize } from "./useElementSize";
import { SegmentEditor } from "./SegmentEditor";
import { DropZone } from "./DropZone";
import { pickMediaFiles } from "./mediaDialog";
import { DropOverlay, useFileDrop } from "./FileDrop";
import { basename } from "./paths";
import { SUBTITLE_MODES, subtitlesFor, type SubtitleMode } from "./subtitles";
import { devParam, errorMessage } from "./util";
import { Dialog, DialogHeader } from "./Dialog";
import { TrackTable } from "./TrackTable";
import { useT } from "./i18n";
import { useSubtitleDefault } from "./settings";


// Height of the detail's body below which the chart and the waveforms are
// shown one at a time (the Segments / Écoute tabs).
const COMPACT_ANALYSIS_HEIGHT = 480;

/** "S01E01 VO.mkv" -> "S01E01 VO": a pair named after its reference. */
const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/** "@1 fre", or "@1" while its file's tracks aren't read. */
const trackLabel = (index: number, track: TrackInfo | undefined) => (track?.language ? `@${index} ${track.language}` : `@${index}`);

/** A pair's own tracks, picked in its detail instead of the top bar's. */
interface PairTracks {
  reference: number;
  candidate: number;
}

/** A pair's tracks, both files' in one table: which file each comes from,
 * then the reference picked among the reference file's and the track to
 * correct among the other's (the same track can't be both: they're from
 * two files, even when it's the same file twice). */
function PairTrackTable({
  referenceTracks,
  candidateTracks,
  reference,
  candidate,
  disabled,
  onReference,
  onCandidate,
}: {
  referenceTracks: TrackInfo[] | undefined;
  candidateTracks: TrackInfo[] | undefined;
  reference: number;
  candidate: number;
  disabled: boolean;
  onReference: (index: number) => void;
  onCandidate: (index: number) => void;
}) {
  const m = useT();
  const rows = (side: "ref" | "cand", tracks: TrackInfo[] | undefined) =>
    tracks?.map((tr) => (
      <tr key={`${side}-${tr.index}`} title={tr.title ? m.tracks.titled(tr.title) : undefined}>
        <td>
          <span className={`pair-row-kind pair-row-kind-${side}`}>{side === "ref" ? m.pairs.refShort : m.pairs.candShort}</span>
        </td>
        <td>@{tr.index}</td>
        <td>{tr.language ?? "?"}</td>
        <td>{tr.codec ?? "?"}</td>
        <td className="track-pick">
          {side === "ref" && (
            <input type="radio" name="pair-reference" checked={reference === tr.index} disabled={disabled} onChange={() => onReference(tr.index)} />
          )}
        </td>
        <td className="track-pick">
          {side === "cand" && (
            <input type="radio" name="pair-candidate" checked={candidate === tr.index} disabled={disabled} onChange={() => onCandidate(tr.index)} />
          )}
        </td>
      </tr>
    ));
  return (
    <table className="batch-tracks-table">
      <thead>
        <tr>
          <th>{m.pairs.fileColumn}</th>
          <th>{m.tracks.track}</th>
          <th>{m.tracks.language}</th>
          <th>{m.tracks.codec}</th>
          <th className="track-pick">{m.tracks.referenceShort}</th>
          <th className="track-pick">{m.common.toCorrect}</th>
        </tr>
      </thead>
      <tbody>
        {rows("ref", referenceTracks)}
        {rows("cand", candidateTracks)}
      </tbody>
    </table>
  );
}

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
    <span className="config-field">
      {m.common.labelled(label)}
      {tracks && tracks.length > 0 ? (
        <select value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled} aria-label={label}>
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
          aria-label={label}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        />
      )}
      {loading && <span className="batch-track-status">{m.pairs.probing}</span>}
      {error && (
        <span className="batch-track-status batch-track-status-error" title={error}>
          {m.pairs.tracksUnavailable}
        </span>
      )}
    </span>
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
                  <div className="tracks-table-wrap">
                    <TrackTable className="batch-tracks-table" tracks={entry.tracks} showChannels />
                  </div>
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
 * Laid out as a list of pairs (both files, each movable within its own
 * column) beside the selected pair's detail: its chart, waveforms and
 * listening, its own Analyser / Exporter cette paire. With no file yet,
 * two drop zones, one per column.
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
  // Pairs whose tracks were picked in their detail (by both files), instead
  // of the top bar's.
  const [pairTracks, setPairTracks] = useState<Record<string, PairTracks>>({});
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
  // The row shown in the detail.
  const [selected, setSelected] = useState(0);
  // The detail's files, read once each (their tracks' languages and start
  // times, for its title and the waveforms' container-delay note).
  const [probes, setProbes] = useState<Record<string, ProbeResponse>>({});
  const [analysisViewRef, analysisViewSize] = useElementSize<HTMLDivElement>();
  const [analysisView, setAnalysisView] = useState<"segments" | "listen">("listen");

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

  function addFiles(setFiles: (update: (files: string[]) => string[]) => void, title: string) {
    return async () => {
      const selected = await pickMediaFiles(true, title);
      if (selected) setFiles((files) => [...files, ...selected]);
    };
  }

  const pairCount = Math.min(referenceFiles.length, candidateFiles.length);
  const rowCount = Math.max(referenceFiles.length, candidateFiles.length);

  /** Row `i`'s files, which its own tracks (pairTracks) are kept by. */
  const filesKey = (i: number) => JSON.stringify([referenceFiles[i], candidateFiles[i]]);
  /** Row `i`'s tracks: its own if picked in its detail, else the top bar's. */
  function tracksOf(i: number): [number, number] {
    const own = pairTracks[filesKey(i)];
    return own ? [own.reference, own.candidate] : [referenceTrackIndex, candidateTrackIndex];
  }

  /** Row `i`'s pair as it stands: both files and both tracks. */
  function pairKey(i: number): string {
    const [referenceTrack, candidateTrack] = tracksOf(i);
    return JSON.stringify([referenceFiles[i], referenceTrack, candidateFiles[i], candidateTrack]);
  }
  const analysisOf = (i: number): PairAnalysis | undefined => (i < pairCount ? analyses[pairKey(i)] : undefined);
  const isDone = (a: PairAnalysis | undefined) => a?.status === "done" && !!a.result;

  function updatePair(key: string, patch: Partial<PairAnalysis> | ((entry: PairAnalysis) => Partial<PairAnalysis>)) {
    setAnalyses((current) =>
      current[key] ? { ...current, [key]: { ...current[key], ...(typeof patch === "function" ? patch(current[key]) : patch) } } : current,
    );
  }

  // The detail always shows a row while there are some.
  useEffect(() => {
    if (selected >= rowCount) setSelected(Math.max(0, rowCount - 1));
  }, [selected, rowCount]);

  const detailReference: string | undefined = referenceFiles[selected];
  const detailCandidate: string | undefined = candidateFiles[selected];
  useEffect(() => {
    for (const path of [detailReference, detailCandidate]) {
      if (!path || probes[path]) continue;
      probe(path)
        .then((res) => setProbes((c) => ({ ...c, [path]: res })))
        .catch(() => {
          // informational only: the title goes without the languages
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- probes is a cache, not an input
  }, [detailReference, detailCandidate]);

  /** Analyzes the pairs that aren't yet (new ones, failed ones), keeping the
   * rest and any edit made to them; or all of them again (`all`). */
  async function handleAnalyze(all: boolean) {
    await runPlan(Array.from({ length: pairCount }, (_, i) => i).filter((i) => all || !isDone(analyses[pairKey(i)])));
  }

  /** Analyzes these pairs (by row), each one's result and edits replaced. */
  async function runPlan(rows: number[]) {
    setAnalyzing(true);
    const plan = rows.map((i) => ({ key: pairKey(i), reference: referenceFiles[i], candidate: candidateFiles[i], tracks: tracksOf(i) }));
    setAnalyses((current) => {
      const next = { ...current };
      for (const { key } of plan) next[key] = { status: "pending", result: null, error: null, log: [], ...IDLE_EXPORT };
      return next;
    });
    for (const { key, reference, candidate, tracks: [referenceTrack, candidateTrack] } of plan) {
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
   * them. Every pair, or row `only` ("Exporter cette paire"). */
  function handleExport(only?: number) {
    queue.run(
      pairAnalyses.flatMap((a, i) => {
        if (!isDone(a) || (only !== undefined && i !== only)) return [];
        const key = pairKey(i);
        const [referenceTrack, candidateTrack] = tracksOf(i);
        return [
          {
            input: referenceFiles[i],
            start: async (outputPath: string) => {
              // The candidate file's subtitles in its audio's language come
              // along, retimed with it (per the subtitle setting).
              const candidate = subsMode === "none" ? null : await probe(candidateFiles[i]);
              const audioLanguage =
                candidate?.tracks.find((t) => t.index === candidateTrack)?.language || candidateLanguage || null;
              return startCrossFileSegmentedRenderJob(
                referenceFiles[i],
                referenceTrack,
                candidateFiles[i],
                candidateTrack,
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
    const [referenceTrack, candidateTrack] = tracksOf(editingPairIndex);
    Promise.all([probe(referenceFiles[editingPairIndex]), probe(candidateFiles[editingPairIndex])])
      .then(([ref, cand]) => {
        if (cancelled) return;
        setEditStartTimes({
          reference: ref.tracks.find((t) => t.index === referenceTrack)?.start_time,
          track: cand.tracks.find((t) => t.index === candidateTrack)?.start_time,
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

  /** A row's badge: what's running first, then what's wrong, then how far it got. */
  function pairBadge(i: number): [string, BadgeKind] {
    const st = m.pairs.status;
    if (i >= pairCount) return [st.unpaired, "error"];
    const a = analysisOf(i);
    if (a?.exportStatus === "running") return [st.exporting, "running"];
    if (a?.status === "running") return [st.running, "running"];
    if (a?.status === "pending") return [st.pending, "queued"];
    if (a?.exportStatus === "done") return [st.exported, "exported"];
    if (a?.exportStatus === "error") return [st.exportFailed, "error"];
    if (a?.status === "error") return [st.failed, "error"];
    if (isDone(a)) return a?.exportStatus === "cancelled" ? [st.cancelled, "analyzed"] : [st.analyzed, "analyzed"];
    return [st.toAnalyze, "idle"];
  }

  // The detail: the selected row.
  const detailPaired = selected < pairCount;
  const detailRun = analysisOf(selected);
  const detailResult = isDone(detailRun) ? detailRun!.result : null;
  const detailAnalyzing = detailRun?.status === "pending" || detailRun?.status === "running";
  const detailKey = detailPaired ? pairKey(selected) : "";
  const [detailReferenceIndex, detailCandidateIndex] = tracksOf(selected);
  const detailOwnTracks = detailPaired && !!pairTracks[filesKey(selected)];
  const detailReferenceTrack = detailReference ? probes[detailReference]?.tracks.find((t) => t.index === detailReferenceIndex) : undefined;
  const detailCandidateTrack = detailCandidate ? probes[detailCandidate]?.tracks.find((t) => t.index === detailCandidateIndex) : undefined;

  /** A pick in the detail's table: from then on the pair has its own tracks. */
  function pickTracks(update: (tracks: PairTracks) => PairTracks) {
    const key = filesKey(selected);
    setPairTracks((c) => ({ ...c, [key]: update(c[key] ?? { reference: detailReferenceIndex, candidate: detailCandidateIndex }) }));
  }
  const compactAnalysis = analysisViewSize.height > 0 && analysisViewSize.height < COMPACT_ANALYSIS_HEIGHT;

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
        <span className="config-field">
          {m.pairs.language}
          <LanguageSelect
            label={m.pairs.language}
            value={candidateLanguage}
            onChange={setCandidateLanguage}
            extra={candidateProbe.tracks?.map((t) => t.language) ?? []}
            emptyLabel={m.pairs.fileLanguage(
              candidateProbe.tracks?.find((t) => t.index === candidateTrackIndex)?.language ?? null,
            )}
            disabled={busy}
          />
          <InfoTip>{m.pairs.languageHint}</InfoTip>
        </span>
        <span className="config-field">
          {m.common.labelled(m.batch.subtitles)}
          <select
            value={subsMode}
            onChange={(e) => setSubsMode(e.target.value as SubtitleMode)}
            disabled={busy}
            aria-label={m.batch.subtitles}
          >
            {SUBTITLE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {m.subtitles.modes[mode]}
              </option>
            ))}
          </select>
        </span>
        <InfoTip>{m.pairs.hint}</InfoTip>
      </div>

      {rowCount === 0 ? (
        <section className="panel pairs-empty">
          <div className="pairs-empty-intro">
            <h3>{m.pairs.emptyTitle}</h3>
            <p>{m.pairs.emptyHint}</p>
          </div>
          <div className="pairs-empty-zones">
            <DropZone title={m.pairs.dropReferences} disabled={dropBlocked !== null} onClick={addFiles(setReferenceFiles, m.pairs.pickReferences)}>
              {m.pairs.dropReferencesHint}
            </DropZone>
            <DropZone title={m.pairs.dropCandidates} disabled={dropBlocked !== null} onClick={addFiles(setCandidateFiles, m.pairs.pickCandidates)}>
              {m.pairs.dropCandidatesHint}
            </DropZone>
          </div>
        </section>
      ) : (
        <div className="workspace workspace-pairs">
          <section className="panel file-list">
            <div className="file-list-header">
              <h2>
                {m.pairs.pairsCount(pairCount)} <InfoTip>{m.pairs.pairsHint}</InfoTip>
              </h2>
              <button className="small-button" onClick={() => setShowTracksModal(true)}>
                {m.pairs.checkAllTracks}
              </button>
              <button
                className="small-button"
                onClick={() => {
                  setReferenceFiles([]);
                  setCandidateFiles([]);
                  setAnalyses({});
                  setPairTracks({});
                }}
                disabled={busy}
              >
                {m.common.removeAll}
              </button>
            </div>

            <ul className="file-list-rows list-scroll">
              {Array.from({ length: rowCount }, (_, i) => {
                const a = analysisOf(i);
                const [badge, badgeKind] = pairBadge(i);
                return (
                  <PairRow
                    key={i}
                    label={m.pairs.pairTitle(i + 1, basename(referenceFiles[i] ?? candidateFiles[i]))}
                    reference={{ name: basename(referenceFiles[i] ?? ""), path: referenceFiles[i], missing: m.pairs.noReference }}
                    candidate={{ name: basename(candidateFiles[i] ?? ""), path: candidateFiles[i], missing: m.pairs.noCandidate }}
                    referenceActions={
                      <MoveButtons count={referenceFiles.length} index={i} disabled={busy} onChange={(update) => setReferenceFiles(update)} />
                    }
                    candidateActions={
                      <MoveButtons count={candidateFiles.length} index={i} disabled={busy} onChange={(update) => setCandidateFiles(update)} />
                    }
                    state={rowState(i < pairCount ? [a] : [], a?.exportStatus, i >= pairCount)}
                    badge={badge}
                    badgeKind={badgeKind}
                    selected={i === selected}
                    onSelect={() => setSelected(i)}
                  />
                );
              })}
            </ul>
            <div className="pair-add">
              <button disabled={busy} title={m.pairs.addReferenceHint} onClick={addFiles(setReferenceFiles, m.pairs.pickReferences)}>
                <span>{m.pairs.addReferences}</span>
                <span>{m.pairs.dropLeft}</span>
              </button>
              <button disabled={busy} title={m.pairs.addCandidateHint} onClick={addFiles(setCandidateFiles, m.pairs.pickCandidates)}>
                <span>{m.pairs.addCandidates}</span>
                <span>{m.pairs.dropRight}</span>
              </button>
            </div>
          </section>

          <section className="panel file-detail">
            <div className="detail-header">
              <div className="detail-title">
                <span className="detail-name" title={detailReference ?? detailCandidate}>
                  {m.pairs.pairTitle(selected + 1, stem(basename(detailReference ?? detailCandidate ?? "")))}
                </span>
                {detailPaired && (
                  <span className="detail-meta">
                    {m.pairs.pairMeta(
                      trackLabel(detailReferenceIndex, detailReferenceTrack),
                      basename(detailReference!),
                      trackLabel(detailCandidateIndex, detailCandidateTrack),
                      basename(detailCandidate!),
                    )}
                  </span>
                )}
              </div>
              {detailPaired && (detailRun?.status === "done" || detailRun?.status === "error") && (
                <Tooltip text={m.batch.reanalyzeOneHint}>
                  <button
                    className="icon-small-button detail-icon-button"
                    disabled={busy || blocked}
                    onClick={() => runPlan([selected])}
                    aria-label={m.batch.reanalyzeOne}
                  >
                    <RedoIcon />
                  </button>
                </Tooltip>
              )}
              {detailResult && (
                <button disabled={queue.exporting} onClick={() => setEditingPairIndex(selected)}>
                  {m.single.editSegments}
                </button>
              )}
              {/* One gradient button: the pair's next step. */}
              {detailPaired && !detailResult && (
                <button
                  className="primary-button"
                  disabled={detailAnalyzing || busy || blocked}
                  title={blocked ? m.batch.otherModeBusy : m.pairs.analyzePairHint}
                  onClick={() => runPlan([selected])}
                >
                  {detailAnalyzing ? m.common.analysisRunning : m.multi.analyzeFile}
                </button>
              )}
              {detailResult && (
                <button
                  className="primary-button"
                  disabled={busy || blocked}
                  title={blocked ? m.batch.otherModeBusy : undefined}
                  onClick={() => handleExport(selected)}
                >
                  {m.pairs.exportPair}
                </button>
              )}
            </div>

            {!detailPaired && <p className="placeholder">{m.pairs.unpairedDetail}</p>}
            {detailPaired && (
              <div className="detail-body" ref={analysisViewRef}>
                {/* Too little height for all at once: the tracks and the
                    chart, or the waveforms, as tabs. */}
                {compactAnalysis && detailResult && (
                  <div className="detail-tabs">
                    <PillSwitch
                      className="view-switch"
                      label={m.common.view}
                      options={[
                        ["segments", m.common.segments],
                        ["listen", m.common.listen],
                      ]}
                      value={analysisView}
                      onChange={setAnalysisView}
                    />
                  </div>
                )}
                <div
                  className={
                    compactAnalysis && detailResult && analysisView === "listen"
                      ? "view-hidden"
                      : `detail-top${compactAnalysis && detailResult ? " detail-top-fill" : ""}`
                  }
                >
                  <div className="detail-tracks">
                    <div className="detail-heading">
                      <h3>
                        {m.multi.tracks} <InfoTip>{m.pairs.tracksHint}</InfoTip>
                      </h3>
                      {detailOwnTracks && <span className="list-row-manual">{m.multi.manual}</span>}
                      {detailOwnTracks && (
                        <button
                          className="small-button"
                          disabled={busy}
                          title={m.pairs.byDefaultHint}
                          onClick={() =>
                            setPairTracks((c) => {
                              const next = { ...c };
                              delete next[filesKey(selected)];
                              return next;
                            })
                          }
                        >
                          {m.pairs.byDefault}
                        </button>
                      )}
                    </div>
                    <div className="tracks-table-wrap list-scroll detail-tracks-table">
                      <PairTrackTable
                        referenceTracks={probes[detailReference!]?.tracks}
                        candidateTracks={probes[detailCandidate!]?.tracks}
                        reference={detailReferenceIndex}
                        candidate={detailCandidateIndex}
                        disabled={busy}
                        onReference={(index) => pickTracks((t) => ({ ...t, reference: index }))}
                        onCandidate={(index) => pickTracks((t) => ({ ...t, candidate: index }))}
                      />
                    </div>
                  </div>
                  <div className="detail-chart">
                    <div className="detail-heading">
                      <h3>{m.common.segments}</h3>
                      <span className="detail-heading-summary">{detailResult && describeSegments(detailResult.segments)}</span>
                    </div>
                    {detailResult ? (
                      <SegmentChart segments={detailResult.segments} fill={compactAnalysis} />
                    ) : (
                      // Its room kept while there's nothing to draw yet.
                      <SegmentChartPlaceholder>
                        {!detailRun && <p className="placeholder">{m.multi.notAnalyzed}</p>}
                        {detailRun?.status === "pending" && <p className="placeholder">{m.batch.pending}</p>}
                        {detailRun?.status === "running" && (
                          <p className="placeholder detail-running">
                            <span className="spinner spinner-small" />
                            {m.common.analysisRunning}
                          </p>
                        )}
                        {detailRun?.status === "error" && <p className="error">{detailRun.error ?? m.common.error}</p>}
                        <LogPanel lines={detailRun?.log ?? []} />
                      </SegmentChartPlaceholder>
                    )}
                  </div>
                </div>
                {/* Not while it's being edited: the editor has its own
                    preview, and two playing at once would overlap. */}
                {detailResult && editingPairIndex !== selected && (
                  <div className={compactAnalysis && analysisView !== "listen" ? "view-hidden" : "segments-result"}>
                    <TrackPreview
                      key={detailKey}
                      referenceFilePath={detailReference!}
                      candidateFilePath={detailCandidate!}
                      referenceIndex={detailReferenceIndex}
                      trackIndex={detailCandidateIndex}
                      segments={detailResult.segments}
                      referenceStartTime={detailReferenceTrack?.start_time ?? 0}
                      trackStartTime={detailCandidateTrack?.start_time ?? 0}
                      extraControls={<LogPanel lines={detailRun?.log ?? []} />}
                    />
                  </div>
                )}
              </div>
            )}

            <DetailExport entry={detailRun} />
          </section>
        </div>
      )}

      <BatchFooter
        outputDir={outputDir}
        onOutputDirChange={onOutputDirChange}
        busy={busy}
        blocked={blocked}
        progress={
          <>
            {m.pairs.progressPairs(pairCount)}
            {m.pairs.progressAnalyzed(analyzedCount, pairCount)}
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
            onAnalyze={(all) => handleAnalyze(all)}
          />
        }
        queue={queue}
        canExport={analyzedCount > 0}
        onExport={() => handleExport()}
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
            referenceIndex: tracksOf(editingPairIndex)[0],
            trackIndex: tracksOf(editingPairIndex)[1],
            referenceStartTime: editStartTimes.reference,
            trackStartTime: editStartTimes.track,
          }}
        />
      )}
      <DropOverlay
        drag={fileDrag}
        blocked={dropBlocked}
        split={[m.pairs.pickReferences, m.pairs.pickCandidates]}
        hint={m.files.folderHint}
      />
    </main>
  );
}

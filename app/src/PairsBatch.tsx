import { useEffect, useMemo, useState } from "react";
import {
  probe,
  startSegmentsJob,
  startCrossFileSegmentedRenderJob,
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
import { InfoTip } from "./InfoTip";
import { Select } from "./Dropdown";
import { ALL_TRACKS, defaultPick, keyName, matchesAny, matchesKey, trackOptions, TrackFilterPicker, type TrackKey } from "./TrackFilter";
import { EmptyWorkspace, ModeCards, MoveButtons, PairRow, runBadge, useProbes, type BadgeKind, type BatchMode } from "./Workspace";
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
import { SegmentEditor } from "./SegmentEditor";
import { DropZone } from "./DropZone";
import { pickMediaFiles } from "./mediaDialog";
import { DropOverlay, useFileDrop } from "./FileDrop";
import { basename } from "./paths";
import { assignSubtitles, SUBTITLE_MODES, subtitlesFor, type SubtitleMode } from "./subtitles";
import { devParam, errorMessage, toggled } from "./util";
import { Dialog, DialogHeader } from "./Dialog";
import { TrackTable } from "./TrackTable";
import { useT } from "./i18n";
import { useSubtitleDefault } from "./settings";


/** "S01E01 VO.mkv" -> "S01E01 VO": a pair named after its reference. */
const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/** "@1 fre", or "@1" while its file's tracks aren't read. */
const trackLabel = (index: number, track: TrackInfo | undefined) => (track?.language ? `@${index} ${track.language}` : `@${index}`);

/** A pair's tracks: its reference, and the tracks of its other file to
 * correct (each analyzed on its own, all added by its one export). */
interface PairTracks {
  reference: number;
  candidates: number[];
  /** The file to correct's subtitle tracks retimed with each corrected
   * track, picked by hand ("Changer"); absent: per the subtitle setting. */
  subtitles?: Record<number, number[]>;
}

/** A pair's tracks, both files' in one table: which file each comes from,
 * then the reference picked among the reference file's and the tracks to
 * correct ticked among the other's (the same track can't be both: they're
 * from two files, even when it's the same file twice). */
function PairTrackTable({
  referenceTracks,
  candidateTracks,
  reference,
  candidates,
  disabled,
  onReference,
  onToggleCandidate,
}: {
  referenceTracks: TrackInfo[] | undefined;
  candidateTracks: TrackInfo[] | undefined;
  reference: number;
  candidates: number[];
  disabled: boolean;
  onReference: (index: number) => void;
  onToggleCandidate: (index: number) => void;
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
            <input type="checkbox" checked={candidates.includes(tr.index)} disabled={disabled} onChange={() => onToggleCandidate(tr.index)} />
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
  onModeChange,
  outputDir,
  onOutputDirChange,
  blocked,
  onBusyChange,
}: {
  hidden: boolean;
  /** Switches to multitrack mode, from the empty workspace's cards. */
  onModeChange?: (mode: BatchMode) => void;
  outputDir: string | null;
  onOutputDirChange: (dir: string | null) => void;
  /** The other batch mode is working: nothing starts here meanwhile. */
  blocked: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const m = useT();
  const [referenceFiles, setReferenceFiles] = useState<string[]>([]);
  const [candidateFiles, setCandidateFiles] = useState<string[]>([]);
  // What the top bar picks for every pair (see TrackFilter): the reference
  // in the reference file, the tracks to correct in the other one (any
  // track one of these names).
  const [referenceKey, setReferenceKey] = useState<TrackKey>("");
  const [candidateKeys, setCandidateKeys] = useState<TrackKey[]>([]);
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
  // Keyed by what each was made of (trackKey: one corrected track; pairKey:
  // a pair's export), not by row: moving files, adding more or picking other
  // tracks never shows a pair another one's, and one that comes back finds
  // its own again.
  const [analyses, setAnalyses] = useState<Record<string, AnalysisRun>>({});
  const [exports, setExports] = useState<Record<string, ExportFields>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const queue = useExportQueue(outputDir);
  const [showTracksModal, setShowTracksModal] = useState(false);
  // The corrected track open in the segment editor, and its pair's row.
  const [editing, setEditing] = useState<{ row: number; track: number } | null>(null);
  // Which corrected track each pair's tabs show (by its files; absent: its first).
  const [shownTracks, setShownTracks] = useState<Record<string, number>>({});
  // The row whose retimed subtitles are being changed ("Changer").
  const [subsEditing, setSubsEditing] = useState<number | null>(null);
  // The row shown in the detail.
  const [selected, setSelected] = useState(0);
  // Every listed file, read once as soon as it's listed: its tracks (the
  // detail's table and title, the waveforms' container-delay note), or why
  // it can't be read (its pair is flagged, as a multitrack file is).
  const probes = useProbes(useMemo(() => [...referenceFiles, ...candidateFiles], [referenceFiles, candidateFiles]));
  const view = useDetailView();

  // The picks start out from the first pair's files (see defaultPick). Only
  // while none is set, so a pick of the user's is never overridden.
  const firstReference = probes[referenceFiles[0]]?.tracks;
  const firstCandidate = probes[candidateFiles[0]]?.tracks;
  useEffect(() => {
    if (referenceKey || !firstReference?.length || !firstCandidate?.length) return;
    const pick = defaultPick(firstReference, firstCandidate);
    setReferenceKey(pick.reference);
    setCandidateKeys(pick.targets);
  }, [firstReference, firstCandidate, referenceKey]);

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
  /** Row `i`'s tracks as the top bar picks them in its two files: the
   * reference (its file's first track when the pick names none or several
   * of them: "(auto)"), the tracks to correct, and what a ticked entry
   * should name but can't (⚠). Nothing until both files are read. */
  function picked(i: number): PairTracks & { auto: boolean; issues: string[] } {
    const referenceTracks = probes[referenceFiles[i]]?.tracks ?? [];
    const candidateTracks = probes[candidateFiles[i]]?.tracks ?? [];
    const matches = referenceKey ? referenceTracks.filter((t) => matchesKey(t, referenceKey)) : [];
    return {
      reference: (matches[0] ?? referenceTracks[0])?.index ?? 0,
      candidates: candidateTracks.filter((t) => matchesAny(t, candidateKeys)).map((t) => t.index),
      auto: referenceTracks.length > 0 && matches.length !== 1,
      issues:
        candidateTracks.length === 0
          ? []
          : candidateKeys
              .filter((key) => key !== ALL_TRACKS && !candidateTracks.some((t) => matchesKey(t, key)))
              .map((key) => m.multi.noTrack(keyName(key))),
    };
  }
  /** Row `i`'s tracks: its own if picked in its detail, else the top bar's. */
  function tracksOf(i: number): PairTracks {
    return pairTracks[filesKey(i)] ?? picked(i);
  }
  /** Both of row `i`'s files are read. */
  const probed = (i: number) => !!probes[referenceFiles[i]] && !!probes[candidateFiles[i]];

  /** One corrected track of row `i` as it stands: both files and both tracks. */
  function trackKey(i: number, track: number): string {
    return JSON.stringify([referenceFiles[i], tracksOf(i).reference, candidateFiles[i], track]);
  }
  /** The subtitle tracks of row `i`'s file to correct retimed with each of
   * its corrected tracks: picked by hand, or per the subtitle setting (each
   * track's language's; "Langue ajoutée" for a pair's only one without
   * any). One subtitle track goes with one audio track at most. */
  function subsOf(i: number): Record<number, number[]> {
    const { candidates, subtitles: picked } = tracksOf(i);
    const probed = probes[candidateFiles[i]];
    const fallback = candidates.length === 1 ? candidateLanguage || null : null;
    return assignSubtitles(
      candidates.map((index) => ({ index })),
      (t) =>
        picked?.[t.index] ??
        subtitlesFor(probed?.subtitles ?? [], probed?.tracks?.find((tr) => tr.index === t.index)?.language || fallback, subsMode),
    );
  }

  /** A change to row `i`'s tracks or subtitles: from then on they're its own. */
  function editPairTracks(i: number, update: (tracks: PairTracks) => PairTracks) {
    const key = filesKey(i);
    const { reference, candidates, subtitles } = tracksOf(i);
    setPairTracks((c) => ({ ...c, [key]: update(c[key] ?? { reference, candidates, subtitles }) }));
  }

  /** Row `i`'s pair as it stands, for its export: every track it corrects. */
  function pairKey(i: number): string {
    const { reference, candidates } = tracksOf(i);
    // The subtitles it carries too: another pick makes its last export stale.
    return JSON.stringify([referenceFiles[i], reference, candidateFiles[i], [...candidates].sort((a, b) => a - b), subsOf(i)]);
  }
  const runOf = (i: number, track: number): AnalysisRun | undefined => (i < pairCount ? analyses[trackKey(i, track)] : undefined);
  const runsOf = (i: number) => tracksOf(i).candidates.map((track) => runOf(i, track));
  const exportOf = (i: number): ExportFields | undefined => (i < pairCount ? exports[pairKey(i)] : undefined);
  const isDone = (a: AnalysisRun | undefined) => a?.status === "done" && !!a.result;
  /** Row `i`'s corrected tracks whose analysis succeeded: what its export holds. */
  const doneTracks = (i: number) => tracksOf(i).candidates.filter((track) => isDone(runOf(i, track)));
  /** Every track row `i` corrects is analyzed. */
  const pairDone = (i: number) => tracksOf(i).candidates.length > 0 && doneTracks(i).length === tracksOf(i).candidates.length;

  function updateRun(key: string, patch: Partial<AnalysisRun> | ((entry: AnalysisRun) => Partial<AnalysisRun>)) {
    setAnalyses((current) =>
      current[key] ? { ...current, [key]: { ...current[key], ...(typeof patch === "function" ? patch(current[key]) : patch) } } : current,
    );
  }

  function updateExport(key: string, patch: (entry: ExportFields) => Partial<ExportFields>) {
    setExports((current) => {
      const entry = current[key] ?? IDLE_EXPORT;
      return { ...current, [key]: { ...entry, ...patch(entry) } };
    });
  }

  // The detail always shows a row while there are some.
  useEffect(() => {
    if (selected >= rowCount) setSelected(Math.max(0, rowCount - 1));
  }, [selected, rowCount]);

  const detailReference: string | undefined = referenceFiles[selected];
  const detailCandidate: string | undefined = candidateFiles[selected];
  /** Why row `i`'s files can't be read, if one can't. */
  const unreadable = (i: number): string[] =>
    [...new Set([referenceFiles[i], candidateFiles[i]])].flatMap((path) => (path && probes[path]?.error ? [probes[path].error] : []));

  /** Analyzes the corrected tracks that aren't yet (new pairs, new tracks,
   * failed ones), keeping the rest and any edit made to them; or all of
   * them again (`all`); of every pair, or of row `only` (its "Analyser"). */
  async function handleAnalyze(all: boolean, only?: number) {
    await runPlan(
      Array.from({ length: pairCount }, (_, i) => i).flatMap((i) =>
        (only === undefined || i === only) && unreadable(i).length === 0
          ? tracksOf(i)
              .candidates.filter((track) => all || !isDone(runOf(i, track)))
              .map((track) => ({ row: i, track }))
          : [],
      ),
    );
  }

  /** Analyzes these corrected tracks, each one's result and edits replaced;
   * their pairs' last exports no longer match. */
  async function runPlan(items: { row: number; track: number }[]) {
    setAnalyzing(true);
    const plan = items.map(({ row, track }) => ({
      key: trackKey(row, track),
      exportKey: pairKey(row),
      reference: referenceFiles[row],
      referenceTrack: tracksOf(row).reference,
      candidate: candidateFiles[row],
      track,
    }));
    setAnalyses((current) => {
      const next = { ...current };
      for (const { key } of plan) next[key] = { status: "pending", result: null, error: null, log: [] };
      return next;
    });
    setExports((current) => {
      const next = { ...current };
      for (const { exportKey } of plan) next[exportKey] = IDLE_EXPORT;
      return next;
    });
    for (const { key, reference, referenceTrack, candidate, track } of plan) {
      updateRun(key, { status: "running" });
      try {
        const result = await runJob<SegmentsResponse>(
          startSegmentsJob(reference, referenceTrack, candidate, track),
          (message) => updateRun(key, (a) => ({ log: [...a.log, message] })),
        );
        updateRun(key, { status: "done", result });
        preloadWaveforms(reference, referenceTrack, candidate, track);
      } catch (err) {
        updateRun(key, { status: "error", error: errorMessage(err) });
      }
    }
    setAnalyzing(false);
  }

  const pairRows = Array.from({ length: pairCount }, (_, i) => i);
  const analyzedCount = pairRows.filter(pairDone).length;
  const exportedCount = pairRows.filter((i) => exportOf(i)?.exportStatus === "done").length;
  const canExport = pairRows.some((i) => doneTracks(i).length > 0);

  /** Exports every successfully-analyzed pair, in the order analyzed --
   * pairs that failed detection or never ran are left alone (exportStatus
   * stays "idle") rather than attempted, since there's no segment list to
   * render from. Uses each pair's current `result.segments`, which is
   * exactly what "Modifier" lets the user hand-adjust first -- export
   * must reflect a reviewed edit, not silently re-run detection and
   * discard it. Both buttons are
   * disabled while *either* operation runs, not just their own: export
   * reads `analyses` as it currently stands, so a concurrent re-analysis
   * could rewrite a pair's segments out from under an export already using
   * them. Every pair, or row `only` ("Exporter cette paire"). */
  function handleExport(only?: number) {
    queue.run(
      pairRows.flatMap((i) => {
        const done = doneTracks(i);
        if (done.length === 0 || (only !== undefined && i !== only)) return [];
        const key = pairKey(i);
        const { reference } = tracksOf(i);
        // "Langue ajoutée" names a pair's one corrected track; several keep their own.
        const language = done.length === 1 ? candidateLanguage || null : null;
        return [
          {
            input: referenceFiles[i],
            start: (outputPath: string) => {
              const subtitles = subsOf(i);
              return startCrossFileSegmentedRenderJob(
                referenceFiles[i],
                reference,
                candidateFiles[i],
                done.map((track) => ({
                  trackIndex: track,
                  segments: analyses[trackKey(i, track)].result!.segments,
                  language,
                  subtitles: subtitles[track] ?? [],
                })),
                outputPath,
              );
            },
            update: (patch: (e: ExportFields) => Partial<ExportFields>) => updateExport(key, patch),
          },
        ];
      }),
    );
  }

  const busy = analyzing || queue.exporting;

  // Dropped on the left half: reference files; on the right: files to correct.
  const dropBlocked = dropBlockedReason(busy, blocked);
  const fileDrag = useFileDrop(!hidden && !showTracksModal && subsEditing === null && editing === null, dropBlocked, (files, side) =>
    (side === "left" ? setReferenceFiles : setCandidateFiles)((current) => [...current, ...files]),
  );
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  // The files' own start times, for the editor's informational "delay
  // already in the file" note: probed when a pair is opened for editing.
  const [editStartTimes, setEditStartTimes] = useState<{ reference?: number; track?: number }>({});
  useEffect(() => {
    setEditStartTimes({});
    if (editing === null) return;
    let cancelled = false;
    const referenceTrack = tracksOf(editing.row).reference;
    Promise.all([probe(referenceFiles[editing.row]), probe(candidateFiles[editing.row])])
      .then(([ref, cand]) => {
        if (cancelled) return;
        setEditStartTimes({
          reference: ref.tracks.find((t) => t.index === referenceTrack)?.start_time,
          track: cand.tracks.find((t) => t.index === editing.track)?.start_time,
        });
      })
      .catch(() => {
        // informational only: the editor just goes without it
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the lists and tracks can't change while the editor is open
  }, [editing]);
  const editingRun = editing !== null ? runOf(editing.row, editing.track) : undefined;

  /** A row's badge: what's running first, then what's wrong, then how far it got. */
  function pairBadge(i: number): [string, BadgeKind] {
    const st = m.pairs.status;
    if (i >= pairCount) return [st.unpaired, "error"];
    if (unreadable(i).length > 0) return [m.multi.status.unreadable, "error"];
    if (!probed(i)) return [m.multi.status.reading, "idle"];
    const statuses = runsOf(i).map((a) => a?.status);
    const flagged = statuses.length === 0 || (!pairTracks[filesKey(i)] && picked(i).issues.length > 0);
    return runBadge(statuses, exportOf(i)?.exportStatus, st) ?? (flagged ? [m.multi.status.check, "warning"] : [st.toAnalyze, "idle"]);
  }

  // The detail: the selected row, and the corrected track its tabs show.
  const detailPaired = selected < pairCount;
  const detailTracks = tracksOf(selected);
  const detailOwnTracks = detailPaired && !!pairTracks[filesKey(selected)];
  const detailPicked = detailPaired && !detailOwnTracks ? picked(selected) : null;
  const shownTrack: number | undefined =
    detailTracks.candidates.find((t) => t === shownTracks[filesKey(selected)]) ?? detailTracks.candidates[0];
  const detailRun = detailPaired && shownTrack !== undefined ? runOf(selected, shownTrack) : undefined;
  const detailResult = isDone(detailRun) ? detailRun!.result : null;
  const detailAnalyzing = detailPaired && runsOf(selected).some((a) => a?.status === "pending" || a?.status === "running");
  const detailDone = detailPaired ? doneTracks(selected).length : 0;
  const detailMissing = detailPaired ? detailTracks.candidates.length - detailDone : 0;
  const detailExport = exportOf(selected);
  const detailKey = shownTrack !== undefined ? trackKey(selected, shownTrack) : "";
  const candidateInfo = (index: number) => (detailCandidate ? probes[detailCandidate]?.tracks?.find((t) => t.index === index) : undefined);
  const detailReferenceTrack = detailReference ? probes[detailReference]?.tracks?.find((t) => t.index === detailTracks.reference) : undefined;
  const shownTrackInfo = shownTrack !== undefined ? candidateInfo(shownTrack) : undefined;


  // The top bar's choices: what the files of each column offer.
  const referenceOptions = trackOptions(referenceFiles.flatMap((f) => (probes[f]?.tracks ? [probes[f].tracks!] : [])));
  const candidateOptions = trackOptions(candidateFiles.flatMap((f) => (probes[f]?.tracks ? [probes[f].tracks!] : [])));

  return (
    <main className="batch-main" style={hidden ? { display: "none" } : undefined}>
      {rowCount === 0 ? (
        <EmptyWorkspace title={m.pairs.emptyTitle} hint={m.pairs.emptyHint}>
          <div className="pairs-empty-zones">
            <DropZone title={m.pairs.dropReferences} disabled={dropBlocked !== null} onClick={addFiles(setReferenceFiles, m.pairs.pickReferences)}>
              {m.pairs.dropReferencesHint}
            </DropZone>
            <DropZone title={m.pairs.dropCandidates} disabled={dropBlocked !== null} onClick={addFiles(setCandidateFiles, m.pairs.pickCandidates)}>
              {m.pairs.dropCandidatesHint}
            </DropZone>
          </div>
          <ModeCards mode="pairs" onChange={onModeChange} />
        </EmptyWorkspace>
      ) : (
        <>
        <div className="batch-config panel">
          <span className="config-field">
            {m.multi.reference}
            <TrackFilterPicker
              label={m.common.reference}
              options={referenceOptions}
              value={referenceKey ? [referenceKey] : []}
              onChange={([key]) => setReferenceKey(key)}
              single
              disabled={busy}
            />
          </span>
          <span className="config-field">
            {m.multi.toCorrect}
            <TrackFilterPicker label={m.common.toCorrect} options={candidateOptions} value={candidateKeys} onChange={setCandidateKeys} disabled={busy} />
          </span>
          <span className="config-field">
            {m.pairs.language}
            <LanguageSelect
              label={m.pairs.language}
              value={candidateLanguage}
              onChange={setCandidateLanguage}
              extra={firstCandidate?.map((t) => t.language) ?? []}
              emptyLabel={m.pairs.fileLanguage(
                pairCount > 0 ? (firstCandidate?.find((t) => t.index === tracksOf(0).candidates[0])?.language ?? null) : null,
              )}
              disabled={busy}
            />
            <InfoTip>{m.pairs.languageHint}</InfoTip>
          </span>
          <span className="config-field">
            {m.common.labelled(m.batch.subtitles)}
            <Select
              label={m.batch.subtitles}
              value={subsMode}
              options={SUBTITLE_MODES.map((mode) => ({ value: mode, label: m.subtitles.modes[mode] }))}
              onChange={setSubsMode}
              disabled={busy}
            />
          </span>
          <InfoTip>{m.pairs.hint}</InfoTip>
        </div>

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
                    setExports({});
                    setPairTracks({});
                    // Picked again from the next files added.
                    setReferenceKey("");
                    setCandidateKeys([]);
                    setShownTracks({});
                  }}
                  disabled={busy}
                >
                  {m.common.removeAll}
                </button>
              </div>

              <ul className="file-list-rows list-scroll">
                {Array.from({ length: rowCount }, (_, i) => {
                  const [badge, badgeKind] = pairBadge(i);
                  return (
                    <PairRow
                      key={i}
                      reference={{ name: basename(referenceFiles[i] ?? ""), path: referenceFiles[i], missing: m.pairs.noReference }}
                      candidate={{ name: basename(candidateFiles[i] ?? ""), path: candidateFiles[i], missing: m.pairs.noCandidate }}
                      referenceActions={
                        <MoveButtons count={referenceFiles.length} index={i} disabled={busy} onChange={(update) => setReferenceFiles(update)} />
                      }
                      candidateActions={
                        <MoveButtons count={candidateFiles.length} index={i} disabled={busy} onChange={(update) => setCandidateFiles(update)} />
                      }
                      state={rowState(i < pairCount ? runsOf(i) : [], exportOf(i)?.exportStatus, i >= pairCount || unreadable(i).length > 0)}
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
              <DetailHeader
                title={m.pairs.pairTitle(selected + 1, stem(basename(detailReference ?? detailCandidate ?? "")))}
                titleTooltip={detailReference ?? detailCandidate}
                meta={
                  detailPaired &&
                  m.pairs.pairMeta(
                    trackLabel(detailTracks.reference, detailReferenceTrack),
                    basename(detailReference!),
                    detailTracks.candidates.map((t) => trackLabel(t, candidateInfo(t))).join(", ") || "—",
                    basename(detailCandidate!),
                  )
                }
                onReanalyze={
                  shownTrack !== undefined && (detailRun?.status === "done" || detailRun?.status === "error")
                    ? () => runPlan([{ row: selected, track: shownTrack }])
                    : undefined
                }
                onEdit={detailResult && shownTrack !== undefined ? () => setEditing({ row: selected, track: shownTrack }) : undefined}
                editDisabled={queue.exporting}
                missing={detailMissing}
                analyzing={detailAnalyzing}
                done={detailDone}
                disabled={busy || blocked}
                analyzeDisabled={unreadable(selected).length > 0}
                blockedTitle={blocked ? m.batch.otherModeBusy : undefined}
                analyzeTitle={m.pairs.analyzePairHint}
                exportLabel={m.pairs.exportPair}
                onAnalyze={() => handleAnalyze(false, selected)}
                onExport={() => handleExport(selected)}
              />

              {!detailPaired && <p className="placeholder">{m.pairs.unpairedDetail}</p>}
              {unreadable(selected).map((error) => (
                <p key={error} className="error">
                  {error}
                </p>
              ))}
              {detailPaired && unreadable(selected).length === 0 && (
                <div className="detail-body" ref={view.ref}>
                  {shownTrack !== undefined && (
                    <DetailTabs
                      tracks={detailTracks.candidates.map((t) => [String(t), trackLabel(t, candidateInfo(t))] as const)}
                      value={String(shownTrack)}
                      onChange={(t) => setShownTracks((c) => ({ ...c, [filesKey(selected)]: Number(t) }))}
                      view={view.compact && detailResult ? { value: view.view, onChange: view.setView } : undefined}
                    />
                  )}
                  <div className={view.topClass(!!detailResult)}>
                    <div className="detail-tracks">
                      <TracksHeading
                        hint={m.pairs.tracksHint}
                        auto={detailPicked?.auto ? m.multi.autoHint : undefined}
                        reset={
                          detailOwnTracks
                            ? {
                                label: m.pairs.byDefault,
                                title: m.pairs.byDefaultHint,
                                disabled: busy,
                                onClick: () =>
                                  setPairTracks((c) => {
                                    const next = { ...c };
                                    delete next[filesKey(selected)];
                                    return next;
                                  }),
                              }
                            : undefined
                        }
                      />
                      <div className="tracks-table-wrap list-scroll detail-tracks-table">
                        <PairTrackTable
                          referenceTracks={probes[detailReference!]?.tracks ?? undefined}
                          candidateTracks={probes[detailCandidate!]?.tracks ?? undefined}
                          reference={detailTracks.reference}
                          candidates={detailTracks.candidates}
                          disabled={busy}
                          onReference={(index) => editPairTracks(selected, (t) => ({ ...t, reference: index }))}
                          onToggleCandidate={(index) => editPairTracks(selected, (t) => ({ ...t, candidates: toggled(t.candidates, index) }))}
                        />
                      </div>
                      {detailPicked && detailPicked.issues.length > 0 && <span className="list-row-issues">⚠ {detailPicked.issues.join(", ")}</span>}
                      {(probes[detailCandidate!]?.subtitles.length ?? 0) > 0 && detailTracks.candidates.length > 0 && (
                        <RetimedSubs
                          subtitles={probes[detailCandidate!]!.subtitles}
                          assigned={subsOf(selected)}
                          disabled={busy}
                          onChange={() => setSubsEditing(selected)}
                        />
                      )}
                    </div>
                    <DetailChart
                      summary={detailResult && describeSegments(detailResult.segments)}
                      result={detailResult}
                      run={detailRun}
                      fill={view.compact}
                      noTrack={shownTrack === undefined ? m.pairs.noTarget : null}
                    />
                  </div>
                  {/* Not while it's being edited: the editor has its own
                      preview, and two playing at once would overlap. */}
                  {detailResult && shownTrack !== undefined && !(editing?.row === selected && editing.track === shownTrack) && (
                    <div className={view.listenClass()}>
                      <TrackPreview
                        key={detailKey}
                        referenceFilePath={detailReference!}
                        candidateFilePath={detailCandidate!}
                        referenceIndex={detailTracks.reference}
                        trackIndex={shownTrack}
                        segments={detailResult.segments}
                        referenceStartTime={detailReferenceTrack?.start_time ?? 0}
                        trackStartTime={shownTrackInfo?.start_time ?? 0}
                        extraControls={<LogPanel lines={detailRun?.log ?? []} />}
                      />
                    </div>
                  )}
                </div>
              )}

              <DetailExport entry={detailExport} />
            </section>
          </div>

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
          canExport={canExport}
          onExport={() => handleExport()}
        />
        </>
      )}

      {showTracksModal && (
        <AllTracksModal referenceFiles={referenceFiles} candidateFiles={candidateFiles} onClose={() => setShowTracksModal(false)} />
      )}

      {subsEditing !== null && subsEditing < pairCount && (
        <SubtitleChoiceDialog
          title={m.multi.subsOf(basename(candidateFiles[subsEditing]))}
          titleTooltip={candidateFiles[subsEditing]}
          tracks={tracksOf(subsEditing).candidates.map((t) => [t, trackLabel(t, probes[candidateFiles[subsEditing]]?.tracks?.find((tr) => tr.index === t))] as const)}
          subtitles={probes[candidateFiles[subsEditing]]?.subtitles ?? []}
          assigned={subsOf(subsEditing)}
          onToggle={(track, sub) =>
            editPairTracks(subsEditing, (t) => ({ ...t, subtitles: { ...t.subtitles, [track]: toggled(subsOf(subsEditing)[track] ?? [], sub) } }))
          }
          onClose={() => setSubsEditing(null)}
        />
      )}

      {editing !== null && editingRun?.result && (
        <SegmentEditor
          segments={editingRun.result.segments}
          onClose={() => setEditing(null)}
          onSave={(edited) =>
            updateRun(trackKey(editing.row, editing.track), (a) => ({ result: a.result ? { ...a.result, segments: edited } : a.result }))
          }
          preview={{
            referenceFilePath: referenceFiles[editing.row],
            candidateFilePath: candidateFiles[editing.row],
            referenceIndex: tracksOf(editing.row).reference,
            trackIndex: editing.track,
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

import { useEffect, useState } from "react";
import { loadOutputDir, saveOutputDir } from "./batchShared";
import { MultiTrackBatch } from "./MultiTrackBatch";
import { PairsBatch } from "./PairsBatch";
import "./BatchView.css";

export type BatchMode = "multi" | "pairs";

/** Batch mode: a whole series in one pass, in either of two ways -- files
 * that each hold the reference and the tracks to correct ("Fichiers
 * multipistes"), or pairs of files where the corrected track comes from
 * another file ("Paires de fichiers"). Both stay mounted, so switching
 * between them keeps each one's files and results; the output folder is
 * shared and remembered across sessions. The mode is picked in the top
 * bar's Batch drawer (App.tsx), told when one is busy.
 *
 * Always kept mounted by the caller (App.tsx) even while on the other tab
 * -- `hidden` just toggles visibility -- so switching tabs never resets
 * the imported files or analysis results. */
export function BatchView({
  hidden,
  mode,
  onBusyChange,
}: {
  hidden: boolean;
  mode: BatchMode;
  onBusyChange: (busy: boolean) => void;
}) {
  const [outputDir, setOutputDir] = useState<string | null>(loadOutputDir);
  // Which mode is analyzing or exporting: only one runs at a time, each
  // already uses every core (see batchShared's runJob).
  const [busy, setBusy] = useState<Record<BatchMode, boolean>>({ multi: false, pairs: false });

  useEffect(() => onBusyChange(busy.multi || busy.pairs), [busy, onBusyChange]);

  function changeOutputDir(dir: string | null) {
    setOutputDir(dir);
    saveOutputDir(dir);
  }

  return (
    <>
      <MultiTrackBatch
        hidden={hidden || mode !== "multi"}
        outputDir={outputDir}
        onOutputDirChange={changeOutputDir}
        blocked={busy.pairs}
        onBusyChange={(b) => setBusy((c) => (c.multi === b ? c : { ...c, multi: b }))}
      />
      <PairsBatch
        hidden={hidden || mode !== "pairs"}
        outputDir={outputDir}
        onOutputDirChange={changeOutputDir}
        blocked={busy.multi}
        onBusyChange={(b) => setBusy((c) => (c.pairs === b ? c : { ...c, pairs: b }))}
      />
    </>
  );
}

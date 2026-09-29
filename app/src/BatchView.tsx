import { useEffect, useState } from "react";
import { loadOutputDir, saveOutputDir } from "./batchShared";
import { MultiTrackBatch } from "./MultiTrackBatch";
import { PairsBatch } from "./PairsBatch";
import "./BatchView.css";

type BatchMode = "multi" | "pairs";

/** Batch mode: a whole series in one pass, in either of two ways -- files
 * that each hold the reference and the tracks to correct ("Fichiers
 * multipistes"), or pairs of files where the corrected track comes from
 * another file ("Paires de fichiers"). Both stay mounted, so switching
 * between them keeps each one's files and results; the output folder is
 * shared and remembered across sessions.
 *
 * Always kept mounted by the caller (App.tsx) even while on the other tab
 * -- `hidden` just toggles visibility -- so switching tabs never resets
 * the imported files or analysis results. */
export function BatchView({ hidden }: { hidden: boolean }) {
  const [mode, setMode] = useState<BatchMode>("multi");
  const [outputDir, setOutputDir] = useState<string | null>(loadOutputDir);

  // Dev only (stripped from production builds): pairs mode for `?batchRef=`.
  useEffect(() => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("batchRef")) setMode("pairs");
  }, []);

  function changeOutputDir(dir: string | null) {
    setOutputDir(dir);
    saveOutputDir(dir);
  }

  const modeSwitch = (
    <div className="view-tabs batch-mode" role="tablist">
      <button role="tab" aria-selected={mode === "multi"} className={mode === "multi" ? "active" : ""} onClick={() => setMode("multi")}>
        Fichiers multipistes
      </button>
      <button role="tab" aria-selected={mode === "pairs"} className={mode === "pairs" ? "active" : ""} onClick={() => setMode("pairs")}>
        Paires de fichiers
      </button>
    </div>
  );

  return (
    <>
      <MultiTrackBatch
        hidden={hidden || mode !== "multi"}
        modeSwitch={modeSwitch}
        outputDir={outputDir}
        onOutputDirChange={changeOutputDir}
      />
      <PairsBatch
        hidden={hidden || mode !== "pairs"}
        modeSwitch={modeSwitch}
        outputDir={outputDir}
        onOutputDirChange={changeOutputDir}
      />
    </>
  );
}

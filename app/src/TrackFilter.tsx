import { useEffect, useId, useRef, useState } from "react";
import type { TrackInfo } from "./api";
import { t, useT } from "./i18n";
import { languageLabel } from "./languages";
import "./TrackFilter.css";

/** Which tracks of each file a batch takes, as MKV Muxing Batch GUI picks
 * them: by number, language or name, or all of them. A key per choice:
 * "all", "index:2", "lang:fre", "name:Français (forcé)". Track numbers and
 * names suit files without languages, or two tracks of one language (a VFF
 * and a VFQ); languages, a track order that changes between episodes. */
export type TrackKey = string;

export const ALL_TRACKS: TrackKey = "all";
export const indexKey = (index: number): TrackKey => `index:${index}`;
export const languageKey = (code: string): TrackKey => `lang:${code}`;

function split(key: TrackKey): [string, string] {
  const at = key.indexOf(":");
  return at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
}

/** Whether `track` is one `key` names. */
export function matchesKey(track: TrackInfo, key: TrackKey): boolean {
  const [kind, value] = split(key);
  if (kind === "all") return true;
  if (kind === "index") return track.index === Number(value);
  if (kind === "lang") return (track.language ?? "") === value;
  if (kind === "name") return (track.title ?? "") === value;
  return false;
}

/** Whether `track` is one of those `keys` name (any of them). */
export const matchesAny = (track: TrackInfo, keys: TrackKey[]) => keys.some((key) => matchesKey(track, key));

/** What `key` names, short: "@2", "fre", "« Français »" -- for "aucune piste …". */
export function keyName(key: TrackKey): string {
  const [kind, value] = split(key);
  if (kind === "all") return t().picker.all;
  if (kind === "index") return `@${value}`;
  if (kind === "name") return `« ${value} »`;
  return value;
}

/** What `key` names, in full: "@2", "Français (fre)", "Français (forcé)". */
function keyLabel(key: TrackKey): string {
  const [kind, value] = split(key);
  if (kind === "all") return t().picker.all;
  if (kind === "index") return `@${value}`;
  if (kind === "lang") return languageLabel(value);
  return value;
}

/** A choice of the list, with what tells it apart. */
interface TrackOption {
  key: TrackKey;
  label: string;
  detail: string;
}

/** The choices the files at hand offer (`files`: each one's tracks), by
 * section: every track number (what it is in the first file having it),
 * every language and every track name (in how many files). */
export function trackOptions(files: TrackInfo[][]): { indices: TrackOption[]; languages: TrackOption[]; names: TrackOption[] } {
  const firstOf = new Map<number, TrackInfo>();
  const languages = new Map<string, number>();
  const names = new Map<string, number>();
  for (const tracks of files) {
    for (const tr of tracks) if (!firstOf.has(tr.index)) firstOf.set(tr.index, tr);
    for (const code of new Set(tracks.map((tr) => tr.language).filter((l): l is string => !!l))) {
      languages.set(code, (languages.get(code) ?? 0) + 1);
    }
    for (const name of new Set(tracks.map((tr) => tr.title).filter((n): n is string => !!n))) {
      names.set(name, (names.get(name) ?? 0) + 1);
    }
  }
  const m = t().picker;
  return {
    indices: [...firstOf.values()]
      .sort((a, b) => a.index - b.index)
      .map((tr) => ({ key: indexKey(tr.index), label: `@${tr.index}`, detail: [tr.language, tr.codec].filter(Boolean).join(" · ") })),
    languages: [...languages].map(([code, n]) => ({ key: languageKey(code), label: languageLabel(code), detail: m.files(n) })),
    names: [...names].map(([name, n]) => ({ key: `name:${name}`, label: name, detail: m.files(n) })),
  };
}

// How long the list takes to fade out (TrackFilter.css).
const CLOSE_MS = 120;

/** A drop-down of the choices `options` offers, in sections: several ticked
 * (the tracks to correct: any track one of them names), or one picked
 * (`single`: the reference). Closed, it shows the first one and how many. */
export function TrackFilterPicker({
  label,
  options,
  value,
  onChange,
  single = false,
  disabled = false,
}: {
  /** What's picked, for a screen reader. */
  label: string;
  options: ReturnType<typeof trackOptions>;
  value: TrackKey[];
  onChange: (keys: TrackKey[]) => void;
  single?: boolean;
  disabled?: boolean;
}) {
  const m = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | null>(null);

  function close() {
    if (!open || closing) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpen(false);
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, CLOSE_MS);
  }
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  // Closes on a click elsewhere, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  });

  const sections: [string, TrackOption[]][] = [
    [m.picker.byIndex, options.indices],
    [m.picker.byLanguage, options.languages],
    [m.picker.byName, options.names],
  ];
  const all = sections.flatMap(([, list]) => list);
  const empty = all.length === 0;

  function toggle(key: TrackKey) {
    if (single) {
      onChange([key]);
      close();
    } else {
      onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
    }
  }

  // Closed: the first choice, and how many of how many when several can be.
  const shown = value.includes(ALL_TRACKS) ? m.picker.all : value.length > 0 ? keyLabel(value[0]) : m.picker.nothing;
  const count = !single && value.length > 0 && !value.includes(ALL_TRACKS) ? `${value.length} / ${all.length}` : null;

  return (
    <span className="track-filter" ref={root}>
      <button
        className={`track-filter-button${open && !closing ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open && !closing}
        aria-label={label}
        disabled={disabled || empty}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="track-filter-shown">{shown}</span>
        {count && <span className="track-filter-count">{count}</span>}
        <svg className="track-filter-chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          className={`track-filter-list${closing ? " closing" : ""}`}
          role="listbox"
          aria-multiselectable={!single}
          aria-label={label}
        >
          {!single && (
            <label className="track-filter-option">
              <input type="checkbox" checked={value.includes(ALL_TRACKS)} onChange={() => toggle(ALL_TRACKS)} />
              <span>{m.picker.all}</span>
            </label>
          )}
          {sections.map(
            ([title, list]) =>
              list.length > 0 && (
                <div key={title} className="track-filter-section" role="group" aria-label={title}>
                  <span className="track-filter-heading">{title}</span>
                  {list.map((option) => (
                    <label key={option.key} className="track-filter-option">
                      <input
                        type={single ? "radio" : "checkbox"}
                        name={single ? id : undefined}
                        checked={value.includes(option.key)}
                        onChange={() => toggle(option.key)}
                      />
                      <span>{option.label}</span>
                      {option.detail && <span className="track-filter-detail">{option.detail}</span>}
                    </label>
                  ))}
                </div>
              ),
          )}
          {!single && value.length > 0 && (
            <div className="track-filter-footer">
              <button className="small-button" onClick={() => onChange([])}>
                {m.picker.none}
              </button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/** What a batch starts with, from the first file read (`tracks`): its first
 * track as the reference (by its language, or its number without one),
 * every other language to correct (or, without languages, every other
 * track's number). Pairs pass the file to correct's tracks too (`others`):
 * then those are the ones picked to correct. */
export function defaultPick(tracks: TrackInfo[], others: TrackInfo[] = tracks): { reference: TrackKey; targets: TrackKey[] } {
  const first = tracks[0];
  const reference = first.language ? languageKey(first.language) : indexKey(first.index);
  const candidates = others === tracks ? others.slice(1) : others;
  const languages = [...new Set(candidates.map((tr) => tr.language).filter((l): l is string => !!l && l !== first.language))];
  if (languages.length > 0) return { reference, targets: languages.map(languageKey) };
  // No language to tell them apart: by number (a second file's own first
  // track for a pair, as its dub usually comes alone).
  const fallback = others === tracks ? candidates : others.slice(others.length > 1 ? 1 : 0, others.length > 1 ? 2 : 1);
  return { reference, targets: fallback.map((tr) => indexKey(tr.index)) };
}

English | [Français](README.fr.md)

# SyncAudio

Resynchronizes the audio tracks of multi-language content (e.g. an MKV with several dubs) from the music and sound effects they share, rather than from the dialogue. Handles a simple constant offset as well as progressive drift or jumps (a different cut), with a visual and audio preview before export.

## Repository layout

- [`engine/`](engine/README.md) — Python engine (detection, correction/render, HTTP sidecar); usable on its own as a CLI or as the app's local server. Its documentation is in French.
- `app/` — standalone GUI (Tauri + React/TypeScript): opening files (one at a time or in batches, drag and drop included), picking tracks, waveform/audio preview before export, editing the detected segments by hand, automatic updates. UI in English and French.

## Status

Working end to end: engine (constant/drift/jump detection, render, HTTP sidecar), GUI (analysis, preview, manual editing, export) and batch mode (a whole series in one pass). Packaged as a Windows installer with automatic updates — see `app/README.md` (in French) to build and publish a release, and `engine/README.md` for detailed CLI and HTTP API usage.

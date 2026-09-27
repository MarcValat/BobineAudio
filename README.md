# SyncAudio

Resynchronise les pistes audio d'un contenu multi-langues (ex. un MKV avec plusieurs doublages) en se basant sur la musique et les bruitages communs, plutôt que sur les dialogues. Gère aussi bien un simple décalage constant qu'une dérive progressive ou des sauts (montage différent), avec aperçu visuel et sonore avant export.

## Structure du repo

- [`engine/`](engine/README.md) — moteur Python (détection, correction/rendu, sidecar HTTP) ; utilisable seul en CLI ou comme serveur local pour l'app.
- `app/` — GUI standalone (Tauri + React/TypeScript) : ouverture de fichier (unique ou par lot), sélection des pistes, aperçu waveform/audio avant export, édition manuelle des segments détectés, mise à jour automatique.

## Statut

Fonctionnel de bout en bout : moteur (détection constante/dérive/sauts, rendu, sidecar HTTP), GUI (analyse, aperçu, édition manuelle, export) et mode batch (traiter toute une série en une passe). Empaqueté en installateur Windows avec mise à jour automatique — voir `app/README.md` pour compiler/publier une release. Voir `engine/README.md` pour l'usage détaillé du CLI et de l'API HTTP.

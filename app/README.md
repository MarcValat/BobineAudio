# SyncAudio (app)

GUI standalone de [SyncAudio](../README.md) (Tauri v2 + React/TypeScript) : ouvrir un fichier (ou une série entière en mode batch), choisir la piste de référence et les pistes à corriger, lancer l'analyse (décalage constant, dérive ou sauts), vérifier le résultat par un aperçu visuel (formes d'onde, style diff) et sonore avant d'exporter, éditer manuellement les segments détectés si besoin — y compris ignorer en un clic ceux dont le score de confiance est trop faible pour être fiable.

Ne contient aucune logique de détection/correction elle-même : elle pilote le moteur Python (`../engine/`), lancé au démarrage comme process séparé (« sidecar ») exposant une API HTTP + WebSocket locale (`127.0.0.1:8756`). Voir [`engine/README.md`](../engine/README.md) pour le détail du moteur et de son API.

## Prérequis

- [Node.js](https://nodejs.org/) (npm) pour le frontend.
- [Rust](https://www.rust-lang.org/tools/install) (via [rustup](https://rustup.rs/)) pour la coquille Tauri.
- [uv](https://docs.astral.sh/uv/), avec les dépendances du moteur synchronisées (`uv sync` dans `../engine/`) — le sidecar est lancé en dev via `uv run syncaudio serve`, donc `uv` doit être sur le PATH et `../engine` doit exister relativement à ce dossier.

## Développement

```
npm install
npm run tauri dev
```

Ouvre la fenêtre de l'app avec rechargement à chaud du frontend ; le sidecar moteur est démarré et arrêté automatiquement avec la fenêtre (voir `src-tauri/src/lib.rs`).

`npm run dev` (sans Tauri, juste `vite`) lance le frontend seul dans un navigateur — utile pour itérer vite sur l'UI, mais sans le sidecar ni les API natives (`@tauri-apps/*`), donc rien ne fonctionne au-delà de l'affichage statique.

## Build

```
npm run build
```

Vérifie les types (`tsc`) puis construit le frontend (`vite build`) dans `dist/`.

## Empaqueter un installateur (`tauri build`)

Contrairement à `npm run tauri dev` (qui lance le moteur via `uv run` contre les sources, voir `spawn_sidecar` dans `src-tauri/src/lib.rs`), un vrai paquet installable embarque le moteur comme binaire autonome — aucun Python/`uv` requis sur la machine de l'utilisateur final. Deux étapes :

```
cd ../engine
uv run python packaging/build_sidecar.py
cd ../app
npm run tauri build
```

`build_sidecar.py` fige `syncaudio serve` avec PyInstaller (voir `engine/packaging/syncaudio-engine.spec`) et copie le binaire dans `src-tauri/binaries/syncaudio-engine-<target-triple>.exe` — l'emplacement/nommage attendu par le mécanisme "sidecar" de Tauri (`bundle.externalBin` dans `tauri.conf.json`). `ffmpeg` n'a pas besoin d'être géré séparément : `imageio-ffmpeg` l'embarque déjà (voir `engine/README.md`).

`tauri build` produit un `.msi` et un `.exe` NSIS dans `src-tauri/target/release/bundle/`, plus les signatures de mise à jour (`.sig`) si `TAURI_SIGNING_PRIVATE_KEY` est défini dans l'environnement (voir section suivante) — sans cette variable, les installateurs sont quand même produits, juste sans capacité de mise à jour auto.

N'étant pas signé avec un certificat Authenticode (aucun pour l'instant), l'installateur déclenchera l'avertissement SmartScreen "éditeur inconnu" au premier lancement — c'est attendu.

## Mise à jour automatique

`tauri-plugin-updater` vérifie au démarrage (`src/UpdateBanner.tsx`) si une release plus récente existe sur GitHub, via l'URL configurée dans `src-tauri/tauri.conf.json` (`plugins.updater.endpoints`, convention `.../releases/latest/download/latest.json`). Chaque installateur publié doit être signé avec la même paire de clés que celle dont la clé publique est intégrée dans ce fichier.

La paire de clés a été générée une fois (`npx tauri signer generate -w .tauri-keys/syncaudio.key`) ; `.tauri-keys/` est gitignoré — **ne jamais commit la clé privée**. Pour publier une release signée, deux variables d'environnement doivent être disponibles au moment du `tauri build` (localement, ou en secrets CI — voir `.github/workflows/release.yml`) :

```
TAURI_SIGNING_PRIVATE_KEY=<contenu de .tauri-keys/syncaudio.key>
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<mot de passe choisi à la génération, vide si aucun>
```

## Publier une release

Le dépôt canonique est sur GitLab, mais les releases se font sur GitHub (`https://github.com/MarcValat/SyncAudio`), via le mirroring GitLab -> GitHub existant. Pousser un tag `vX.Y.Z` (qui doit être mirroré vers GitHub — vérifier que le mirroring inclut bien les tags, pas juste les branches, dans les réglages GitLab) déclenche `.github/workflows/release.yml` : tests du moteur, build du sidecar, puis `tauri-apps/tauri-action` compile et publie les installateurs + `latest.json` en release GitHub (créée en brouillon — à valider/publier manuellement une fois vérifiée).

Secrets requis côté GitHub (Settings > Secrets and variables > Actions) : `TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (mêmes valeurs que ci-dessus). `GITHUB_TOKEN` est fourni automatiquement.

## Structure

- `src/App.tsx` — écran fichier unique : liste des pistes, lancement de l'analyse, onglets par piste analysée.
- `src/BatchView.tsx` — mode batch : deux listes de fichiers appariées par position, un couple de pistes référence/à corriger appliqué à toute la série, analyse/export en un clic.
- `src/SegmentChart.tsx` / `SegmentEditor.tsx` — graphe décalage-vs-temps et éditeur manuel des segments (glisser une frontière, fusionner/supprimer, saisie numérique, score de confiance par segment avec option "Ignorer les segments peu fiables").
- `src/TrackPreview.tsx` / `Waveform.tsx` / `WaveformNavigator.tsx` — aperçu avant export : formes d'onde zoomables (référence / candidate / résultat, surlignage façon diff), barre de navigation sur la piste entière, lecture audio synchronisée (Web Audio API, pour un démarrage simultané précis des pistes comparées).
- `src/UpdateBanner.tsx` — vérification/installation de mise à jour au démarrage.
- `src/api.ts` — client du sidecar HTTP/WebSocket.
- `src-tauri/` — coquille Rust : démarrage/arrêt du sidecar (`src/lib.rs`), config de la fenêtre/du bundle/de l'updater (`tauri.conf.json`), icônes (`icons/`, `icon-source.svg` éditable).

# Bobine Audio (app)

GUI standalone de [Bobine Audio](../README.md) (Tauri v2 + React/TypeScript) : ajouter un fichier ou une série entière, choisir la piste de référence et les pistes à corriger, lancer l'analyse (décalage constant, dérive ou sauts), vérifier le résultat par un aperçu visuel (formes d'onde, style diff) et sonore avant d'exporter, éditer manuellement les segments détectés si besoin — y compris ignorer en un clic ceux dont le score de confiance est trop faible pour être fiable.

Ne contient aucune logique de détection/correction elle-même : elle pilote le moteur Python (`../engine/`), lancé au démarrage comme process séparé (« sidecar ») exposant une API HTTP + WebSocket locale (`127.0.0.1:8756`, ou un autre port libre si celui-ci est déjà pris : l'interface le demande à l'app). Voir [`engine/README.md`](../engine/README.md) pour le détail du moteur et de son API.

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

## Vérifications

Elles tournent en local (GitHub Actions ne lance que les tests du moteur et le build, à la release : une vérification là-bas bloquerait la release tard).

```
npm run check              # types, formatage, lint, code mort, tests unitaires : ~30 s
npm run check -- --full    # + clippy et les tests du moteur : ~2 min (pas pendant `tauri dev`)
```

`scripts/check.mjs` enchaîne `tsc`, Prettier, ESLint (règles des hooks React), knip (exports et dépendances inutilisés), les tests unitaires, ruff (`check` et `format`) sur le moteur et `cargo fmt`. `npm run format` reformate l'app (Prettier), `uv run ruff format` le moteur, `cargo fmt` la coquille Rust.

Les tests unitaires (Vitest, `npm test`) couvrent la logique pure de l'interface, à côté de ce qu'ils testent (`src/*.test.ts`) : choix des pistes (`TrackFilter`), plan du résultat (ce qui est joué, coupé ou laissé en silence), éditions de segments, vue temporelle et formes d'onde, chemins de sortie (Windows et Linux), noms des pistes exportées, état des lignes et prochaine étape, sous-titres, formats d'affichage.

### Tests de bout en bout

```
npm run test:e2e                                   # tout : ~8 min
npm run test:e2e -- e2e/workflows.spec.ts          # une suite
npm run test:e2e -- -g "pairs"                     # les tests dont le nom contient « pairs »
npx playwright show-report e2e/report              # le rapport du dernier passage (traces des échecs)
```

L'app dans Chromium, pilotée comme par un utilisateur (Playwright, `playwright.config.ts`), contre le vrai moteur. Vite et le moteur sont démarrés pour le passage puis arrêtés — ou réutilisés s'ils tournent déjà (`tauri dev`). Le moteur lancé par les tests a son propre cache d'analyse.

Les médias sont **synthétiques** (`e2e/make_media.py`, ~15 s, refaits seulement quand le script change, dans `e2e/media/`, ignoré par git) : chaque piste mélange un fond commun (notes, bruitages) décalé d'une valeur connue et une « voix » propre à sa langue, comme un doublage. Les tests vérifient que l'analyse retrouve ces décalages.

| Suite | Ce qu'elle vérifie |
|---|---|
| `workflows` | les deux modes de bout en bout : décalages retrouvés (constant, en avance, saut, paires), options d'export réglées dans leur fenêtre, exports relus (pistes, codecs, noms automatiques, sous-titres forcés recalés, autres copiés) et vérifiés synchronisés |
| `editor` | l'éditeur de segments : couper, défaire / refaire (touches et boutons), réinitialiser, question avant d'abandonner, l'export suit ce qui est enregistré |
| `playback` | l'écoute : jamais plus de trois extraits à la fois, aucun après un arrêt, une fermeture ou un changement de mode, référence et résultat de même durée |
| `ui` | la liste (flèches, déplacer, retirer, « Tout retirer », repli retenu), le choix des pistes, mode / thème / langue retenus, un fichier illisible |
| `layout` | chaque écran à 1024×640 et 1440×900, deux thèmes, deux langues : icônes centrées au pixel, hauteurs entières, arrondis concentriques, texte coupé ou hors fenêtre, boutons voisins, contraste 4,5:1 (mesuré contre la pire couleur des dégradés) |
| `a11y` | accessibilité (axe-core, WCAG 2.1 A / AA) des écrans et dialogues |
| `visual` | les écrans principaux comparés à des captures de référence, enregistrées au premier passage sur chaque système (`e2e/__screenshots__/<système>`, hors git : polices et rendu diffèrent) ; après un changement voulu, `npm run test:e2e -- e2e/visual.spec.ts --update-snapshots` |

Chaque test échoue aussi sur une erreur du moteur (HTTP 4xx/5xx), de la page ou de la console, ou un export laissé à côté des médias. Hors de portée : la vraie fenêtre Tauri (barre de titre, dialogues natifs, WebView2 / WebKitGTK) et le son lui-même.

Avant chaque commit, le hook `../.githooks/pre-commit` vérifie le formatage et le lint des seuls fichiers indexés (quelques secondes) ; `npm install` l'active (script `prepare` : `git config core.hooksPath .githooks`). `git commit --no-verify` le saute une fois.

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

`build_sidecar.py` fige `syncaudio serve` avec PyInstaller (voir `engine/packaging/syncaudio-engine.spec`) sous forme de **dossier** (l'exe et ses bibliothèques à côté, rien à décompresser au lancement : le moteur démarre en ~1 s au lieu de ~3 s pour un exe unique) et le copie dans `src-tauri/binaries/syncaudio-engine/`. `tauri.conf.json` l'embarque comme ressource (`bundle.resources`), installée dans `engine\` à côté de l'exe de l'app, d'où `src-tauri/src/lib.rs` le lance. Ce dossier doit exister pour compiler l'app, `tauri dev` compris. `ffmpeg` n'a pas besoin d'être géré séparément : `imageio-ffmpeg` l'embarque déjà (voir `engine/README.md`).

`tauri build` produit un seul installateur, un `.exe` NSIS, dans `src-tauri/target/release/bundle/nsis/` (pas de `.msi` : il n'exécuterait pas les hooks de `windows/installer-hooks.nsh`, qui arrêtent le moteur avant une mise à jour et nettoient son cache à la désinstallation, et la mise à jour automatique n'utilise que le NSIS), plus les signatures de mise à jour (`.sig`) si `TAURI_SIGNING_PRIVATE_KEY` est défini dans l'environnement (voir section suivante) — sans cette variable, les installateurs sont quand même produits, juste sans capacité de mise à jour auto.

Sous Linux, `npm run tauri build -- --bundles deb` produit un paquet `.deb` dans `src-tauri/target/release/bundle/deb/`. Il faut les bibliothèques de développement de WebKitGTK (`sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev`), et le moteur doit avoir été compilé sous Linux (PyInstaller ne compile que pour le système sur lequel il tourne). Pas d'AppImage : celle produite embarquait le WebKitGTK d'Ubuntu 22.04 et affichait une fenêtre blanche sur une distribution récente (« Could not create default EGL display »), alors que le `.deb` utilise celui du système.

N'étant pas signé avec un certificat Authenticode (aucun pour l'instant), l'installateur déclenchera l'avertissement SmartScreen "éditeur inconnu" au premier lancement — c'est attendu.

## Mise à jour automatique

`tauri-plugin-updater` vérifie au démarrage (`src/UpdateButton.tsx`, désactivable dans les Paramètres) si une release plus récente existe sur GitHub, via l'URL configurée dans `src-tauri/tauri.conf.json` (`plugins.updater.endpoints`, convention `.../releases/latest/download/latest.json`). Chaque installateur publié doit être signé avec la même paire de clés que celle dont la clé publique est intégrée dans ce fichier.

La paire de clés a été générée une fois (`npx tauri signer generate -w .tauri-keys/syncaudio.key`) ; `.tauri-keys/` est gitignoré — **ne jamais commit la clé privée**. Pour publier une release signée, deux variables d'environnement doivent être disponibles au moment du `tauri build` (localement, ou en secrets CI — voir `.github/workflows/release.yml`) :

```
TAURI_SIGNING_PRIVATE_KEY=<contenu de .tauri-keys/syncaudio.key>
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<mot de passe choisi à la génération, vide si aucun>
```

## Publier une release

Le dépôt est sur GitHub (`https://github.com/MarcValat/BobineAudio`). Pousser un tag `vX.Y.Z` déclenche `.github/workflows/release.yml` : tests du moteur, build du sidecar, puis `tauri-apps/tauri-action` compile et publie les installateurs Windows et Linux + `latest.json` dans une release GitHub créée en brouillon, à vérifier puis publier à la main. Un lancement manuel du workflow (Actions > Release > Run workflow, sur n'importe quelle branche) compile les deux installateurs sans rien publier : ils sont joints au run, pour essayer un changement avant de le merger.

Avant le tag : la version dans `package.json` (et `package-lock.json`), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (et `Cargo.lock`), puis `npm run check -- --full` et `npm run test:e2e`.

Secrets requis côté GitHub (Settings > Secrets and variables > Actions) : `TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (mêmes valeurs que ci-dessus). `GITHUB_TOKEN` est fourni automatiquement.

## Structure

- `src/App.tsx` — la barre du haut, qui sert aussi de barre de titre à la fenêtre (sans décorations système, `src/WindowControls.tsx`) : les deux modes, l'état du moteur, la mise à jour, les Paramètres (`src/Options.tsx`).
- `src/BatchView.tsx` — l'espace de travail des deux modes, gardés montés tous les deux : `src/MultiTrackBatch.tsx` (des fichiers qui contiennent chacun la référence et les pistes à corriger) et `src/PairsBatch.tsx` (des paires de fichiers appariés par position). Leurs pièces communes : `src/Workspace.tsx` (liste repliable, lignes, état vide), `src/Detail.tsx` (le détail du fichier choisi), `src/batchShared.tsx` (file d'analyse/export, sortie, étape suivante).
- `src/uiScale.ts` — la taille de l'interface (zoom de la WebView), réduite d'office sur un écran trop petit pour la mise en page ; la taille minimale de la fenêtre la suit.
- `src/SegmentChart.tsx` / `SegmentEditor.tsx` — graphe décalage-vs-temps et éditeur manuel des segments (glisser une frontière, fusionner/supprimer, saisie numérique, score de confiance par segment avec option "Ignorer les segments peu fiables").
- `src/TrackPreview.tsx` / `Waveform.tsx` / `WaveformNavigator.tsx` — aperçu avant export : formes d'onde zoomables (référence / candidate / résultat, surlignage façon diff), barre de navigation sur la piste entière, lecture audio synchronisée (Web Audio API, pour un démarrage simultané précis des pistes comparées). Le « Résultat final » est fidèle au fichier exporté : l'extrait écouté est produit par le moteur avec le même filtre que le rendu (`POST /corrected-clip`), et sa forme d'onde suit la même logique segment par segment (`src/resultPlan.ts`) — sauts, contenu en trop sauté, blancs là où la piste doublée manque de contenu.
- `src/UpdateButton.tsx` — vérification de mise à jour au démarrage, et son installation depuis l'icône à côté des Paramètres.
- `src/api.ts` — client du sidecar HTTP/WebSocket.
- `src-tauri/` — coquille Rust : démarrage/arrêt du sidecar (`src/lib.rs`), config de la fenêtre/du bundle/de l'updater (`tauri.conf.json`), icônes (`icons/` : `icon-source.svg` éditable, et `icon-source-small.svg` pour les tailles de 16 à 48 px du `.ico`), hooks de l'installateur NSIS (`windows/installer-hooks.nsh`).

Le moteur ne doit jamais survivre à l'UI (sinon son `.exe` reste verrouillé et la mise à jour suivante échoue), quelle que soit la façon dont l'UI se termine — fermeture, crash, kill forcé, ou updater. Trois garde-fous indépendants : un Job Object Windows "kill on close" qui contient le moteur (`src/lib.rs`), le moteur qui surveille lui-même le PID de l'UI et s'arrête s'il disparaît (`engine/src/syncaudio/parent_watchdog.py`), et l'installateur qui tue tout moteur restant avant de copier les fichiers (`windows/installer-hooks.nsh`, ce qui couvre aussi une mise à jour depuis une ancienne version).

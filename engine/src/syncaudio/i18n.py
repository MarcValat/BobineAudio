"""Messages the user reads (job logs, errors), in the GUI's language.

A message is written in French, as a ``str.format`` template, and passed
through ``tr``: in French (the default, and the CLI's language) it comes
out as written; in English, its translation from ``_EN`` does. The GUI
sets the language (``POST /language``) at startup and whenever it changes.
A test checks that every template in the code has its translation.
"""

from __future__ import annotations

LANGUAGES = ("fr", "en")

_language = "fr"


def set_language(language: str) -> None:
    global _language
    if language not in LANGUAGES:
        raise ValueError(f"Unknown language: {language!r}")
    _language = language


def get_language() -> str:
    return _language


def tr(template: str, /, **values: object) -> str:
    """``template`` in the current language, filled with ``values``."""
    text = _EN.get(template, template) if _language == "en" else template
    return text.format(**values)


_EN: dict[str, str] = {
    # analysis_cache
    "[analyse] {track} : calcul du spectrogramme et de l'enveloppe...":
        "[analysis] {track}: computing the spectrogram and envelope...",
    "[cache] {track} : analyse déjà en cours ailleurs, attente...":
        "[cache] {track}: already being analyzed elsewhere, waiting...",
    "[cache] {track} déjà analysée, réutilisation":
        "[cache] {track} already analyzed, reusing it",
    "[extraction] {track} ...":
        "[extraction] {track} ...",
    "[extraction] {path} : {count} piste(s) en une seule passe...":
        "[extraction] {path}: {count} track(s) in a single pass...",
    "[extraction] passe groupée impossible, pistes une par une ({error})":
        "[extraction] grouped pass impossible, one track at a time ({error})",
    # segments
    "[analyse] fenêtres glissantes...":
        "[analysis] sliding windows...",
    "[analyse] affinage des frontières...":
        "[analysis] refining boundaries...",
    # server
    "Job inconnu : {job_id}":
        "Unknown job: {job_id}",
    "only_imports et track_indices sont incompatibles.":
        "only_imports and track_indices can't be used together.",
    "subs {subs} : la piste audio indiquée ne correspond à aucune piste corrigée "
    "(track_indices ou import_audio, même fichier@index).":
        "subs {subs}: the given audio track matches no corrected track "
        "(track_indices or import_audio, same file@index).",
    "[segments] {track} : utilisation des segments fournis (édités manuellement)":
        "[segments] {track}: using the given segments (edited by hand)",
    "[rendu] écriture de {path} ...":
        "[render] writing {path} ...",
    # ffmpeg_backend
    "ffmpeg introuvable : ni sur le PATH, ni via le paquet imageio-ffmpeg.":
        "ffmpeg not found: neither on the PATH nor through the imageio-ffmpeg package.",
    "Index de piste invalide dans {raw!r} : {index!r} n'est pas un entier.":
        "Invalid track index in {raw!r}: {index!r} is not an integer.",
    "Impossible de lire {path!r} :\n{details}":
        "Can't read {path!r}:\n{details}",
    "Aucune piste audio trouvée dans {path!r}.":
        "No audio track found in {path!r}.",
    "Impossible de déterminer la durée de {path!r}.":
        "Can't tell the duration of {path!r}.",
    "Piste de sous-titres @{index} absente de {path!r} ({count} trouvée(s)).":
        "Subtitle track @{index} missing from {path!r} ({count} found).",
    "Échec de l'extraction audio pour {track!r} :\n{details}":
        "Audio extraction failed for {track!r}:\n{details}",
    "Échec de l'extraction du clip pour {track!r} :\n{details}":
        "Clip extraction failed for {track!r}:\n{details}",
    # render
    "Facteur d'étirement invalide : {factor}":
        "Invalid stretch factor: {factor}",
    "Aucun segment ne couvre cet extrait.":
        "No segment covers this clip.",
    "Échec de la prévisualisation pour {track!r} :\n{details}":
        "Preview failed for {track!r}:\n{details}",
    "Index de référence {index} absent de {path!r} (pistes : {tracks}).":
        "Reference index {index} missing from {path!r} (tracks: {tracks}).",
    "La piste de référence ne peut pas aussi être une piste à corriger.":
        "The reference track can't also be a track to correct.",
    "Index(es) inconnu(s) : {unknown} (pistes disponibles : {tracks}).":
        "Unknown index(es): {unknown} (available tracks: {tracks}).",
    "Index audio {index} absent de {path!r} (pistes : {tracks}).":
        "Audio index {index} missing from {path!r} (tracks: {tracks}).",
    "Échec ffmpeg :\n{command}\n{details}":
        "ffmpeg failed:\n{command}\n{details}",
    # subtitles
    "Format de sous-titres non supporté pour --segmented : {codec!r} (seuls srt/ass/ssa le sont).":
        "Subtitle format not supported for --segmented: {codec!r} (only srt/ass/ssa are).",
    "Format de sous-titres inconnu : {fmt!r}":
        "Unknown subtitle format: {fmt!r}",
}

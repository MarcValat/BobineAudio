from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_persistent_analysis_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never read or write the user's real on-disk analysis cache from tests."""
    monkeypatch.setenv("SYNCAUDIO_CACHE_DIR", "")

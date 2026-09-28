from __future__ import annotations

import numpy as np
import pytest
from scipy.ndimage import median_filter

from syncaudio.features import _median_filter, _onset_envelope, _stft_magnitude, extract_envelope


@pytest.mark.parametrize("size", [1, 2, 3, 4, 16, 17])
@pytest.mark.parametrize("frames", [5, 8, 9, 17, 40, 1000])
@pytest.mark.parametrize("axis", [0, 1])
def test_median_filter_is_bit_identical_to_scipy(size: int, frames: int, axis: int) -> None:
    # Ties included on purpose: equal values must still land on the same rank.
    mag = np.random.default_rng(0).random((513, frames)).astype(np.float32)
    mag[mag < 0.3] = 0.25
    footprint = (size, 1) if axis == 0 else (1, size)
    assert np.array_equal(_median_filter(mag, size, axis), median_filter(mag, size=footprint))


def _reference_envelope(pcm: np.ndarray) -> np.ndarray:
    """The original whole-array pipeline, straight on scipy's median filter."""
    mag = _stft_magnitude(pcm, 1024, 256)
    harmonic = median_filter(mag, size=(1, 17))
    percussive = median_filter(mag, size=(17, 1))
    return _onset_envelope(mag * (percussive / (percussive + harmonic + 1e-10)))


# Around block boundaries (512 frames of 256 samples) on purpose, including a
# last block of a single frame.
@pytest.mark.parametrize("n_samples", [1024, 1025, 5000, 256 * 512, 256 * 512 + 1, 256 * 1536 + 77, 16000 * 95 + 3])
def test_extract_envelope_is_bit_identical_to_the_whole_array_pipeline(n_samples: int) -> None:
    pcm = (np.random.default_rng(n_samples).standard_normal(n_samples) * 0.1).astype(np.float32)
    env, frame_rate = extract_envelope(pcm, 16000)
    assert frame_rate == 16000 / 256
    assert np.array_equal(env, _reference_envelope(pcm))


# Fingerprint of a fixed signal's envelope, per ENVELOPE_VERSION. Envelopes
# are cached on disk under that version (see analysis_cache): if this test
# fails, the computation changed, so bump ENVELOPE_VERSION and add its new
# fingerprint here -- otherwise users would keep getting stale envelopes.
_ENVELOPE_FINGERPRINTS = {
    1: (54.22699395939708, 12.481221590383889, 6702.2528878077865, 0.8052475452423096),
}


def test_envelope_changes_come_with_a_new_cache_version() -> None:
    from syncaudio.features import ENVELOPE_VERSION

    rng = np.random.default_rng(2026)
    pcm = (rng.standard_normal(16000 * 4) * 0.1).astype(np.float32)
    pcm[16000:16400] += np.hanning(400).astype(np.float32)
    env, _ = extract_envelope(pcm, 16000)
    k = np.arange(len(env))
    fingerprint = (env.sum(), (env**2).sum(), (env * k).sum(), env.max())

    assert ENVELOPE_VERSION in _ENVELOPE_FINGERPRINTS, "new ENVELOPE_VERSION: record its fingerprint here"
    assert np.allclose(fingerprint, _ENVELOPE_FINGERPRINTS[ENVELOPE_VERSION], rtol=1e-5, atol=0), (
        "envelope computation changed: bump ENVELOPE_VERSION (features.py) and record the new fingerprint"
    )

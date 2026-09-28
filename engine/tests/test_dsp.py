"""The engine's scipy.fft-only primitives must match full scipy bit for bit."""

from __future__ import annotations

import warnings

import numpy as np
import pytest
from scipy.ndimage import median_filter
from scipy.signal import fftconvolve, get_window, stft

from syncaudio.dsp import _hann_periodic, fftconvolve_full, median_filter_nearest, stft_magnitude


@pytest.mark.parametrize("m", [1, 2, 3, 256, 1000, 1024, 1025])
def test_hann_window_matches_scipy(m: int) -> None:
    assert np.array_equal(_hann_periodic(m), get_window("hann", m))


@pytest.mark.parametrize("n", [800, 1000, 1023, 1024, 1025, 1280, 5000, 12345, 44100, 256 * 512 + 77, 400000])
@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("boundary", [True, False])
def test_stft_magnitude_matches_scipy(n: int, dtype: type, boundary: bool) -> None:
    x = (np.random.default_rng(n).standard_normal(n) * 0.1).astype(dtype)
    kwargs = dict(window="hann", nperseg=1024, noverlap=768, boundary="zeros" if boundary else None, padded=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            expected = np.abs(stft(x, **kwargs)[2])
        except ValueError:
            with pytest.raises(ValueError):
                stft_magnitude(x, 1024, 768, boundary=boundary)
            return
        got = stft_magnitude(x, 1024, 768, boundary=boundary)
    assert got.dtype == expected.dtype
    assert got.strides == expected.strides  # later sums reduce in memory order
    assert np.array_equal(got, expected)


@pytest.mark.parametrize(
    ("n1", "n2"), [(1, 1), (1, 5), (10, 7), (500, 480), (3001, 2999), (18000, 17000), (60000, 54000), (112345, 99999)]
)
def test_fftconvolve_full_matches_scipy(n1: int, n2: int) -> None:
    rng = np.random.default_rng(n1 * 7 + n2)
    a, b = rng.standard_normal(n1), rng.standard_normal(n2)
    assert np.array_equal(fftconvolve_full(a, b[::-1]), fftconvolve(a, b[::-1], mode="full"))


@pytest.mark.parametrize("size", [1, 2, 3, 4, 5, 9])
@pytest.mark.parametrize("n", [1, 2, 5, 6, 50, 1001])
def test_median_filter_nearest_matches_scipy(size: int, n: int) -> None:
    x = np.random.default_rng(n).standard_normal(n)
    x[::3] = 0.5  # ties
    assert np.array_equal(median_filter_nearest(x, size), median_filter(x, size=size, mode="nearest"))

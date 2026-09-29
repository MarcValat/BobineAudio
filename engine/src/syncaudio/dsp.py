"""The few signal-processing primitives the engine needs, on ``scipy.fft`` alone.

Each one reproduces, operation for operation, the scipy function it replaces
(``scipy.signal.stft``, ``scipy.signal.fftconvolve``,
``scipy.ndimage.median_filter``), so results stay bit-identical -- see
tests/test_dsp.py, which checks exactly that against scipy itself. Only
``scipy.fft`` is imported: scipy.signal and scipy.ndimage drag in most of
scipy (stats, optimize, sparse, ...), which roughly doubles engine startup
and bundle size for nothing the engine uses. The FFT itself is kept from
scipy on purpose: numpy ships a different pocketfft build whose rounding
differs.
"""

from __future__ import annotations

import warnings

import numpy as np


def _sp_fft():
    """``scipy.fft``, imported on first use rather than with this module: it's
    most of the engine's startup time (~0.4s), which the server spends before
    it can answer at all. The server loads it in the background once up
    instead (see ``warm_up``)."""
    from scipy import fft

    return fft


def warm_up() -> None:
    """Load what the computations need ahead of the first one."""
    _sp_fft()


def _hann_periodic(m: int) -> np.ndarray:
    """``scipy.signal.get_window("hann", m)``: DFT-even, computed the same way."""
    if m <= 1:
        return np.ones(m, dtype=np.float64)
    fac = np.linspace(-np.pi, np.pi, m + 1, dtype=np.float64)
    w = np.zeros(m + 1, dtype=np.float64)
    for k, a in enumerate((0.5, 0.5)):
        w += a * np.cos(k * fac)
    return w[:-1]


def stft_magnitude(x: np.ndarray, nperseg: int, noverlap: int, *, boundary: bool = True) -> np.ndarray:
    """``np.abs(scipy.signal.stft(x, window="hann", nperseg=..., noverlap=...,
    boundary="zeros" if boundary else None, padded=True)[2])`` for 1D real ``x``.

    Frequency on axis 0, frames on axis 1 (a transposed view, as scipy's).
    """
    x = np.asarray(x)
    outdtype = np.result_type(x, np.complex64)
    if nperseg > x.shape[-1]:
        warnings.warn(
            f"nperseg = {nperseg:d} is greater than input length  = {x.shape[-1]:d}, using nperseg = {x.shape[-1]:d}",
            stacklevel=2,
        )
        nperseg = x.shape[-1]
    if noverlap >= nperseg:
        raise ValueError("noverlap must be less than nperseg.")
    nstep = nperseg - noverlap
    if boundary:
        edge = np.zeros(nperseg // 2, dtype=x.dtype)
        x = np.concatenate((edge, x, edge))
    # scipy pads with float64 zeros, which upcasts the signal even when nothing is added.
    nadd = (-(x.shape[-1] - nperseg) % nstep) % nperseg
    x = np.concatenate((x, np.zeros(nadd)))

    win = _hann_periodic(nperseg)
    if np.result_type(win, np.complex64) != outdtype:
        win = win.astype(outdtype)
    scale = np.sqrt(1.0 / win.sum() ** 2)

    frames = np.lib.stride_tricks.sliding_window_view(x, window_shape=nperseg, axis=-1, writeable=True)[0::nstep]
    result = _sp_fft().rfft((win * frames).real, n=nperseg)
    result *= scale
    return np.abs(np.moveaxis(result.astype(outdtype), -1, 0))


def fftconvolve_full(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """``scipy.signal.fftconvolve(a, b, mode="full")`` for 1D real float arrays."""
    if a.shape[0] == 1 or b.shape[0] == 1:
        return a * b  # scipy broadcasts a length-1 axis instead of transforming it
    shape = a.shape[0] + b.shape[0] - 1
    sp_fft = _sp_fft()
    fshape = [sp_fft.next_fast_len(shape, True)]
    sp1 = sp_fft.rfftn(a, fshape, axes=[0])
    sp2 = sp_fft.rfftn(b, fshape, axes=[0])
    return sp_fft.irfftn(sp1 * sp2, fshape, axes=[0])[:shape].copy()


def median_filter_nearest(x: np.ndarray, size: int) -> np.ndarray:
    """``scipy.ndimage.median_filter(x, size=size, mode="nearest")`` for 1D ``x``.

    A median only ever picks one of the input values (the upper middle one
    for an even ``size``, as scipy does), so this is exact by construction.
    """
    x = np.asarray(x)
    left = size // 2
    padded = np.pad(x, (left, size - 1 - left), mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(padded, size)
    return np.partition(windows, size // 2, axis=-1)[:, size // 2].astype(x.dtype, copy=False)

#!/usr/bin/env python3
"""VWAP Rejection V1 — indicators, signals, and signal_extreme helpers."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

STRATEGY_ID = 'VWAP_REJECTION_V1'
STRATEGY_NAME = 'VWAP Rejection V1'
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent / 'config' / 'vwap_rejection_v1.json'


def load_config(path: Path | None = None) -> dict[str, Any]:
    p = path or DEFAULT_CONFIG_PATH
    data = json.loads(p.read_text(encoding='utf-8'))
    return data.get('strategy', data)


def session_vwap(df: pd.DataFrame) -> pd.Series:
    """UTC-day session VWAP from HLC3. NaN when cumulative volume is 0."""
    day = df.index.floor('D')
    typical = (df.high + df.low + df.close) / 3.0
    vol = df.volume.astype(float)
    cum_pv = (typical * vol).groupby(day).cumsum()
    cum_v = vol.groupby(day).cumsum()
    out = cum_pv / cum_v.replace(0, np.nan)
    out = out.where(cum_v > 0)
    return out


def candle_anatomy(df: pd.DataFrame) -> pd.DataFrame:
    body = (df.close - df.open).abs()
    upper = df.high - df[['close', 'open']].max(axis=1)
    lower = df[['close', 'open']].min(axis=1) - df.low
    total_range = df.high - df.low
    return pd.DataFrame(
        {'body': body, 'upper_wick': upper, 'lower_wick': lower, 'total_range': total_range},
        index=df.index,
    )


def volume_sma(volume: pd.Series, period: int = 20) -> pd.Series:
    return volume.rolling(period, min_periods=period).mean()


def increasing_volume(volume: pd.Series, n: int = 3) -> pd.Series:
    """Strictly increasing over n candles ending at t: V[t] > V[t-1] > ..."""
    chain = pd.Series(True, index=volume.index)
    for k in range(n - 1):
        chain &= volume.shift(k) > volume.shift(k + 1)
    return chain.fillna(False)


def signals_vwap_rejection_v1(
    df: pd.DataFrame,
    min_wick_body: float = 2.0,
    max_opp_wick_body: float = 1.0,
    volume_sma_period: int = 20,
    increasing_candles: int = 3,
    require_above_sma: bool = True,
    allow_doji: bool = False,
    allow_long: bool = True,
    allow_short: bool = True,
) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series]:
    """Return long_entry, short_entry, long_exit, short_exit (exits always False)."""
    anat = candle_anatomy(df)
    body = anat['body']
    up = anat['upper_wick']
    dn = anat['lower_wick']
    vwap = session_vwap(df)
    vol = df.volume.astype(float)
    vsma = volume_sma(vol, volume_sma_period)
    vol_up = increasing_volume(vol, increasing_candles)

    body_ok = body > 0 if not allow_doji else body >= 0
    # Doji = zero body; V1 never classifies dojis as rejection
    body_ok = body > 0

    bullish = (
        body_ok
        & (dn >= min_wick_body * body)
        & (up <= max_opp_wick_body * body)
        & vwap.notna()
        & (df.low <= vwap)
        & (df.close > vwap)
    )
    bearish = (
        body_ok
        & (up >= min_wick_body * body)
        & (dn <= max_opp_wick_body * body)
        & vwap.notna()
        & (df.high >= vwap)
        & (df.close < vwap)
    )

    vol_ok = vol_up & vol.notna()
    if require_above_sma:
        vol_ok &= vsma.notna() & (vol > vsma)

    # Need enough history for SMA + increasing window
    ready = vsma.notna() if require_above_sma else (vol.shift(increasing_candles - 1).notna())

    long_e = bullish & vol_ok & ready if allow_long else pd.Series(False, index=df.index)
    short_e = bearish & vol_ok & ready if allow_short else pd.Series(False, index=df.index)
    false = pd.Series(False, index=df.index)
    return (
        long_e.fillna(False).astype(bool),
        short_e.fillna(False).astype(bool),
        false,
        false,
    )


def signals_from_config(df: pd.DataFrame, cfg: dict[str, Any] | None = None):
    cfg = cfg or load_config()
    rej = cfg.get('rejection', {})
    vol = cfg.get('volume', {})
    risk = cfg.get('risk', {})
    return signals_vwap_rejection_v1(
        df,
        min_wick_body=float(rej.get('minimum_wick_body_ratio', 2.0)),
        max_opp_wick_body=float(rej.get('maximum_opposite_wick_body_ratio', 1.0)),
        volume_sma_period=int(vol.get('sma_period', 20)),
        increasing_candles=int(vol.get('increasing_candles', 3)),
        require_above_sma=bool(vol.get('require_above_sma', True)),
        allow_doji=bool(rej.get('allow_doji', False)),
        allow_long=bool(risk.get('allow_long', True)),
        allow_short=bool(risk.get('allow_short', True)),
    )

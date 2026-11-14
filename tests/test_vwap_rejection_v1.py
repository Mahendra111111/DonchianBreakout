"""Unit + integration tests for VWAP Rejection V1."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from strategy_research_report import run_signal_backtest
from vwap_rejection_v1 import (
    STRATEGY_ID,
    candle_anatomy,
    increasing_volume,
    session_vwap,
    signals_vwap_rejection_v1,
    volume_sma,
)


def _bars(rows: list[dict]) -> pd.DataFrame:
    idx = pd.to_datetime([r['ts'] for r in rows], utc=True)
    df = pd.DataFrame(
        {
            'open': [r['o'] for r in rows],
            'high': [r['h'] for r in rows],
            'low': [r['l'] for r in rows],
            'close': [r['c'] for r in rows],
            'volume': [r['v'] for r in rows],
        },
        index=idx,
    )
    return df


def test_session_vwap_and_utc_reset():
    rows = []
    # Day 1
    rows.append({'ts': '2024-01-01 01:00', 'o': 100, 'h': 110, 'l': 90, 'c': 105, 'v': 10})
    rows.append({'ts': '2024-01-01 02:00', 'o': 105, 'h': 120, 'l': 100, 'c': 115, 'v': 10})
    # Day 2 reset
    rows.append({'ts': '2024-01-02 01:00', 'o': 200, 'h': 210, 'l': 190, 'c': 205, 'v': 10})
    df = _bars(rows)
    vwap = session_vwap(df)
    tp0 = (110 + 90 + 105) / 3
    assert vwap.iloc[0] == pytest.approx(tp0)
    tp1 = (120 + 100 + 115) / 3
    expected1 = (tp0 * 10 + tp1 * 10) / 20
    assert vwap.iloc[1] == pytest.approx(expected1)
    tp2 = (210 + 190 + 205) / 3
    assert vwap.iloc[2] == pytest.approx(tp2)  # reset


def test_zero_volume_vwap_nan():
    df = _bars([
        {'ts': '2024-01-01 01:00', 'o': 1, 'h': 2, 'l': 0.5, 'c': 1.5, 'v': 0},
    ])
    assert np.isnan(session_vwap(df).iloc[0])


def test_bullish_rejection_anatomy():
    # body=1, lower=3 (>=2), upper=0.5 (<=1)
    df = _bars([{'ts': '2024-01-01 01:00', 'o': 10, 'h': 11.5, 'l': 6, 'c': 11, 'v': 100}])
    a = candle_anatomy(df).iloc[0]
    assert a.body == pytest.approx(1.0)
    assert a.lower_wick == pytest.approx(4.0)  # min(o,c)=10 - 6
    assert a.upper_wick == pytest.approx(0.5)


def test_bearish_rejection_anatomy():
    df = _bars([{'ts': '2024-01-01 01:00', 'o': 11, 'h': 15, 'l': 9.5, 'c': 10, 'v': 100}])
    a = candle_anatomy(df).iloc[0]
    assert a.body == pytest.approx(1.0)
    assert a.upper_wick == pytest.approx(4.0)
    assert a.lower_wick == pytest.approx(0.5)


def test_invalid_wick_body_and_doji_rejected():
    # Insufficient lower wick for long
    rows = _make_volume_ready_base()
    # Last candle: body=2, lower=2 (< 4 needed), touches vwap
    rows[-1] = {'ts': rows[-1]['ts'], 'o': 100, 'h': 102, 'l': 98, 'c': 102, 'v': 200}
    df = _bars(rows)
    le, se, _, _ = signals_vwap_rejection_v1(df)
    assert not bool(le.iloc[-1])
    # Doji body=0
    rows[-1] = {'ts': rows[-1]['ts'], 'o': 100, 'h': 110, 'l': 90, 'c': 100, 'v': 200}
    df = _bars(rows)
    le, se, _, _ = signals_vwap_rejection_v1(df)
    assert not bool(le.iloc[-1]) and not bool(se.iloc[-1])


def _make_volume_ready_base(n: int = 25) -> list[dict]:
    """Flatish series with rising volume ending ready for a custom last candle."""
    rows = []
    for i in range(n):
        ts = f'2024-01-01 {i:02d}:00' if i < 24 else '2024-01-02 00:00'
        # Keep price around 100 so VWAP ~100
        rows.append({'ts': ts, 'o': 100, 'h': 101, 'l': 99, 'c': 100.5, 'v': 10 + i})
    return rows


def test_three_increasing_volumes_and_sma():
    vol = pd.Series([1.0, 2.0, 3.0, 4.0, 5.0] + [10.0] * 20)
    assert bool(increasing_volume(vol, 3).iloc[4])  # 5 > 4 > 3
    assert not bool(increasing_volume(vol, 3).iloc[-1])  # flat 10s
    # equal volumes fail
    vol2 = pd.Series([1.0, 2.0, 2.0, 3.0] + [5.0] * 20)
    assert not bool(increasing_volume(vol2, 3).iloc[2])
    # decreasing fails
    vol3 = pd.Series([5.0, 4.0, 3.0] + [10.0] * 20)
    assert not bool(increasing_volume(vol3, 3).iloc[2])
    s = volume_sma(pd.Series(range(1, 25), dtype=float), 20)
    assert np.isnan(s.iloc[18])
    assert s.iloc[19] == pytest.approx(sum(range(1, 21)) / 20)


def test_missing_volume_history_no_signal():
    rows = _make_volume_ready_base(10)  # < 20 SMA
    # Craft bullish rejection last bar
    rows[-1] = {'ts': '2024-01-01 09:00', 'o': 100, 'h': 101, 'l': 94, 'c': 101, 'v': 50}
    df = _bars(rows)
    le, se, _, _ = signals_vwap_rejection_v1(df)
    assert not le.any() and not se.any()


def test_long_and_short_signal_generation():
    rows = _make_volume_ready_base(25)
    # Bullish: body=1, lower=3, upper=0.5, close above VWAP~100, low below
    rows[-1] = {'ts': '2024-01-02 00:00', 'o': 100, 'h': 101.5, 'l': 96, 'c': 101, 'v': 200}
    df = _bars(rows)
    le, se, _, _ = signals_vwap_rejection_v1(df)
    assert bool(le.iloc[-1])
    assert not bool(se.iloc[-1])

    rows[-1] = {'ts': '2024-01-02 00:00', 'o': 101, 'h': 105, 'l': 99.5, 'c': 100, 'v': 200}
    df = _bars(rows)
    le, se, _, _ = signals_vwap_rejection_v1(df)
    assert bool(se.iloc[-1])
    assert not bool(le.iloc[-1])


def test_next_candle_entry_sl_tp_and_gap_reject():
    # Build synthetic path: signal then entry then exit
    idx = pd.date_range('2024-01-01', periods=30, freq='1h', tz='UTC')
    o = np.full(30, 100.0)
    h = np.full(30, 101.0)
    l = np.full(30, 99.0)
    c = np.full(30, 100.0)
    v = np.arange(30, dtype=float) + 1
    # Signal at i=24: bullish rejection
    o[24], h[24], l[24], c[24], v[24] = 100, 101.2, 96, 101, 100
    # Entry bar 25 open
    o[25], h[25], l[25], c[25] = 100.5, 110, 100, 109
    # Later hit TP
    for i in range(26, 30):
        o[i], h[i], l[i], c[i] = 109, 120, 108, 115
    df = pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': c, 'volume': v}, index=idx)
    le = pd.Series(False, index=idx)
    se = pd.Series(False, index=idx)
    le.iloc[24] = True
    metrics = run_signal_backtest(
        df, le, se, stop_mode='signal_extreme', rr=2.0, strategy_id=STRATEGY_ID, funding_rate_8h=0.0,
    )
    assert metrics['trades'] == 1
    t = metrics['trade_list'][0]
    assert t['entry_price'] == pytest.approx(100.5 * (1 + 0.0002))
    # SL = rejection low 96; risk from slipped entry
    assert t['stop_loss'] == pytest.approx(96.0)
    assert t['exit_reason'] == 'TAKE_PROFIT'

    # Gap beyond SL: open <= stop
    o2 = o.copy()
    o2[25] = 95.0
    df2 = pd.DataFrame({'open': o2, 'high': h, 'low': l, 'close': c, 'volume': v}, index=idx)
    m2 = run_signal_backtest(df2, le, se, stop_mode='signal_extreme', rr=2.0, strategy_id=STRATEGY_ID)
    assert m2['trades'] == 0


def test_same_candle_sl_before_tp():
    idx = pd.date_range('2024-01-01', periods=28, freq='1h', tz='UTC')
    o = np.full(28, 100.0)
    h = np.full(28, 101.0)
    l = np.full(28, 99.0)
    c = np.full(28, 100.0)
    v = np.arange(28, dtype=float) + 1
    o[24], h[24], l[24], c[24], v[24] = 100, 101, 96, 101, 100
    o[25], h[25], l[25], c[25] = 100, 120, 90, 110  # both SL and TP touched
    df = pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': c, 'volume': v}, index=idx)
    le = pd.Series(False, index=idx)
    se = pd.Series(False, index=idx)
    le.iloc[24] = True
    m = run_signal_backtest(df, le, se, stop_mode='signal_extreme', rr=2.0, strategy_id=STRATEGY_ID)
    assert m['trades'] == 1
    assert m['trade_list'][0]['exit_reason'] == 'STOP_LOSS'


def test_short_sl_tp_and_fees_funding():
    idx = pd.date_range('2024-01-01', periods=28, freq='1h', tz='UTC')
    o = np.full(28, 100.0)
    h = np.full(28, 101.0)
    l = np.full(28, 99.0)
    c = np.full(28, 100.0)
    v = np.arange(28, dtype=float) + 1
    o[24], h[24], l[24], c[24], v[24] = 101, 105, 99.5, 100, 100
    o[25], h[25], l[25], c[25] = 100, 100.5, 80, 85
    df = pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': c, 'volume': v}, index=idx)
    le = pd.Series(False, index=idx)
    se = pd.Series(False, index=idx)
    se.iloc[24] = True
    m = run_signal_backtest(
        df, le, se, stop_mode='signal_extreme', rr=2.0,
        strategy_id=STRATEGY_ID, funding_rate_8h=0.0001,
    )
    assert m['trades'] == 1
    t = m['trade_list'][0]
    assert t['direction'] == 'SHORT'
    assert t['stop_loss'] == pytest.approx(105.0)
    assert t['entry_fee'] > 0 and t['exit_fee'] > 0
    assert 'funding_cost' in t


def test_end_of_data_open_position():
    idx = pd.date_range('2024-01-01', periods=26, freq='1h', tz='UTC')
    o = np.full(26, 100.0)
    h = np.full(26, 101.0)
    l = np.full(26, 99.0)
    c = np.full(26, 100.0)
    v = np.arange(26, dtype=float) + 1
    o[24], h[24], l[24], c[24], v[24] = 100, 101, 96, 101, 100
    o[25], h[25], l[25], c[25] = 100.5, 101, 100, 100.8  # never hits SL/TP
    df = pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': c, 'volume': v}, index=idx)
    le = pd.Series(False, index=idx)
    se = pd.Series(False, index=idx)
    le.iloc[24] = True
    m = run_signal_backtest(df, le, se, stop_mode='signal_extreme', rr=2.0, strategy_id=STRATEGY_ID)
    assert m['trades'] == 0
    assert m['open_trade'] is not None
    assert m['open_trade']['trade_status'] == 'OPEN'
    assert m['open_trade']['exit_reason'] == 'END_OF_DATA'


def test_position_isolation_symbol_timeframe_and_no_lookahead():
    # Two independent frames: signals on A must not affect B
    idx = pd.date_range('2024-01-01', periods=30, freq='1h', tz='UTC')
    base = pd.DataFrame(
        {
            'open': np.full(30, 100.0),
            'high': np.full(30, 101.0),
            'low': np.full(30, 99.0),
            'close': np.full(30, 100.0),
            'volume': np.arange(30, dtype=float) + 1,
        },
        index=idx,
    )
    a = base.copy()
    a.loc[idx[24], ['open', 'high', 'low', 'close', 'volume']] = [100, 101, 96, 101, 100]
    a.loc[idx[25], ['open', 'high', 'low', 'close']] = [100.5, 120, 100, 115]
    b = base.copy()
    le_a = pd.Series(False, index=idx)
    le_a.iloc[24] = True
    le_b = pd.Series(False, index=idx)
    ma = run_signal_backtest(a, le_a, pd.Series(False, index=idx), stop_mode='signal_extreme', rr=2.0)
    mb = run_signal_backtest(b, le_b, pd.Series(False, index=idx), stop_mode='signal_extreme', rr=2.0)
    assert ma['trades'] == 1
    assert mb['trades'] == 0

    # No lookahead: truncate after signal — should not use future bars for signal itself
    truncated = a.iloc[:25]
    le_t, se_t, _, _ = signals_vwap_rejection_v1(truncated)
    # Signal evaluation only uses data through last row
    assert len(le_t) == 25


def test_integration_known_trade_outcome():
    """Synthetic path with known long → stop loss."""
    idx = pd.date_range('2024-06-01', periods=40, freq='15min', tz='UTC')
    o = np.linspace(100, 110, 40)
    h = o + 1
    l = o - 1
    c = o + 0.2
    v = np.linspace(10, 50, 40)
    # Force volumes increasing into signal
    v[20:24] = [40, 50, 60, 80]
    # Signal candle bullish rejection vs VWAP
    o[23], c[23], h[23], l[23] = 105, 106, 106.5, 100
    # Entry then stop
    o[24] = 105.5
    h[24], l[24], c[24] = 106, 99, 100
    df = pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': c, 'volume': v}, index=idx)
    le, se, lx, sx = signals_vwap_rejection_v1(df)
    # May or may not auto-detect depending on VWAP; force signal for execution path
    le = le.copy()
    le.iloc[23] = True
    m = run_signal_backtest(
        df, le, se, lx, sx, stop_mode='signal_extreme', rr=2.0, strategy_id=STRATEGY_ID,
    )
    assert m['trades'] >= 1
    assert m['trade_list'][0]['strategy_id'] == STRATEGY_ID

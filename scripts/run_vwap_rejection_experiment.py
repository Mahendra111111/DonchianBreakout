#!/usr/bin/env python3
"""VWAP Rejection V1 experiments: per symbol × TF, plus 60/20/20 chronological splits."""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from strategy_research_report import (  # noqa: E402
    EXPORTS,
    FEE,
    INITIAL,
    RISK_PCT,
    SLIP,
    ensure_parquet,
    has_tf_data,
    load_tf,
    run_signal_backtest,
)
from vwap_rejection_v1 import (  # noqa: E402
    STRATEGY_ID,
    STRATEGY_NAME,
    load_config,
    signals_from_config,
)

OUT = EXPORTS / 'vwap_rejection_v1_experiment'
CFG = load_config()
SYMBOLS = CFG.get('symbols') or [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT', 'ADAUSDT',
]
TFS = CFG.get('timeframes') or ['5m', '15m', '1h']
RR = float(CFG.get('execution', {}).get('risk_reward', 2.0))
FUNDING = float(CFG.get('costs', {}).get('funding_rate_8h', 0.0001))


def backtest(df: pd.DataFrame, entry_from=None) -> dict:
    le, se, lx, sx = signals_from_config(df)
    return run_signal_backtest(
        df,
        le,
        se,
        lx,
        sx,
        rr=RR,
        stop_mode='signal_extreme',
        funding_rate_8h=FUNDING,
        strategy_id=STRATEGY_ID,
        entry_from=entry_from,
        fee=FEE,
        slip=SLIP,
        risk_pct=RISK_PCT,
        initial=INITIAL,
    )


def filter_trades(trades: list, start, end) -> list:
    out = []
    for t in trades or []:
        et = pd.Timestamp(t['entry_time'])
        if et.tzinfo is None:
            et = et.tz_localize('UTC')
        s = pd.Timestamp(start)
        e = pd.Timestamp(end)
        if s.tzinfo is None:
            s = s.tz_localize('UTC')
        if e.tzinfo is None:
            e = e.tz_localize('UTC')
        if s <= et < e:
            out.append(t)
    return out


def summarize(metrics: dict, trades: list | None = None) -> dict:
    trades = trades if trades is not None else (metrics.get('trade_list') or [])
    if not trades:
        return {
            'trades': 0,
            'win_rate_pct': None,
            'net_pnl': 0.0,
            'profit_factor': None,
            'max_dd_pct': 0.0,
            'avg_r': None,
            'fees': 0.0,
            'funding': 0.0,
            'slippage': 0.0,
            'final_equity': INITIAL,
            'long_trades': 0,
            'short_trades': 0,
        }
    df = pd.DataFrame(trades)
    net_col = 'net_pnl' if 'net_pnl' in df.columns else 'net'
    wins = df[df[net_col] > 0]
    losses = df[df[net_col] <= 0]
    gp = float(wins[net_col].sum()) if len(wins) else 0.0
    gl = float(-losses[net_col].sum()) if len(losses) else 0.0
    eq = INITIAL
    peak = eq
    max_dd = 0.0
    for n in df[net_col]:
        eq += float(n)
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak if peak else 0)
    return {
        'trades': int(len(df)),
        'win_rate_pct': float((df[net_col] > 0).mean() * 100),
        'net_pnl': float(df[net_col].sum()),
        'profit_factor': float(gp / gl) if gl > 0 else None,
        'max_dd_pct': float(max_dd * 100),
        'avg_r': float(df.realized_r_multiple.dropna().mean())
        if 'realized_r_multiple' in df and df.realized_r_multiple.notna().any()
        else None,
        'fees': float(df.entry_fee.sum() + df.exit_fee.sum()) if 'entry_fee' in df else 0.0,
        'funding': float(df.funding_cost.sum()) if 'funding_cost' in df else 0.0,
        'slippage': float(df.slippage_cost.sum()) if 'slippage_cost' in df else 0.0,
        'final_equity': float(eq),
        'long_trades': int((df.direction == 'LONG').sum()) if 'direction' in df else 0,
        'short_trades': int((df.direction == 'SHORT').sum()) if 'direction' in df else 0,
    }


def equity_curve(trades: list) -> list[dict]:
    eq = INITIAL
    curve = [{'t': None, 'equity': eq}]
    for t in trades:
        eq += float(t.get('net_pnl', t.get('net', 0)))
        curve.append({'t': t.get('exit_time'), 'equity': eq})
    return curve


def write_trades_csv(path: Path, trades: list) -> None:
    if not trades:
        path.write_text('', encoding='utf-8')
        return
    keys = list(trades[0].keys())
    with path.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction='ignore')
        w.writeheader()
        w.writerows(trades)


def split_bounds(df: pd.DataFrame):
    n = len(df)
    i1 = int(n * 0.6)
    i2 = int(n * 0.8)
    return df.index[0], df.index[i1], df.index[i2], df.index[-1] + pd.Timedelta(seconds=1)


def main() -> None:
    ensure_parquet()
    OUT.mkdir(parents=True, exist_ok=True)
    missing = []
    cells = []
    splits = []

    for tf in TFS:
        for sym in SYMBOLS:
            if not has_tf_data(sym, tf):
                missing.append({'symbol': sym, 'timeframe': tf, 'reason': 'missing_ohlcv_cache'})
                print(f'MISSING {sym} {tf}', flush=True)
                continue
            df = load_tf(sym, tf)
            print(f'Experiment {STRATEGY_NAME}: {sym} {tf} ({len(df)} bars)…', flush=True)
            full = backtest(df)
            trades = full.get('trade_list') or []
            summary = summarize(full, trades)
            cells.append({
                'strategy_id': STRATEGY_ID,
                'strategy': STRATEGY_NAME,
                'symbol': sym,
                'timeframe': tf,
                **summary,
                'open_trade': full.get('open_trade'),
            })
            stem = f'{STRATEGY_ID}_{sym}_{tf}'
            write_trades_csv(OUT / f'{stem}_trades.csv', trades)
            (OUT / f'{stem}_equity.json').write_text(
                json.dumps(equity_curve(trades), indent=2),
                encoding='utf-8',
            )

            t0, t60, t80, tend = split_bounds(df)
            for name, a, b in (
                ('train', t0, t60),
                ('validation', t60, t80),
                ('oos', t80, tend),
            ):
                pos = df.index.searchsorted(a)
                warm = max(0, pos - 250)
                sub = df.iloc[warm:]
                m = backtest(sub, entry_from=a)
                part = filter_trades(m.get('trade_list') or [], a, b)
                s = summarize(m, part)
                splits.append({
                    'strategy_id': STRATEGY_ID,
                    'symbol': sym,
                    'timeframe': tf,
                    'split': name,
                    'from': pd.Timestamp(a).isoformat(),
                    'to': pd.Timestamp(b).isoformat(),
                    **s,
                })
                write_trades_csv(OUT / f'{stem}_{name}_trades.csv', part)

    report = {
        'strategy_id': STRATEGY_ID,
        'assumptions': {
            'fee_per_side': FEE,
            'slippage_per_side': SLIP,
            'risk_pct': RISK_PCT,
            'initial_equity': INITIAL,
            'funding_rate_8h': FUNDING,
            'funding_label': 'estimate',
            'stop_mode': 'signal_extreme',
            'risk_reward': RR,
            'splits': '60/20/20 chronological',
            'note': 'Do not invent results for missing datasets.',
        },
        'missing_datasets': missing,
        'full_period_by_symbol_timeframe': cells,
        'train_val_oos': splits,
    }
    (OUT / 'summary.json').write_text(json.dumps(report, indent=2, default=str), encoding='utf-8')
    if cells:
        pd.DataFrame(cells).to_csv(OUT / 'summary_by_cell.csv', index=False)
    if splits:
        pd.DataFrame(splits).to_csv(OUT / 'summary_by_split.csv', index=False)

    print(json.dumps({'cells': len(cells), 'missing': len(missing), 'out': str(OUT.resolve())}, indent=2))


if __name__ == '__main__':
    main()

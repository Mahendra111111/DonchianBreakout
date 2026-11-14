#!/usr/bin/env python3
"""Merge VWAP Rejection V1 research rows into strategy_summary.json (keeps other strategies)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from strategy_research_report import (  # noqa: E402
    PERIODS,
    STRATEGIES,
    STRATEGY_RR,
    SUMMARY,
    SUMMARY_API,
    SYMBOLS,
    TRADES_UI,
    VWAP_STRATEGY_NAME,
    ensure_parquet,
    has_tf_data,
    load_tf,
    period_backtests,
)


def main() -> None:
    ensure_parquet()
    summary_path = SUMMARY if SUMMARY.exists() else SUMMARY_API
    existing = (
        json.loads(summary_path.read_text(encoding='utf-8'))
        if summary_path.exists()
        else {
            'results': [],
            'ranking': [],
            'strategies': [],
            'periods': [p[0] for p in PERIODS],
        }
    )

    results = [r for r in existing.get('results', []) if r.get('strategy') != VWAP_STRATEGY_NAME]
    fn = STRATEGIES[VWAP_STRATEGY_NAME]
    rr = STRATEGY_RR[VWAP_STRATEGY_NAME]
    tfs = ('5m', '15m', '1h')
    new_rows = []
    for tf in tfs:
        for sym in SYMBOLS:
            if not has_tf_data(sym, tf):
                print(f'skip {sym} {tf}', flush=True)
                continue
            print(f'VWAP research {sym} {tf}…', flush=True)
            df = load_tf(sym, tf)
            periods = period_backtests(df, VWAP_STRATEGY_NAME, fn, rr)
            full = periods['5y']
            new_rows.append({
                'strategy': VWAP_STRATEGY_NAME,
                'symbol': sym,
                'timeframe': tf,
                'trades': full['trades'],
                'win_rate_pct': full['win_rate_pct'],
                'net_return_pct': full['net_return_pct'],
                'profit_factor': full['profit_factor'],
                'max_dd_pct': full['max_dd_pct'],
                'expectancy': full['expectancy'],
                'final_equity': full['final_equity'],
                'stop_exit_pct': full['stop_exit_pct'],
                'periods': periods,
            })

    TRADES_UI.mkdir(parents=True, exist_ok=True)
    api_trades = ROOT / 'api' / 'trades'
    api_trades.mkdir(parents=True, exist_ok=True)

    slim_new = []
    for row in new_rows:
        periods_slim = {}
        for label, pdata in (row.get('periods') or {}).items():
            trade_list = pdata.get('trade_list') or []
            key = (
                f"{row['strategy'].replace(' ', '_')}_{row['symbol']}_"
                f"{row['timeframe']}_{label}.json"
            )
            text = json.dumps(trade_list, default=str)
            (TRADES_UI / key).write_text(text, encoding='utf-8')
            (api_trades / key).write_text(text, encoding='utf-8')
            periods_slim[label] = {
                k: v for k, v in pdata.items() if k not in ('trade_list', 'open_trade')
            }
            periods_slim[label]['trades_file'] = key
        slim_new.append({**{k: v for k, v in row.items() if k != 'periods'}, 'periods': periods_slim})

    results.extend(slim_new)

    res = pd.DataFrame([{k: v for k, v in r.items() if k != 'periods'} for r in results])
    strats = list(
        dict.fromkeys(
            list(existing.get('strategies') or [])
            + [VWAP_STRATEGY_NAME]
            + list(STRATEGIES.keys())
        )
    )
    ranking = []
    for strat in strats:
        sub = res[res.strategy == strat]
        if sub.empty:
            continue
        best = sub.sort_values('net_return_pct', ascending=False).iloc[0]
        sub15 = sub[sub.timeframe == '15m']
        sub1h = sub[sub.timeframe == '1h']
        ranking.append({
            'strategy': strat,
            'avg_net_return_pct_15m': float(sub15.net_return_pct.mean()) if len(sub15) else None,
            'avg_net_return_pct_1h': float(sub1h.net_return_pct.mean()) if len(sub1h) else None,
            'avg_win_rate_15m': float(sub15.win_rate_pct.mean())
            if len(sub15) and sub15.win_rate_pct.notna().any() else None,
            'avg_win_rate_1h': float(sub1h.win_rate_pct.mean())
            if len(sub1h) and sub1h.win_rate_pct.notna().any() else None,
            'avg_trades_15m': float(sub15.trades.mean()) if len(sub15) else None,
            'avg_pf_1h': float(sub1h.profit_factor.dropna().mean())
            if len(sub1h) and sub1h.profit_factor.notna().any() else None,
            'best_cell': {
                'symbol': best['symbol'],
                'timeframe': best['timeframe'],
                'net_return_pct': float(best['net_return_pct']),
                'win_rate_pct': float(best['win_rate_pct']) if best['win_rate_pct'] is not None else None,
                'trades': int(best['trades']),
            },
        })
    ranking = sorted(
        ranking,
        key=lambda x: ((x['avg_net_return_pct_1h'] or 0) + (x['avg_net_return_pct_15m'] or 0)) / 2,
        reverse=True,
    )

    payload = {
        'strategies': strats,
        'periods': [p[0] for p in PERIODS],
        'ranking': ranking,
        'results': results,
        'updated': pd.Timestamp.now('UTC').isoformat(),
    }
    text = json.dumps(payload, indent=2, default=str)
    SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY_API.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY.write_text(text, encoding='utf-8')
    SUMMARY_API.write_text(text, encoding='utf-8')
    print(f'Wrote {len(slim_new)} VWAP rows; total results {len(results)}', flush=True)
    print(f'Updated {SUMMARY} and {SUMMARY_API}', flush=True)


if __name__ == '__main__':
    main()

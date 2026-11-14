#!/usr/bin/env python3
"""EMA Trend + Donchian Breakout research backtests on exported OHLCV Excel data."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

EXPORTS = Path('exports')
CACHE = EXPORTS / 'parquet_cache'
REPORT = EXPORTS / 'strategy_research_report.json'
SUMMARY = Path('ui/public/strategy_summary.json')
SUMMARY_API = Path('api/strategy_summary.json')
SYMBOLS = ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')
TFS = ('15m', '1h')
FEE = 0.0005
SLIP = 0.0002
RISK_PCT = 0.005
INITIAL = 10000.0


def ensure_parquet() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    for sym in SYMBOLS:
        xlsx = EXPORTS / f'{sym.lower()}_ohlcv_5y.xlsx'
        for tf in ('5m', '15m', '1h'):
            out = CACHE / f'{sym.lower()}_{tf}.pkl'
            if out.exists():
                continue
            print(f'Caching {sym} {tf} → pickle…', flush=True)
            df = pd.read_excel(xlsx, sheet_name=tf)
            df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
            df = df.set_index('timestamp').sort_index()
            df.to_pickle(out)


def load_tf(symbol: str, tf: str) -> pd.DataFrame:
    path = CACHE / f'{symbol.lower()}_{tf}.pkl'
    df = pd.read_pickle(path)
    if df.index.tz is None:
        df.index = df.index.tz_localize('UTC')
    return df


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev = df.close.shift(1)
    tr = pd.concat([(df.high - df.low), (df.high - prev).abs(), (df.low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def run_signal_backtest(df: pd.DataFrame, long_entry: pd.Series, short_entry: pd.Series,
                        long_exit: pd.Series | None = None, short_exit: pd.Series | None = None,
                        stop_atr: float = 1.5, rr: float = 1.5) -> dict:
    """One-position market sim: enter next open, ATR stop + RR target, optional signal exit."""
    a = atr(df)
    equity = INITIAL
    trades = []
    pos = None
    le = long_entry.fillna(False).astype(bool).values
    se = short_entry.fillna(False).astype(bool).values
    lx = long_exit.fillna(False).astype(bool).values if long_exit is not None else None
    sx = short_exit.fillna(False).astype(bool).values if short_exit is not None else None
    opens = df.open.values
    highs = df.high.values
    lows = df.low.values
    atr_v = a.values
    for i in range(1, len(df)):
        atr_i = float(atr_v[i - 1]) if np.isfinite(atr_v[i - 1]) else np.nan
        if pos is not None:
            stop_hit = (lows[i] <= pos['stop']) if pos['side'] == 1 else (highs[i] >= pos['stop'])
            tp_hit = (highs[i] >= pos['target']) if pos['side'] == 1 else (lows[i] <= pos['target'])
            sig_exit = False
            if pos['side'] == 1 and lx is not None:
                sig_exit = bool(lx[i - 1])
            if pos['side'] == -1 and sx is not None:
                sig_exit = bool(sx[i - 1])
            exit_price = None
            reason = None
            if stop_hit:
                exit_price, reason = pos['stop'], 'stop'
            elif tp_hit:
                exit_price, reason = pos['target'], 'target'
            elif sig_exit:
                exit_price, reason = float(opens[i]), 'signal'
            if exit_price is not None:
                exit_price *= (1 - SLIP) if pos['side'] == 1 else (1 + SLIP)
                gross = pos['side'] * (exit_price - pos['entry']) * pos['qty']
                fees = FEE * (pos['entry'] * pos['qty'] + exit_price * pos['qty'])
                net = gross - fees
                equity += gross - FEE * exit_price * pos['qty']
                trades.append({'net': net, 'reason': reason, 'side': pos['side']})
                pos = None
        if pos is None and np.isfinite(atr_i) and atr_i > 0:
            side = 1 if bool(le[i - 1]) else (-1 if bool(se[i - 1]) else 0)
            if side:
                entry = float(opens[i]) * (1 + SLIP if side == 1 else 1 - SLIP)
                stop = entry - side * stop_atr * atr_i
                dist = abs(entry - stop)
                if dist <= 0:
                    continue
                qty = min((equity * RISK_PCT) / dist, equity / entry)
                if qty <= 0:
                    continue
                target = entry + side * rr * dist
                equity -= FEE * entry * qty
                pos = {'side': side, 'entry': entry, 'stop': stop, 'target': target, 'qty': qty}
    if not trades:
        return {'trades': 0, 'win_rate_pct': None, 'net_return_pct': 0.0, 'profit_factor': None,
                'max_dd_pct': 0.0, 'expectancy': None, 'final_equity': equity, 'stop_exit_pct': None}
    t = pd.DataFrame(trades)
    wins = t[t.net > 0]
    losses = t[t.net <= 0]
    gp = float(wins.net.sum()) if len(wins) else 0.0
    gl = float(-losses.net.sum()) if len(losses) else 0.0
    eq = INITIAL
    peak = eq
    max_dd = 0.0
    for n in t.net:
        eq += n
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak if peak else 0)
    return {
        'trades': int(len(t)),
        'win_rate_pct': float((t.net > 0).mean() * 100),
        'net_return_pct': float((equity / INITIAL - 1) * 100),
        'profit_factor': float(gp / gl) if gl > 0 else None,
        'max_dd_pct': float(max_dd * 100),
        'expectancy': float(t.net.mean()),
        'final_equity': float(equity),
        'stop_exit_pct': float((t.reason == 'stop').mean() * 100),
    }


def signals_ema_trend(df: pd.DataFrame):
    e20 = df.close.ewm(span=20, adjust=False).mean()
    e50 = df.close.ewm(span=50, adjust=False).mean()
    long_e = (e20 > e50) & (e20.shift(1) <= e50.shift(1))
    short_e = (e20 < e50) & (e20.shift(1) >= e50.shift(1))
    long_x = e20 < e50
    short_x = e20 > e50
    return long_e.fillna(False), short_e.fillna(False), long_x.fillna(False), short_x.fillna(False)


def signals_donchian(df: pd.DataFrame, n: int = 20):
    hi = df.high.rolling(n).max().shift(1)
    lo = df.low.rolling(n).min().shift(1)
    long_e = df.close > hi
    short_e = df.close < lo
    return long_e.fillna(False), short_e.fillna(False), short_e.fillna(False), long_e.fillna(False)


STRATEGIES = {
    'EMA Trend Following': signals_ema_trend,
    'Donchian Breakout': signals_donchian,
}


def main():
    ensure_parquet()
    strategy_rows = []
    for tf in TFS:
        for sym in SYMBOLS:
            df = load_tf(sym, tf)
            print(f'Backtesting {sym} {tf}…', flush=True)
            for name, fn in STRATEGIES.items():
                le, se, lx, sx = fn(df)
                metrics = run_signal_backtest(
                    df,
                    le.reindex(df.index).fillna(False),
                    se.reindex(df.index).fillna(False),
                    lx.reindex(df.index).fillna(False),
                    sx.reindex(df.index).fillna(False),
                    stop_atr=1.5,
                    rr=1.5,
                )
                strategy_rows.append({'strategy': name, 'symbol': sym, 'timeframe': tf, **metrics})

    res = pd.DataFrame(strategy_rows)
    summary = []
    for strat in STRATEGIES:
        sub = res[res.strategy == strat]
        best = sub.sort_values('net_return_pct', ascending=False).iloc[0]
        summary.append({
            'strategy': strat,
            'avg_net_return_pct_15m': float(sub[sub.timeframe == '15m'].net_return_pct.mean()),
            'avg_net_return_pct_1h': float(sub[sub.timeframe == '1h'].net_return_pct.mean()),
            'avg_win_rate_15m': float(sub[sub.timeframe == '15m'].win_rate_pct.mean()),
            'avg_win_rate_1h': float(sub[sub.timeframe == '1h'].win_rate_pct.mean()),
            'avg_trades_15m': float(sub[sub.timeframe == '15m'].trades.mean()),
            'avg_pf_1h': float(sub[sub.timeframe == '1h'].profit_factor.dropna().mean())
            if sub[sub.timeframe == '1h'].profit_factor.notna().any() else None,
            'best_cell': {
                'symbol': best['symbol'],
                'timeframe': best['timeframe'],
                'net_return_pct': float(best['net_return_pct']),
                'win_rate_pct': float(best['win_rate_pct']),
                'trades': int(best['trades']),
            },
        })
    summary = sorted(
        summary,
        key=lambda x: (x['avg_net_return_pct_1h'] + x['avg_net_return_pct_15m']) / 2,
        reverse=True,
    )

    report = {
        'assumptions': {
            'market': 'Binance USD-M perpetual OHLCV from exports Excel',
            'strategies': list(STRATEGIES.keys()),
            'fee_per_side': FEE,
            'slippage_per_side': SLIP,
            'risk_pct': RISK_PCT,
            'stop_atr': 1.5,
            'take_profit_R': 1.5,
            'initial_equity': INITIAL,
            'note': 'Research simulation only. Past patterns are not a guarantee of future profits.',
        },
        'strategy_results': strategy_rows,
        'strategy_ranking': summary,
    }
    REPORT.write_text(json.dumps(report, indent=2, default=str))
    payload = {
        'strategies': list(STRATEGIES.keys()),
        'ranking': summary,
        'results': strategy_rows,
        'updated': pd.Timestamp.utcnow().isoformat(),
    }
    text = json.dumps(payload, indent=2, default=str)
    SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY_API.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY.write_text(text)
    SUMMARY_API.write_text(text)
    print(json.dumps(summary, indent=2))
    print(f'\nWrote {REPORT.resolve()}')
    print(f'Wrote {SUMMARY.resolve()}')
    print(f'Wrote {SUMMARY_API.resolve()}')


if __name__ == '__main__':
    main()

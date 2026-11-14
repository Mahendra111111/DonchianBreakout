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
TRADES_UI = Path('ui/public/trades')
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


PERIODS = (
    ('7d', 7),
    ('15d', 15),
    ('1m', 30),
    ('3m', 90),
    ('6m', 180),
    ('1y', 365),
    ('3y', 365 * 3),
    ('5y', 365 * 5),
)
WARMUP_BARS = 250


def run_signal_backtest(df: pd.DataFrame, long_entry: pd.Series, short_entry: pd.Series,
                        long_exit: pd.Series | None = None, short_exit: pd.Series | None = None,
                        stop_atr: float = 1.5, rr: float = 1.5,
                        entry_from: pd.Timestamp | None = None) -> dict:
    """One-position market sim: enter next open, ATR stop + RR target, optional signal exit.

    If entry_from is set, only trades entered on/after that timestamp are kept in metrics.
    """
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
    times = df.index.to_numpy()
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
                trades.append({
                    'entry_time': pd.Timestamp(times[pos['i']]).isoformat(),
                    'exit_time': pd.Timestamp(times[i]).isoformat(),
                    'side': 'LONG' if pos['side'] == 1 else 'SHORT',
                    'entry': float(pos['entry']),
                    'exit': float(exit_price),
                    'net': float(net),
                    'reason': reason,
                    'outcome': 'successful' if net > 0 else 'failed',
                })
                pos = None
        if pos is None and np.isfinite(atr_i) and atr_i > 0:
            side = 1 if bool(le[i - 1]) else (-1 if bool(se[i - 1]) else 0)
            if side:
                ts = pd.Timestamp(times[i])
                if entry_from is not None and ts < entry_from:
                    continue
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
                pos = {'side': side, 'entry': entry, 'stop': stop, 'target': target, 'qty': qty, 'i': i}
    if not trades:
        return {
            'trades': 0, 'win_rate_pct': None, 'net_return_pct': 0.0, 'profit_factor': None,
            'max_dd_pct': 0.0, 'expectancy': None, 'final_equity': equity, 'stop_exit_pct': None,
            'trade_list': [],
        }
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
        'trade_list': trades,
    }


def period_backtests(df: pd.DataFrame, name: str, fn, rr: float) -> dict:
    """Run each lookback window with indicator warmup; return metrics + trade records."""
    end = df.index.max()
    out = {}
    for label, days in PERIODS:
        start = end - pd.Timedelta(days=days)
        # warmup bars before window for SMA/EMA/Donchian
        if len(df) <= WARMUP_BARS + 5:
            sub = df
            entry_from = start
        else:
            # find index for start, then take WARMUP_BARS before it
            pos = df.index.searchsorted(start)
            warm_pos = max(0, pos - WARMUP_BARS)
            sub = df.iloc[warm_pos:]
            entry_from = start
        le, se, lx, sx = fn(sub)
        metrics = run_signal_backtest(
            sub,
            le.reindex(sub.index).fillna(False),
            se.reindex(sub.index).fillna(False),
            lx.reindex(sub.index).fillna(False),
            sx.reindex(sub.index).fillna(False),
            stop_atr=1.5,
            rr=rr,
            entry_from=entry_from,
        )
        out[label] = {
            'period': label,
            'days': days,
            'from': start.isoformat(),
            'to': end.isoformat(),
            'trades': metrics['trades'],
            'win_rate_pct': metrics['win_rate_pct'],
            'net_return_pct': metrics['net_return_pct'],
            'profit_factor': metrics['profit_factor'],
            'max_dd_pct': metrics['max_dd_pct'],
            'expectancy': metrics['expectancy'],
            'final_equity': metrics['final_equity'],
            'stop_exit_pct': metrics['stop_exit_pct'],
            'trade_list': metrics['trade_list'],
        }
    return out


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


def signals_hammer_sma_vwap(df: pd.DataFrame, sma_len: int = 200):
    """Pine: Hammer/Hanging Man + SMA + session VWAP touch."""
    body = (df.close - df.open).abs()
    range_ = (df.high - df.low).replace(0, np.nan)
    up_wick = df.high - df[['close', 'open']].max(axis=1)
    dn_wick = df[['close', 'open']].min(axis=1) - df.low
    small_upper = up_wick <= np.maximum(body * 0.5, range_ * 0.12)
    small_lower = dn_wick <= np.maximum(body * 0.5, range_ * 0.12)
    hammer_shape = (range_ > 0) & (body > 0) & (dn_wick >= 2.0 * body) & small_upper
    inv_shape = (range_ > 0) & (body > 0) & (up_wick >= 2.0 * body) & small_lower
    is_pattern = hammer_shape | inv_shape

    sma = df.close.rolling(sma_len).mean()
    above = df.close > sma
    below = df.close < sma
    sma_ready = sma.notna()

    day = df.index.floor('D')
    typical = (df.high + df.low + df.close) / 3.0
    cum_pv = (typical * df.volume).groupby(day).cumsum()
    cum_v = df.volume.groupby(day).cumsum().replace(0, np.nan)
    vwap = cum_pv / cum_v
    touches = vwap.notna() & (df.low <= vwap) & (df.high >= vwap)

    long_e = is_pattern & above & sma_ready & touches
    short_e = is_pattern & below & sma_ready & touches
    # Opposite qualified signal closes the trade (matches Pine strategy.close)
    return long_e.fillna(False), short_e.fillna(False), short_e.fillna(False), long_e.fillna(False)


STRATEGIES = {
    'EMA Trend Following': signals_ema_trend,
    'Donchian Breakout': signals_donchian,
    'Hammer SMA VWAP': signals_hammer_sma_vwap,
}

# Pine defaults: ATR stop 1.5, RR 2.0 for hammer; others keep 1.5R
STRATEGY_RR = {
    'EMA Trend Following': 1.5,
    'Donchian Breakout': 1.5,
    'Hammer SMA VWAP': 2.0,
}


def main():
    ensure_parquet()
    strategy_rows = []
    for tf in TFS:
        for sym in SYMBOLS:
            df = load_tf(sym, tf)
            print(f'Backtesting {sym} {tf}…', flush=True)
            for name, fn in STRATEGIES.items():
                rr = STRATEGY_RR.get(name, 1.5)
                periods = period_backtests(df, name, fn, rr)
                full = periods['5y']
                strategy_rows.append({
                    'strategy': name,
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

    res = pd.DataFrame([{k: v for k, v in r.items() if k != 'periods'} for r in strategy_rows])
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
            'periods': [p[0] for p in PERIODS],
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
    # Full report kept locally (gitignored) — includes every trade
    REPORT.write_text(json.dumps(report, indent=2, default=str))

    # Slim UI/API payload: period metrics only; trade lists in ui/public/trades
    TRADES_UI.mkdir(parents=True, exist_ok=True)
    slim_rows = []
    for row in strategy_rows:
        periods_slim = {}
        for label, pdata in (row.get('periods') or {}).items():
            trade_list = pdata.get('trade_list') or []
            key = (
                f"{row['strategy'].replace(' ', '_')}_{row['symbol']}_"
                f"{row['timeframe']}_{label}.json"
            )
            (TRADES_UI / key).write_text(json.dumps(trade_list, default=str))
            periods_slim[label] = {k: v for k, v in pdata.items() if k != 'trade_list'}
            periods_slim[label]['trades_file'] = key
        slim_rows.append({**{k: v for k, v in row.items() if k != 'periods'}, 'periods': periods_slim})

    payload = {
        'strategies': list(STRATEGIES.keys()),
        'periods': [p[0] for p in PERIODS],
        'ranking': summary,
        'results': slim_rows,
        'updated': pd.Timestamp.now('UTC').isoformat(),
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
    print(f'Wrote trade files under {TRADES_UI.resolve()}')


if __name__ == '__main__':
    main()

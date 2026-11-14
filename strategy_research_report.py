#!/usr/bin/env python3
"""EMA / Donchian / Hammer / VWAP Rejection research backtests on exported OHLCV."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from vwap_rejection_v1 import STRATEGY_ID as VWAP_STRATEGY_ID
from vwap_rejection_v1 import STRATEGY_NAME as VWAP_STRATEGY_NAME
from vwap_rejection_v1 import load_config as load_vwap_config
from vwap_rejection_v1 import signals_from_config as signals_vwap_rejection_v1

EXPORTS = Path('exports')
CACHE = EXPORTS / 'parquet_cache'
REPORT = EXPORTS / 'strategy_research_report.json'
SUMMARY = Path('ui/public/strategy_summary.json')
SUMMARY_API = Path('api/strategy_summary.json')
TRADES_UI = Path('ui/public/trades')
SYMBOLS = (
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT', 'ADAUSDT',
)
TFS = ('15m', '1h')
FEE = 0.0005
SLIP = 0.0002
RISK_PCT = 0.005
INITIAL = 10000.0


def ensure_parquet() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    for sym in SYMBOLS:
        xlsx = EXPORTS / f'{sym.lower()}_ohlcv_5y.xlsx'
        if not xlsx.exists():
            print(f'Skip cache {sym}: missing {xlsx}', flush=True)
            continue
        for tf in ('5m', '15m', '1h'):
            out = CACHE / f'{sym.lower()}_{tf}.pkl'
            if out.exists():
                continue
            print(f'Caching {sym} {tf} → pickle…', flush=True)
            df = pd.read_excel(xlsx, sheet_name=tf)
            df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
            df = df.set_index('timestamp').sort_index()
            df.to_pickle(out)


def has_tf_data(symbol: str, tf: str) -> bool:
    return (CACHE / f'{symbol.lower()}_{tf}.pkl').exists()


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

EXIT_REASON_MAP = {
    'stop': 'STOP_LOSS',
    'target': 'TAKE_PROFIT',
    'signal': 'SIGNAL',
    'end_of_data': 'END_OF_DATA',
}


def _funding_cost(side: int, qty: float, entry: float, entry_i: int, exit_i: int,
                  times, rate_8h: float) -> float:
    """Estimate funding: rate * notional per 8h interval the position spans (labeled estimate)."""
    if rate_8h == 0 or exit_i <= entry_i:
        return 0.0
    t0 = pd.Timestamp(times[entry_i])
    t1 = pd.Timestamp(times[exit_i])
    hours = max((t1 - t0).total_seconds() / 3600.0, 0.0)
    periods = hours / 8.0
    # Longs pay when rate > 0 (common convention for positive funding)
    signed = rate_8h * periods * abs(entry * qty)
    return float(signed if side == 1 else -signed)


def run_signal_backtest(
    df: pd.DataFrame,
    long_entry: pd.Series,
    short_entry: pd.Series,
    long_exit: pd.Series | None = None,
    short_exit: pd.Series | None = None,
    stop_atr: float = 1.5,
    rr: float = 1.5,
    entry_from: pd.Timestamp | None = None,
    stop_mode: str = 'atr',
    funding_rate_8h: float = 0.0,
    strategy_id: str | None = None,
    fee: float = FEE,
    slip: float = SLIP,
    risk_pct: float = RISK_PCT,
    initial: float = INITIAL,
) -> dict:
    """One-position market sim: enter next open; ATR or signal_extreme stop + RR target.

    stop_mode:
      - 'atr': stop from ATR (legacy strategies)
      - 'signal_extreme': SL = signal bar low/high; reject gap-through entries

    If entry_from is set, only trades entered on/after that timestamp are kept in metrics.
    """
    a = atr(df)
    equity = initial
    trades = []
    open_trade = None
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
    trade_seq = 0

    def close_position(i: int, exit_price: float, reason: str) -> None:
        nonlocal equity, pos, trade_seq
        raw_exit = float(exit_price)
        slipped = raw_exit * ((1 - slip) if pos['side'] == 1 else (1 + slip))
        entry_fee = fee * pos['entry'] * pos['qty']
        exit_fee = fee * slipped * pos['qty']
        slip_cost = abs(slipped - raw_exit) * pos['qty']
        fund = _funding_cost(
            pos['side'], pos['qty'], pos['entry'], pos['i'], i, times, funding_rate_8h,
        )
        gross = pos['side'] * (slipped - pos['entry']) * pos['qty']
        net = gross - entry_fee - exit_fee - fund
        # entry fee already deducted from equity at open
        equity += gross - exit_fee - fund
        risk_amt = abs(pos['entry'] - pos['stop']) * pos['qty']
        reward_amt = abs(pos['target'] - pos['entry']) * pos['qty']
        r_mult = (gross / risk_amt) if risk_amt > 0 else None
        trade_seq += 1
        exit_code = EXIT_REASON_MAP.get(reason, reason.upper())
        trades.append({
            'trade_id': f'{strategy_id or "STRAT"}_{trade_seq}',
            'strategy_id': strategy_id,
            'entry_time': pd.Timestamp(times[pos['i']]).isoformat(),
            'exit_time': pd.Timestamp(times[i]).isoformat(),
            'signal_timestamp': pd.Timestamp(times[pos['signal_i']]).isoformat(),
            'side': 'LONG' if pos['side'] == 1 else 'SHORT',
            'direction': 'LONG' if pos['side'] == 1 else 'SHORT',
            'entry': float(pos['entry']),
            'entry_price': float(pos['entry']),
            'exit': float(slipped),
            'exit_price': float(slipped),
            'stop': float(pos['stop']),
            'stop_loss': float(pos['stop']),
            'target': float(pos['target']),
            'take_profit': float(pos['target']),
            'quantity': float(pos['qty']),
            'gross_pnl': float(gross),
            'entry_fee': float(entry_fee),
            'exit_fee': float(exit_fee),
            'slippage_cost': float(slip_cost),
            'funding_cost': float(fund),
            'net': float(net),
            'net_pnl': float(net),
            'pnl_percentage': float(net / (pos['entry'] * pos['qty']) * 100) if pos['qty'] else 0.0,
            'risk_amount': float(risk_amt),
            'reward_amount': float(reward_amt),
            'realized_r_multiple': float(r_mult) if r_mult is not None else None,
            'reason': reason,
            'exit_reason': exit_code,
            'trade_status': 'CLOSED',
            'outcome': 'successful' if net > 0 else 'failed',
        })
        pos = None

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
            if stop_hit:
                close_position(i, pos['stop'], 'stop')
            elif tp_hit:
                close_position(i, pos['target'], 'target')
            elif sig_exit:
                close_position(i, float(opens[i]), 'signal')

        if pos is None:
            side = 1 if bool(le[i - 1]) else (-1 if bool(se[i - 1]) else 0)
            if not side:
                continue
            ts = pd.Timestamp(times[i])
            if entry_from is not None and ts < entry_from:
                continue
            signal_i = i - 1
            raw_open = float(opens[i])
            entry = raw_open * (1 + slip if side == 1 else 1 - slip)

            if stop_mode == 'signal_extreme':
                stop = float(lows[signal_i]) if side == 1 else float(highs[signal_i])
                if side == 1 and raw_open <= stop:
                    continue
                if side == -1 and raw_open >= stop:
                    continue
            else:
                if not (np.isfinite(atr_i) and atr_i > 0):
                    continue
                stop = entry - side * stop_atr * atr_i

            dist = abs(entry - stop)
            if dist <= 0 or entry == stop:
                continue
            qty = min((equity * risk_pct) / dist, equity / entry)
            if qty <= 0:
                continue
            target = entry + side * rr * dist
            equity -= fee * entry * qty
            pos = {
                'side': side,
                'entry': entry,
                'stop': stop,
                'target': target,
                'qty': qty,
                'i': i,
                'signal_i': signal_i,
            }
            # Entry at open — same bar OHLC can still hit SL/TP (SL first)
            stop_hit = (lows[i] <= pos['stop']) if pos['side'] == 1 else (highs[i] >= pos['stop'])
            tp_hit = (highs[i] >= pos['target']) if pos['side'] == 1 else (lows[i] <= pos['target'])
            if stop_hit:
                close_position(i, pos['stop'], 'stop')
            elif tp_hit:
                close_position(i, pos['target'], 'target')

    if pos is not None:
        last = len(df) - 1
        mark = float(df.close.values[last])
        fund = _funding_cost(
            pos['side'], pos['qty'], pos['entry'], pos['i'], last, times, funding_rate_8h,
        )
        unreal = pos['side'] * (mark - pos['entry']) * pos['qty'] - fund
        open_trade = {
            'trade_id': f'{strategy_id or "STRAT"}_OPEN',
            'strategy_id': strategy_id,
            'entry_time': pd.Timestamp(times[pos['i']]).isoformat(),
            'signal_timestamp': pd.Timestamp(times[pos['signal_i']]).isoformat(),
            'side': 'LONG' if pos['side'] == 1 else 'SHORT',
            'entry': float(pos['entry']),
            'stop_loss': float(pos['stop']),
            'take_profit': float(pos['target']),
            'quantity': float(pos['qty']),
            'mark': mark,
            'unrealized_pnl': float(unreal),
            'funding_cost': float(fund),
            'exit_reason': 'END_OF_DATA',
            'trade_status': 'OPEN',
        }

    if not trades:
        return {
            'trades': 0, 'win_rate_pct': None, 'net_return_pct': 0.0, 'profit_factor': None,
            'max_dd_pct': 0.0, 'expectancy': None, 'final_equity': equity, 'stop_exit_pct': None,
            'trade_list': [], 'open_trade': open_trade,
        }
    t = pd.DataFrame(trades)
    wins = t[t.net > 0]
    losses = t[t.net <= 0]
    gp = float(wins.net.sum()) if len(wins) else 0.0
    gl = float(-losses.net.sum()) if len(losses) else 0.0
    eq = initial
    peak = eq
    max_dd = 0.0
    for n in t.net:
        eq += n
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak if peak else 0)
    return {
        'trades': int(len(t)),
        'win_rate_pct': float((t.net > 0).mean() * 100),
        'net_return_pct': float((equity / initial - 1) * 100),
        'profit_factor': float(gp / gl) if gl > 0 else None,
        'max_dd_pct': float(max_dd * 100),
        'expectancy': float(t.net.mean()),
        'final_equity': float(equity),
        'stop_exit_pct': float((t.reason == 'stop').mean() * 100),
        'trade_list': trades,
        'open_trade': open_trade,
    }


def period_backtests(df: pd.DataFrame, name: str, fn, rr: float) -> dict:
    """Run each lookback window with indicator warmup; return metrics + trade records."""
    end = df.index.max()
    out = {}
    stop_mode = STRATEGY_STOP_MODE.get(name, 'atr')
    funding = STRATEGY_FUNDING.get(name, 0.0)
    strategy_id = STRATEGY_IDS.get(name)
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
            stop_mode=stop_mode,
            funding_rate_8h=funding,
            strategy_id=strategy_id,
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
            'open_trade': metrics.get('open_trade'),
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


def _signals_vwap_wrapper(df: pd.DataFrame):
    return signals_vwap_rejection_v1(df, load_vwap_config())


STRATEGIES = {
    'EMA Trend Following': signals_ema_trend,
    'Donchian Breakout': signals_donchian,
    'Hammer SMA VWAP': signals_hammer_sma_vwap,
    VWAP_STRATEGY_NAME: _signals_vwap_wrapper,
}

# Pine defaults: ATR stop 1.5, RR 2.0 for hammer / VWAP; others keep 1.5R
STRATEGY_RR = {
    'EMA Trend Following': 1.5,
    'Donchian Breakout': 1.5,
    'Hammer SMA VWAP': 2.0,
    VWAP_STRATEGY_NAME: 2.0,
}

STRATEGY_STOP_MODE = {
    'EMA Trend Following': 'atr',
    'Donchian Breakout': 'atr',
    'Hammer SMA VWAP': 'atr',
    VWAP_STRATEGY_NAME: 'signal_extreme',
}

STRATEGY_FUNDING = {
    'EMA Trend Following': 0.0,
    'Donchian Breakout': 0.0,
    'Hammer SMA VWAP': 0.0,
    # Estimate only — labeled in config costs.funding_label
    VWAP_STRATEGY_NAME: float(load_vwap_config().get('costs', {}).get('funding_rate_8h', 0.0001)),
}

STRATEGY_IDS = {
    'EMA Trend Following': 'EMA_TREND',
    'Donchian Breakout': 'DONCHIAN',
    'Hammer SMA VWAP': 'HAMMER_SMA_VWAP',
    VWAP_STRATEGY_NAME: VWAP_STRATEGY_ID,
}


def main():
    ensure_parquet()
    strategy_rows = []
    missing = []
    for tf in TFS:
        for sym in SYMBOLS:
            if not has_tf_data(sym, tf):
                missing.append(f'{sym}/{tf}')
                print(f'Skip missing data {sym} {tf}', flush=True)
                continue
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

    if not strategy_rows:
        print('No backtest rows — missing all OHLCV datasets.', flush=True)
        print('Missing:', missing, flush=True)
        return

    res = pd.DataFrame([{k: v for k, v in r.items() if k != 'periods'} for r in strategy_rows])
    summary = []
    for strat in STRATEGIES:
        sub = res[res.strategy == strat]
        if sub.empty:
            continue
        best = sub.sort_values('net_return_pct', ascending=False).iloc[0]
        sub15 = sub[sub.timeframe == '15m']
        sub1h = sub[sub.timeframe == '1h']
        summary.append({
            'strategy': strat,
            'avg_net_return_pct_15m': float(sub15.net_return_pct.mean()) if len(sub15) else None,
            'avg_net_return_pct_1h': float(sub1h.net_return_pct.mean()) if len(sub1h) else None,
            'avg_win_rate_15m': float(sub15.win_rate_pct.mean()) if len(sub15) and sub15.win_rate_pct.notna().any() else None,
            'avg_win_rate_1h': float(sub1h.win_rate_pct.mean()) if len(sub1h) and sub1h.win_rate_pct.notna().any() else None,
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
    summary = sorted(
        summary,
        key=lambda x: (
            ((x['avg_net_return_pct_1h'] or 0) + (x['avg_net_return_pct_15m'] or 0)) / 2
        ),
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

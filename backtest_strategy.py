#!/usr/bin/env python3
"""Reproducible BTCUSDT perpetual trend-pullback backtest.

Input: Binance-style 15m OHLCV CSV with columns timestamp/open/high/low/close/volume.
Optional funding CSV: timestamp,funding_rate; funding_rate is decimal per funding event.
No exchange orders are sent. This is research code, not trading advice.
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
import numpy as np
import pandas as pd


def prepare_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize an OHLCV frame (CSV or Supabase) into the backtest input shape."""
    df = df.copy()
    df.columns = [str(c).strip().lower() for c in df.columns]
    # Binance Vision kline CSVs have no header; detect and assign their standard column order.
    if 'timestamp' not in df.columns and len(df.columns) >= 6:
        first = pd.to_numeric(df.iloc[:5, 0], errors='coerce')
        if first.notna().sum() >= 3:
            names = ['timestamp','open','high','low','close','volume','close_time','quote_volume','trade_count','taker_buy_base','taker_buy_quote','ignore']
            df.columns = names[:len(df.columns)]
    aliases = {'time':'timestamp','date':'timestamp','datetime':'timestamp','opentime':'timestamp','open_time':'timestamp','ts':'timestamp'}
    df = df.rename(columns={c: aliases[c] for c in df.columns if c in aliases})
    required = ['timestamp','open','high','low','close','volume']
    missing = [c for c in required if c not in df.columns]
    if missing: raise ValueError(f'Missing columns: {missing}. Required: {required}')
    raw_ts = df['timestamp']
    numeric_ts = pd.to_numeric(raw_ts, errors='coerce')
    if numeric_ts.notna().sum() >= max(1, int(0.8 * len(df))):
        median_ts = float(numeric_ts.dropna().median())
        unit = 'ms' if median_ts > 100_000_000_000 else ('s' if median_ts > 1_000_000_000 else 'ns')
        ts = pd.to_datetime(numeric_ts, unit=unit, utc=True, errors='coerce')
    else:
        ts = pd.to_datetime(raw_ts, utc=True, errors='coerce', format='ISO8601')
    df['timestamp'] = ts
    df = df.dropna(subset=required).sort_values('timestamp').drop_duplicates('timestamp').set_index('timestamp')
    for c in ['open','high','low','close','volume']: df[c] = pd.to_numeric(df[c], errors='coerce')
    df = df.dropna(subset=['open','high','low','close'])
    if len(df) < 300: raise ValueError(f'Only {len(df)} candles. Need substantially more data for indicators and testing.')
    return df[required[1:]].astype(float)


def load_ohlcv(path: str) -> pd.DataFrame:
    return prepare_ohlcv(pd.read_csv(path))


def _adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Wilder-style ADX used to skip flat/sideways regimes."""
    up = df.high.diff()
    down = -df.low.diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
    prev_close = df.close.shift(1)
    tr = pd.concat([(df.high - df.low), (df.high - prev_close).abs(), (df.low - prev_close).abs()], axis=1).max(axis=1)
    alpha = 1 / period
    atr = tr.ewm(alpha=alpha, adjust=False, min_periods=period).mean()
    plus_di = 100 * plus_dm.ewm(alpha=alpha, adjust=False, min_periods=period).mean() / atr.replace(0, np.nan)
    minus_di = 100 * minus_dm.ewm(alpha=alpha, adjust=False, min_periods=period).mean() / atr.replace(0, np.nan)
    dx = (100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan))
    return dx.ewm(alpha=alpha, adjust=False, min_periods=period).mean()


def indicators(df: pd.DataFrame, adx_min: float = 20.0) -> pd.DataFrame:
    x = df.copy()
    # Treat input timestamps as candle OPEN times; indicator calculations use candle CLOSE times.
    x.index = x.index + pd.Timedelta(minutes=15)
    x['ema20'] = x.close.ewm(span=20, adjust=False).mean()
    delta = x.close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1/14, adjust=False, min_periods=14).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1/14, adjust=False, min_periods=14).mean()
    rs = gain / loss.replace(0, np.nan)
    x['rsi'] = 100 - 100/(1+rs)
    prev_close = x.close.shift(1)
    tr = pd.concat([(x.high-x.low), (x.high-prev_close).abs(), (x.low-prev_close).abs()], axis=1).max(axis=1)
    x['atr'] = tr.ewm(alpha=1/14, adjust=False, min_periods=14).mean()
    x['adx'] = _adx(x)
    # A 4h bar is only available at its close. right-labelled resampling prevents forward leakage.
    h4 = x[['open','high','low','close','volume']].resample('4h', label='right', closed='right', origin='start_day').agg(
        {'open':'first','high':'max','low':'min','close':'last','volume':'sum'}).dropna(subset=['close'])
    h4['ema50_4h'] = h4.close.ewm(span=50, adjust=False).mean()
    h4['ema200_4h'] = h4.close.ewm(span=200, adjust=False).mean()
    # Rising/falling EMA50 on the completed 4H bar filters weak/sideways trends.
    h4['ema50_4h_slope_up'] = h4['ema50_4h'] > h4['ema50_4h'].shift(1)
    h4['ema50_4h_slope_down'] = h4['ema50_4h'] < h4['ema50_4h'].shift(1)
    # Trend filter uses the last completed 4H close vs 4H EMAs — not the live 15m close.
    x = x.join(
        h4[['close', 'ema50_4h', 'ema200_4h', 'ema50_4h_slope_up', 'ema50_4h_slope_down']]
        .rename(columns={'close': 'close_4h'})
        .reindex(x.index, method='ffill')
    )
    x['rsi_prev'] = x.rsi.shift(1)
    x['prev_high'] = x.high.shift(1)
    x['prev_low'] = x.low.shift(1)
    # Swing levels exclude the signal candle, so the stop is based only on prior completed candles.
    x['swing_low'] = x.low.shift(1).rolling(10, min_periods=10).min()
    x['swing_high'] = x.high.shift(1).rolling(10, min_periods=10).max()
    # Pullback: close near EMA20 AND wick actually touches it (fewer noise signals).
    near_ema = (x.close - x.ema20).abs() <= 0.5 * x.atr
    wick_touch = (x.low <= x.ema20) & (x.high >= x.ema20)
    trend_ok = x.adx >= adx_min
    bull_4h = (x.close_4h > x.ema200_4h) & (x.ema50_4h > x.ema200_4h) & x.ema50_4h_slope_up
    bear_4h = (x.close_4h < x.ema200_4h) & (x.ema50_4h < x.ema200_4h) & x.ema50_4h_slope_down
    rsi_long = (x.rsi_prev <= 50) & (x.rsi > 50)
    rsi_short = (x.rsi_prev >= 50) & (x.rsi < 50)
    # Reclaim confirmation: close back on the trend side of EMA20 plus break of prior high/low.
    reclaim_long = (x.close > x.ema20) & (x.close > x.prev_high)
    reclaim_short = (x.close < x.ema20) & (x.close < x.prev_low)
    x['long_signal'] = bull_4h & trend_ok & near_ema & wick_touch & rsi_long & reclaim_long
    x['short_signal'] = bear_4h & trend_ok & near_ema & wick_touch & rsi_short & reclaim_short
    return x


def prepare_funding(f: pd.DataFrame):
    """Normalize a funding frame (CSV or Supabase) into a rate series indexed by timestamp."""
    f = f.copy()
    f.columns = [str(c).strip().lower() for c in f.columns]
    # Binance Vision funding-rate CSVs may have no header: symbol,fundingTime,fundingRate,markPrice.
    if 'timestamp' not in f.columns and len(f.columns) >= 3:
        first = pd.to_numeric(f.iloc[:5, 1], errors='coerce')
        if first.notna().sum() >= 3:
            names = ['symbol','timestamp','funding_rate','mark_price']
            f.columns = names[:len(f.columns)]
    f = f.rename(columns={'fundingtime':'timestamp','fundingrate':'funding_rate','ts':'timestamp'})
    if 'timestamp' not in f or 'funding_rate' not in f: raise ValueError('Funding data must have timestamp,funding_rate columns.')
    numeric_ts = pd.to_numeric(f.timestamp, errors='coerce')
    if numeric_ts.notna().sum() >= max(1, int(0.8 * len(f))):
        median_ts = float(numeric_ts.dropna().median())
        unit = 'ms' if median_ts > 100_000_000_000 else ('s' if median_ts > 1_000_000_000 else 'ns')
        ts = pd.to_datetime(numeric_ts, unit=unit, utc=True, errors='coerce')
    else:
        ts = pd.to_datetime(f.timestamp, utc=True, errors='coerce', format='ISO8601')
    f['timestamp'] = ts
    return f.dropna(subset=['timestamp','funding_rate']).sort_values('timestamp').set_index('timestamp')['funding_rate'].astype(float)


def load_funding(path: str | None):
    if not path: return None
    return prepare_funding(pd.read_csv(path))


def run_backtest(x: pd.DataFrame, initial_equity=10000.0, risk_pct=0.005, rr=1.5,
                 fee_rate=0.0005, slippage=0.0002, max_stop_atr=3.0, min_stop_atr=1.5,
                 funding=None, daily_loss_limit=0.01, monthly_pause=0.05):
    equity = float(initial_equity); peak = equity; max_dd = 0.0
    trades=[]; equity_curve=[]; pos=None; day_start=equity; day_key=None; month_key=None; month_start=equity
    consecutive_losses=0; paused_day=False; paused_month=False
    # Signal at bar close; fill at next bar open. Conservative stop-first when SL and TP both touched.
    for i in range(1, len(x)):
        row = x.iloc[i]; prev = x.iloc[i-1]; ts = x.index[i]
        dkey = ts.date(); mkey = (ts.year, ts.month)
        if dkey != day_key: day_key=dkey; day_start=equity; paused_day=False; consecutive_losses=0
        if mkey != month_key: month_key=mkey; month_start=equity; paused_month=False
        if not paused_month and equity <= month_start*(1-monthly_pause): paused_month=True
        if not paused_day and equity <= day_start*(1-daily_loss_limit): paused_day=True
        if pos:
            # Funding events are charged to position notional; only applied when a supplied rate timestamp is crossed.
            if funding is not None:
                rates = funding[(funding.index > pos['last_funding_check']) & (funding.index <= ts)]
                for fts, fr in rates.items():
                    # Positive funding: longs pay shorts. Negative funding reverses this.
                    cash = -pos['side'] * pos['qty'] * row.open * float(fr)
                    equity += cash; pos['funding'] += cash
                    pos['last_funding_check'] = fts
            stop_hit = (row.low <= pos['stop']) if pos['side']==1 else (row.high >= pos['stop'])
            tp_hit = (row.high >= pos['target']) if pos['side']==1 else (row.low <= pos['target'])
            exit_price = None; reason=None
            if stop_hit: exit_price=pos['stop']; reason='stop'  # pessimistic if both are touched
            elif tp_hit: exit_price=pos['target']; reason='target'
            if exit_price is not None:
                exit_price *= (1-slippage) if pos['side']==1 else (1+slippage)
                gross = pos['side']*(exit_price-pos['entry'])*pos['qty']
                fees = fee_rate*(pos['entry']*pos['qty'] + exit_price*pos['qty'])
                net = gross - fees
                # Entry fee was deducted at entry; subtract only the exit fee from account equity here.
                equity += gross - fee_rate*(exit_price*pos['qty'])
                net += pos['funding']
                ret_r = net / pos['risk_cash'] if pos['risk_cash'] else 0
                trades.append({**{k:pos[k] for k in ['entry_time','side_text','entry','stop','target','qty','risk_cash']},
                    'exit_time':ts.isoformat(),'exit':exit_price,'exit_reason':reason,'gross_pnl':gross,'fees':fees,
                    'funding_pnl':pos['funding'],'net_pnl':net,'r_multiple':ret_r,'equity_after':equity})
                consecutive_losses = consecutive_losses+1 if net < 0 else 0
                pos=None
        if pos is None and not paused_day and not paused_month and consecutive_losses < 3:
            side = 1 if bool(prev.long_signal) else (-1 if bool(prev.short_signal) else 0)
            if side:
                entry = float(row.open) * (1+slippage if side==1 else 1-slippage)
                atr = float(prev.atr); swing = float(prev.swing_low if side==1 else prev.swing_high)
                if not np.isfinite(atr) or atr <= 0 or not np.isfinite(swing):
                    equity_curve.append({'timestamp':ts.isoformat(),'equity':equity}); continue
                # Wider min stop (1.5 ATR) reduces noise stop-outs vs the old 1.0 ATR floor.
                atr_stop = entry - side * min_stop_atr * atr
                stop = min(swing, atr_stop) if side == 1 else max(swing, atr_stop)
                distance = abs(entry-stop)
                if distance <= 0 or distance > max_stop_atr*atr: equity_curve.append({'timestamp':ts.isoformat(),'equity':equity}); continue
                risk_cash = equity*risk_pct
                qty = risk_cash/distance
                # Limit notional to available equity times 1x by default (isolated-margin conservative baseline).
                qty = min(qty, equity/entry)
                target = entry + side*rr*distance
                entry_fee = fee_rate*entry*qty
                equity -= entry_fee
                pos={'entry_time':ts.isoformat(),'side':side,'side_text':'LONG' if side==1 else 'SHORT','entry':entry,
                     'stop':stop,'target':target,'qty':qty,'risk_cash':risk_cash,'funding':0.0,
                     'last_funding_check':ts-pd.Timedelta(nanoseconds=1),'entry_fee':entry_fee}
        peak=max(peak,equity); max_dd=max(max_dd,(peak-equity)/peak if peak else 0)
        equity_curve.append({'timestamp':ts.isoformat(),'equity':equity})
    # Force close any open position at last close, with slippage and fee.
    if pos:
        row=x.iloc[-1]; exit_price=float(row.close)*(1-slippage if pos['side']==1 else 1+slippage)
        gross=pos['side']*(exit_price-pos['entry'])*pos['qty']; fees=fee_rate*(pos['entry']*pos['qty']+exit_price*pos['qty'])
        net=gross-fees+pos['funding']; equity += gross - fee_rate*(exit_price*pos['qty'])
        trades.append({**{k:pos[k] for k in ['entry_time','side_text','entry','stop','target','qty','risk_cash']},'exit_time':x.index[-1].isoformat(),
            'exit':exit_price,'exit_reason':'end_of_data','gross_pnl':gross,'fees':fees,'funding_pnl':pos['funding'],'net_pnl':net,
            'r_multiple':net/pos['risk_cash'] if pos['risk_cash'] else 0,'equity_after':equity})
    t=pd.DataFrame(trades); ec=pd.DataFrame(equity_curve)
    if not ec.empty:
        vals=ec.equity.astype(float); dd=(vals/vals.cummax()-1)
        max_dd=max(max_dd, float(-dd.min()))
    if t.empty:
        metrics={'initial_equity':initial_equity,'final_equity':equity,'net_return_pct':(equity/initial_equity-1)*100,'trades':0,
                 'win_rate_pct':None,'profit_factor':None,'max_drawdown_pct':max_dd*100,'expectancy_R':None,'note':'No trades generated; inspect data span and signal frequency.'}
    else:
        wins=t[t.net_pnl>0]; losses=t[t.net_pnl<0]
        gross_profit=float(wins.net_pnl.sum()); gross_loss=float(-losses.net_pnl.sum())
        metrics={'initial_equity':initial_equity,'final_equity':equity,'net_return_pct':(equity/initial_equity-1)*100,'trades':int(len(t)),
            'win_rate_pct':float((t.net_pnl>0).mean()*100),'profit_factor':float(gross_profit/gross_loss) if gross_loss else None,
            'max_drawdown_pct':max_dd*100,'expectancy_R':float(t.r_multiple.mean()),'avg_trade_pnl':float(t.net_pnl.mean()),
            'long_trades':int((t.side_text=='LONG').sum()),'short_trades':int((t.side_text=='SHORT').sum()),
            'gross_profit':gross_profit,'gross_loss':gross_loss,'total_fees':float(t.fees.sum()),'funding_pnl':float(t.funding_pnl.sum()),
            'best_trade':float(t.net_pnl.max()),'worst_trade':float(t.net_pnl.min()),'median_trade_R':float(t.r_multiple.median()),
            'note':'Funding is included only if a funding CSV was supplied. Fee/slippage values are assumptions, not your exchange tier.'}
    return metrics,t,ec


def self_check_signals() -> None:
    """Sanity-check entry boolean composition on a tiny synthetic frame."""
    idx = pd.date_range('2024-01-01', periods=40, freq='15min', tz='UTC')
    close = np.linspace(100, 110, len(idx))
    df = pd.DataFrame({
        'open': close, 'high': close + 1, 'low': close - 1, 'close': close, 'volume': 1.0
    }, index=idx)
    # Force a known long-signal row after indicators warm up by patching columns.
    x = indicators(df)
    assert 'long_signal' in x.columns and 'short_signal' in x.columns
    assert 'close_4h' in x.columns
    # Opposite signals must never both fire on the same bar.
    assert not bool((x.long_signal & x.short_signal).any())
    print('self_check_signals: ok')


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--data',default=None,help='15m OHLCV CSV')
    p.add_argument('--funding',default=None,help='Optional funding CSV with timestamp,funding_rate')
    p.add_argument('--out',default='results')
    p.add_argument('--equity',type=float,default=10000)
    p.add_argument('--risk-pct',type=float,default=0.005,help='0.005 = 0.5%% risk per trade')
    p.add_argument('--rr',type=float,choices=[1.2,1.5,2.0],default=1.2)
    p.add_argument('--fee',type=float,default=0.0005,help='Per-side fee rate, default 0.05%%')
    p.add_argument('--slippage',type=float,default=0.0002,help='Per-side slippage rate, default 0.02%%')
    p.add_argument('--self-check',action='store_true',help='Run signal sanity check and exit')
    args=p.parse_args()
    if args.self_check:
        self_check_signals(); return
    if not args.data:
        p.error('--data is required unless --self-check is set')
    out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
    df=load_ohlcv(args.data); x=indicators(df); funding=load_funding(args.funding)
    metrics,trades,curve=run_backtest(x,initial_equity=args.equity,risk_pct=args.risk_pct,rr=args.rr,fee_rate=args.fee,slippage=args.slippage,funding=funding)
    metrics.update({'data_start':x.index.min().isoformat(),'data_end':x.index.max().isoformat(),'candles':len(x),'rr':args.rr,
                    'risk_pct':args.risk_pct,'fee_rate_per_side':args.fee,'slippage_rate_per_side':args.slippage,
                    'funding_data_supplied':funding is not None})
    (out/'summary.json').write_text(json.dumps(metrics,indent=2))
    trades.to_csv(out/'trades.csv',index=False); curve.to_csv(out/'equity_curve.csv',index=False)
    print(json.dumps(metrics,indent=2)); print(f'\nSaved {out}/summary.json, trades.csv, equity_curve.csv')

if __name__=='__main__': main()

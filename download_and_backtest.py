#!/usr/bin/env python3
"""Run the trend-pullback backtest using Supabase historic data (default).

Default symbols: BTCUSDT, ETHUSDT, SOLUSDT.
Data source --source supabase reads ohlcv_15m + funding_rates from the Bitcoin project.
--source csv falls back to local data/*.csv; --source binance downloads from Binance.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from pathlib import Path
import time
import pandas as pd
from binance.client import Client
from backtest_strategy import load_ohlcv, load_funding, indicators, run_backtest
from supabase_data import load_ohlcv_from_supabase, load_funding_from_supabase
import json

KLINE_COLUMNS = [
    'timestamp','open','high','low','close','volume','close_time','quote_volume',
    'trade_count','taker_buy_base','taker_buy_quote','ignore'
]


def as_utc_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def download_klines(client: Client, symbol: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    rows = []
    cursor = start_ms
    while cursor < end_ms:
        batch = client.futures_klines(
            symbol=symbol, interval=Client.KLINE_INTERVAL_15MINUTE,
            startTime=cursor, endTime=end_ms, limit=1500
        )
        if not batch:
            break
        rows.extend(batch)
        last_open = int(batch[-1][0])
        next_cursor = last_open + 15 * 60 * 1000
        if next_cursor <= cursor:
            raise RuntimeError('Kline pagination did not advance; stopping to avoid an infinite loop.')
        cursor = next_cursor
        print(f'Candles downloaded: {len(rows):,} | through {datetime.fromtimestamp(last_open/1000, timezone.utc):%Y-%m-%d %H:%M UTC}', flush=True)
        time.sleep(0.12)
    df = pd.DataFrame(rows, columns=KLINE_COLUMNS)
    if df.empty:
        raise RuntimeError('Binance returned no futures candles. Check connectivity and symbol availability.')
    df = df[['timestamp','open','high','low','close','volume']].copy()
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
    for col in ['open','high','low','close','volume']:
        df[col] = pd.to_numeric(df[col], errors='coerce')
    df = df.dropna().drop_duplicates('timestamp').sort_values('timestamp')
    return df


def download_funding(client: Client, symbol: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    rows = []
    cursor = start_ms
    while cursor < end_ms:
        batch = client.futures_funding_rate(symbol=symbol, startTime=cursor, endTime=end_ms, limit=1000)
        if not batch:
            break
        rows.extend(batch)
        last_time = int(batch[-1]['fundingTime'])
        next_cursor = last_time + 1
        if next_cursor <= cursor:
            raise RuntimeError('Funding-rate pagination did not advance; stopping to avoid an infinite loop.')
        cursor = next_cursor
        print(f'Funding records downloaded: {len(rows):,}', flush=True)
        if len(batch) < 1000:
            break
        time.sleep(0.12)
    df = pd.DataFrame(rows)
    if df.empty:
        raise RuntimeError('Binance returned no funding records. Do not treat a no-funding test as the full futures result.')
    df = df.rename(columns={'fundingTime':'timestamp','fundingRate':'funding_rate'})
    df = df[['timestamp','funding_rate']].copy()
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
    df['funding_rate'] = pd.to_numeric(df['funding_rate'], errors='coerce')
    return df.dropna().drop_duplicates('timestamp').sort_values('timestamp')


def ensure_symbol_data(client: Client, symbol: str, years: int, start: datetime, now: datetime,
                       start_ms: int, end_ms: int, data_dir: Path) -> tuple[Path, Path]:
    candles_path = data_dir / f'{symbol.lower()}_usdm_15m_{years}y.csv'
    funding_path = data_dir / f'{symbol.lower()}_funding_{years}y.csv'
    if candles_path.exists() and funding_path.exists():
        print(f'Using cached files: {candles_path} and {funding_path}')
        return candles_path, funding_path
    print(f'Downloading {symbol} USD-M perpetual 15m candles from {start:%Y-%m-%d %H:%M UTC} to {now:%Y-%m-%d %H:%M UTC}')
    candles = download_klines(client, symbol, start_ms, end_ms)
    funding = download_funding(client, symbol, start_ms, end_ms)
    candles.to_csv(candles_path, index=False)
    funding.to_csv(funding_path, index=False)
    print(f'Saved {len(candles):,} candles to {candles_path}')
    print(f'Saved {len(funding):,} funding records to {funding_path}')
    return candles_path, funding_path


def backtest_symbol(symbol: str, raw: pd.DataFrame, funding, out_dir: Path,
                    equity: float, risk_pct: float, fee: float, slippage: float,
                    data_source: str) -> list[dict]:
    x = indicators(raw)
    symbol_out = out_dir / symbol.lower()
    symbol_out.mkdir(parents=True, exist_ok=True)
    all_summaries = []
    funding_len = int(len(funding)) if funding is not None else 0
    for rr in (1.2, 1.5):
        metrics, trades, curve = run_backtest(
            x, initial_equity=equity, risk_pct=risk_pct, rr=rr,
            fee_rate=fee, slippage=slippage, funding=funding
        )
        metrics.update({
            'symbol': symbol, 'market': 'Binance USD-M perpetual futures',
            'data_source': data_source,
            'data_start': x.index.min().isoformat(), 'data_end': x.index.max().isoformat(),
            'candles': int(len(x)), 'funding_records': funding_len, 'rr': rr,
            'risk_pct': risk_pct, 'fee_rate_per_side': fee,
            'slippage_rate_per_side': slippage, 'funding_data_supplied': funding is not None,
            'caveat': 'Historical simulation only; not a guarantee of future performance.'
        })
        run_dir = symbol_out / f'rr_{str(rr).replace(".", "_")}'
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / 'summary.json').write_text(json.dumps(metrics, indent=2))
        trades.to_csv(run_dir / 'trades.csv', index=False)
        curve.to_csv(run_dir / 'equity_curve.csv', index=False)
        all_summaries.append(metrics)
        print('\n' + '=' * 60 + f'\nRESULTS: {symbol} TAKE PROFIT {rr}R\n' + '=' * 60)
        print(json.dumps(metrics, indent=2))
    (symbol_out / 'comparison.json').write_text(json.dumps(all_summaries, indent=2))
    return all_summaries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--years', type=int, default=5)
    parser.add_argument('--symbol', default=None, help='Single symbol override, e.g. BTCUSDT')
    parser.add_argument('--symbols', default='BTCUSDT,ETHUSDT,SOLUSDT',
                        help='Comma-separated USD-M perpetual symbols')
    parser.add_argument('--source', choices=['supabase', 'csv', 'binance'], default='supabase',
                        help='Where to load historic market data (default: supabase)')
    parser.add_argument('--equity', type=float, default=10000.0)
    parser.add_argument('--risk-pct', type=float, default=0.005, help='0.005 = 0.5%% equity risk per trade')
    parser.add_argument('--fee', type=float, default=0.0005, help='Assumed fee per side, 0.0005 = 0.05%%')
    parser.add_argument('--slippage', type=float, default=0.0002, help='Assumed slippage per side, 0.0002 = 0.02%%')
    parser.add_argument('--data-dir', default='data')
    parser.add_argument('--out-dir', default='results')
    args = parser.parse_args()
    if args.years < 1 or args.years > 10:
        parser.error('--years must be between 1 and 10')

    symbols = [args.symbol.strip().upper()] if args.symbol else [
        s.strip().upper() for s in args.symbols.split(',') if s.strip()
    ]
    if not symbols:
        parser.error('Provide at least one symbol via --symbol or --symbols')

    now = datetime.now(timezone.utc)
    try:
        from dateutil.relativedelta import relativedelta
        start = now - relativedelta(years=args.years)
    except ImportError:
        start = now.replace(year=now.year - args.years)
    start_ms, end_ms = as_utc_ms(start), as_utc_ms(now)
    data_dir, out_dir = Path(args.data_dir), Path(args.out_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    client = None
    if args.source == 'binance':
        client = Client()

    all_summaries = []
    for symbol in symbols:
        if args.source == 'supabase':
            raw = load_ohlcv_from_supabase(symbol)
            funding = load_funding_from_supabase(symbol)
            source_label = 'supabase:ohlcv_15m+funding_rates'
        elif args.source == 'csv':
            candles_path = data_dir / f'{symbol.lower()}_usdm_15m_{args.years}y.csv'
            funding_path = data_dir / f'{symbol.lower()}_funding_{args.years}y.csv'
            if not candles_path.exists() or not funding_path.exists():
                raise FileNotFoundError(f'Missing CSV cache for {symbol}. Use --source supabase or --source binance.')
            print(f'Using cached files: {candles_path} and {funding_path}')
            raw = load_ohlcv(str(candles_path))
            funding = load_funding(str(funding_path))
            source_label = 'local_csv'
        else:
            candles_path, funding_path = ensure_symbol_data(
                client, symbol, args.years, start, now, start_ms, end_ms, data_dir
            )
            raw = load_ohlcv(str(candles_path))
            funding = load_funding(str(funding_path))
            source_label = 'binance_download'
        all_summaries.extend(backtest_symbol(
            symbol, raw, funding, out_dir,
            args.equity, args.risk_pct, args.fee, args.slippage, source_label
        ))
    (out_dir / 'comparison_all.json').write_text(json.dumps(all_summaries, indent=2))
    print(f'\nAll outputs saved under: {out_dir.resolve()}')

if __name__ == '__main__':
    main()

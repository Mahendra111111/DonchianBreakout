#!/usr/bin/env python3
"""Download 5y Binance USD-M perpetual OHLCV (5m/15m/1h) for BTC/ETH/SOL to Excel."""
from __future__ import annotations

import argparse
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from binance.client import Client

try:
    from dateutil.relativedelta import relativedelta
except ImportError:
    relativedelta = None

KLINE_COLUMNS = [
    'timestamp', 'open', 'high', 'low', 'close', 'volume', 'close_time', 'quote_volume',
    'trade_count', 'taker_buy_base', 'taker_buy_quote', 'ignore',
]

INTERVALS = {
    '5m': (Client.KLINE_INTERVAL_5MINUTE, 5 * 60 * 1000),
    '15m': (Client.KLINE_INTERVAL_15MINUTE, 15 * 60 * 1000),
    '1h': (Client.KLINE_INTERVAL_1HOUR, 60 * 60 * 1000),
}

SYMBOLS = ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')


def as_utc_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def download_klines(client: Client, symbol: str, interval: str, step_ms: int,
                    start_ms: int, end_ms: int) -> pd.DataFrame:
    rows = []
    cursor = start_ms
    while cursor < end_ms:
        batch = client.futures_klines(
            symbol=symbol, interval=interval,
            startTime=cursor, endTime=end_ms, limit=1500,
        )
        if not batch:
            break
        rows.extend(batch)
        last_open = int(batch[-1][0])
        next_cursor = last_open + step_ms
        if next_cursor <= cursor:
            raise RuntimeError(f'{symbol} {interval}: kline pagination did not advance.')
        cursor = next_cursor
        if len(rows) % 15000 < 1500:
            print(
                f'  {symbol} {interval}: {len(rows):,} candles '
                f'| through {datetime.fromtimestamp(last_open / 1000, timezone.utc):%Y-%m-%d %H:%M UTC}',
                flush=True,
            )
        time.sleep(0.12)
    if not rows:
        raise RuntimeError(f'No candles returned for {symbol} {interval}.')
    df = pd.DataFrame(rows, columns=KLINE_COLUMNS)
    df = df[['timestamp', 'open', 'high', 'low', 'close', 'volume']].copy()
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
    for col in ['open', 'high', 'low', 'close', 'volume']:
        df[col] = pd.to_numeric(df[col], errors='coerce')
    df = df.dropna().drop_duplicates('timestamp').sort_values('timestamp').reset_index(drop=True)
    # Excel-friendly timezone-naive UTC strings keep openpyxl happy and readable.
    df['timestamp'] = df['timestamp'].dt.tz_convert('UTC').dt.tz_localize(None)
    return df


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--years', type=int, default=5)
    parser.add_argument('--out-dir', default='exports')
    parser.add_argument('--symbols', default=','.join(SYMBOLS))
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    if relativedelta is not None:
        start = now - relativedelta(years=args.years)
    else:
        start = now.replace(year=now.year - args.years)
    start_ms, end_ms = as_utc_ms(start), as_utc_ms(now)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    symbols = [s.strip().upper() for s in args.symbols.split(',') if s.strip()]
    client = Client()

    print(
        f'Downloading Binance USD-M perpetual OHLCV from '
        f'{start:%Y-%m-%d %H:%M UTC} to {now:%Y-%m-%d %H:%M UTC}',
        flush=True,
    )

    for symbol in symbols:
        path = out_dir / f'{symbol.lower()}_ohlcv_{args.years}y.xlsx'
        print(f'\n=== {symbol} → {path} ===', flush=True)
        with pd.ExcelWriter(path, engine='openpyxl') as writer:
            for label, (interval, step_ms) in INTERVALS.items():
                print(f'Downloading {symbol} {label}…', flush=True)
                df = download_klines(client, symbol, interval, step_ms, start_ms, end_ms)
                # Excel sheet names max 31 chars; keep short.
                df.to_excel(writer, sheet_name=label, index=False)
                print(f'  Saved sheet {label}: {len(df):,} rows', flush=True)
        print(f'Done: {path.resolve()}', flush=True)

    print(f'\nAll Excel files saved under: {out_dir.resolve()}')


if __name__ == '__main__':
    main()

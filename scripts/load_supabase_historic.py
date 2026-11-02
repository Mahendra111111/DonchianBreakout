#!/usr/bin/env python3
"""Bulk-load local historic CSVs into Supabase ohlcv_15m and funding_rates tables."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd

DATASETS = [
    ('BTCUSDT', 'btcusdt_usdm_15m_5y.csv', 'btcusdt_funding_5y.csv'),
    ('ETHUSDT', 'ethusdt_usdm_15m_5y.csv', 'ethusdt_funding_5y.csv'),
    ('SOLUSDT', 'solusdt_usdm_15m_5y.csv', 'solusdt_funding_5y.csv'),
]


def post_rows(url: str, key: str, table: str, rows: list[dict]) -> None:
    body = json.dumps(rows).encode('utf-8')
    req = urllib.request.Request(
        f'{url}/rest/v1/{table}?on_conflict=symbol,ts',
        data=body,
        method='POST',
        headers={
            'apikey': key,
            'Authorization': f'Bearer {key}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            if resp.status not in (200, 201):
                raise RuntimeError(f'{table} insert failed: HTTP {resp.status}')
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'{table} insert failed: HTTP {e.code}: {detail[:500]}') from e


def upload_frame(url: str, key: str, table: str, rows: list[dict], batch: int) -> int:
    total = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        for attempt in range(5):
            try:
                post_rows(url, key, table, chunk)
                break
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(1.5 * (attempt + 1))
        total += len(chunk)
        print(f'  {table}: {total:,}/{len(rows):,}', flush=True)
    return total


def load_ohlcv(path: Path, symbol: str) -> list[dict]:
    df = pd.read_csv(path)
    df['symbol'] = symbol
    df['ts'] = pd.to_datetime(df['timestamp'], utc=True).map(lambda x: x.isoformat())
    return df[['symbol', 'ts', 'open', 'high', 'low', 'close', 'volume']].to_dict('records')


def load_funding(path: Path, symbol: str) -> list[dict]:
    df = pd.read_csv(path)
    df['symbol'] = symbol
    df['ts'] = pd.to_datetime(df['timestamp'], utc=True).map(lambda x: x.isoformat())
    return df[['symbol', 'ts', 'funding_rate']].to_dict('records')


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--url', default=os.environ.get('SUPABASE_URL', ''))
    p.add_argument('--key', default=os.environ.get('SUPABASE_ANON_KEY', ''))
    p.add_argument('--data-dir', default='data')
    p.add_argument('--batch', type=int, default=500)
    args = p.parse_args()
    if not args.url or not args.key:
        print('Set SUPABASE_URL and SUPABASE_ANON_KEY (or pass --url/--key).', file=sys.stderr)
        return 2

    data_dir = Path(args.data_dir)
    for symbol, candles, funding in DATASETS:
        cpath = data_dir / candles
        fpath = data_dir / funding
        if not cpath.exists() or not fpath.exists():
            print(f'Skip {symbol}: missing {cpath.name} or {fpath.name}')
            continue
        print(f'Loading {symbol} funding…', flush=True)
        upload_frame(args.url.rstrip('/'), args.key, 'funding_rates', load_funding(fpath, symbol), args.batch)
        print(f'Loading {symbol} 15m OHLCV…', flush=True)
        upload_frame(args.url.rstrip('/'), args.key, 'ohlcv_15m', load_ohlcv(cpath, symbol), args.batch)
    print('Done.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

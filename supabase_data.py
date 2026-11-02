#!/usr/bin/env python3
"""Load historic OHLCV + funding from the Supabase Bitcoin project."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

from backtest_strategy import prepare_funding, prepare_ohlcv


def _load_dotenv() -> None:
    env_path = Path(__file__).resolve().parent / '.env'
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

DEFAULT_URL = os.environ.get('SUPABASE_URL', 'https://mqmentzthtyayzecikhb.supabase.co')
DEFAULT_KEY = os.environ.get('SUPABASE_ANON_KEY', '')
PAGE_SIZE = 1000
MAX_WORKERS = 8
ROOT_DIR = Path(__file__).resolve().parent
CACHE_DIR = ROOT_DIR / 'data' / 'cache'
DATA_DIR = ROOT_DIR / 'data'


def _refresh_requested() -> bool:
    return os.environ.get('SUPABASE_REFRESH', '').strip().lower() in {'1', 'true', 'yes', 'on'}


def _cache_paths(symbol: str) -> tuple[Path, Path]:
    sym = symbol.lower()
    return (
        CACHE_DIR / f'{sym}_ohlcv_15m.csv',
        CACHE_DIR / f'{sym}_funding.csv',
    )


def _ensure_cache_dir() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _headers(key: str, start: int, end: int, with_count: bool = False) -> dict[str, str]:
    headers = {
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Accept': 'application/json',
        'Range-Unit': 'items',
        'Range': f'{start}-{end}',
    }
    if with_count:
        headers['Prefer'] = 'count=exact'
    return headers


def _get_page(base: str, key: str, start: int, page_size: int, with_count: bool = False) -> tuple[list[dict], int | None]:
    end = start + page_size - 1
    last_err: Exception | None = None
    for attempt in range(6):
        req = urllib.request.Request(base, headers=_headers(key, start, end, with_count=with_count), method='GET')
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                chunk = json.loads(resp.read().decode('utf-8'))
                content_range = resp.headers.get('Content-Range', '')
            total = None
            if '/' in content_range:
                try:
                    total = int(content_range.split('/')[-1])
                except ValueError:
                    total = None
            return chunk, total
        except Exception as e:
            last_err = e
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f'Supabase page fetch failed at {start}-{end}: {last_err}') from last_err


def _fetch_table(url: str, key: str, table: str, params: dict[str, str], page_size: int = PAGE_SIZE) -> list[dict]:
    base = f'{url.rstrip("/")}/rest/v1/{table}?{urllib.parse.urlencode(params)}'
    first, total = _get_page(base, key, 0, page_size, with_count=True)
    if not first:
        return []
    rows = list(first)
    print(f'  {table}: fetched {len(rows):,}' + (f'/{total:,}' if total else ''), flush=True)
    if total is None:
        # Sequential fallback when total is unknown.
        start = len(rows)
        while True:
            chunk, _ = _get_page(base, key, start, page_size, with_count=False)
            if not chunk:
                break
            rows.extend(chunk)
            start += len(chunk)
            print(f'  {table}: fetched {len(rows):,}', flush=True)
            if len(chunk) < page_size:
                break
        return rows

    starts = list(range(page_size, total, page_size))
    if not starts:
        return rows

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_get_page, base, key, s, page_size, False): s for s in starts}
        done = 0
        pages: dict[int, list[dict]] = {}
        for fut in as_completed(futures):
            start = futures[fut]
            chunk, _ = fut.result()
            pages[start] = chunk
            done += 1
            if done % 10 == 0 or done == len(starts):
                loaded = page_size + sum(len(v) for v in pages.values())
                print(f'  {table}: fetched {min(loaded, total):,}/{total:,}', flush=True)

    for s in starts:
        rows.extend(pages.get(s, []))
    return rows


def load_ohlcv_from_supabase(symbol: str, url: str | None = None, key: str | None = None) -> pd.DataFrame:
    url = url or DEFAULT_URL
    key = key or DEFAULT_KEY
    if not key:
        raise RuntimeError('SUPABASE_ANON_KEY is required to load candles from Supabase.')
    print(f'Loading {symbol} 15m OHLCV from Supabase…', flush=True)
    rows = _fetch_table(
        url, key, 'ohlcv_15m',
        {
            'select': 'ts,open,high,low,close,volume',
            'symbol': f'eq.{symbol.upper()}',
            'order': 'ts.asc',
        },
    )
    if not rows:
        raise RuntimeError(f'No ohlcv_15m rows in Supabase for {symbol}.')
    df = pd.DataFrame(rows).rename(columns={'ts': 'timestamp'})
    return prepare_ohlcv(df)


def load_funding_from_supabase(symbol: str, url: str | None = None, key: str | None = None) -> pd.Series:
    url = url or DEFAULT_URL
    key = key or DEFAULT_KEY
    if not key:
        raise RuntimeError('SUPABASE_ANON_KEY is required to load funding from Supabase.')
    print(f'Loading {symbol} funding from Supabase…', flush=True)
    rows = _fetch_table(
        url, key, 'funding_rates',
        {
            'select': 'ts,funding_rate',
            'symbol': f'eq.{symbol.upper()}',
            'order': 'ts.asc',
        },
    )
    if not rows:
        raise RuntimeError(f'No funding_rates rows in Supabase for {symbol}.')
    df = pd.DataFrame(rows).rename(columns={'ts': 'timestamp'})
    return prepare_funding(df)


def _write_ohlcv_cache(path: Path, df: pd.DataFrame) -> None:
    out = df.reset_index()
    # prepare_ohlcv indexes on timestamp; restore a plain CSV for fast reloads.
    if out.columns[0] != 'timestamp':
        out = out.rename(columns={out.columns[0]: 'timestamp'})
    out.to_csv(path, index=False)


def _write_funding_cache(path: Path, series: pd.Series) -> None:
    out = series.rename('funding_rate').reset_index()
    if out.columns[0] != 'timestamp':
        out = out.rename(columns={out.columns[0]: 'timestamp'})
    out.to_csv(path, index=False)


def load_ohlcv(symbol: str, url: str | None = None, key: str | None = None) -> tuple[pd.DataFrame, str]:
    """Prefer local CSV cache; fetch Supabase only on miss or SUPABASE_REFRESH=1."""
    ohlcv_path, _ = _cache_paths(symbol)
    refresh = _refresh_requested()
    if ohlcv_path.exists() and not refresh:
        print(f'Loading {symbol} 15m OHLCV from cache ({ohlcv_path.name})…', flush=True)
        return prepare_ohlcv(pd.read_csv(ohlcv_path)), 'cache'

    legacy = DATA_DIR / f'{symbol.lower()}_usdm_15m_5y.csv'
    if legacy.exists() and not refresh:
        print(f'Loading {symbol} 15m OHLCV from local CSV ({legacy.name})…', flush=True)
        df = prepare_ohlcv(pd.read_csv(legacy))
        _ensure_cache_dir()
        _write_ohlcv_cache(ohlcv_path, df)
        return df, 'cache'

    df = load_ohlcv_from_supabase(symbol, url=url, key=key)
    _ensure_cache_dir()
    _write_ohlcv_cache(ohlcv_path, df)
    print(f'Saved {symbol} OHLCV cache → {ohlcv_path}', flush=True)
    return df, 'supabase'


def load_funding(symbol: str, url: str | None = None, key: str | None = None) -> tuple[pd.Series, str]:
    """Prefer local CSV cache; fetch Supabase only on miss or SUPABASE_REFRESH=1."""
    _, funding_path = _cache_paths(symbol)
    refresh = _refresh_requested()
    if funding_path.exists() and not refresh:
        print(f'Loading {symbol} funding from cache ({funding_path.name})…', flush=True)
        return prepare_funding(pd.read_csv(funding_path)), 'cache'

    legacy = DATA_DIR / f'{symbol.lower()}_funding_5y.csv'
    if legacy.exists() and not refresh:
        print(f'Loading {symbol} funding from local CSV ({legacy.name})…', flush=True)
        series = prepare_funding(pd.read_csv(legacy))
        _ensure_cache_dir()
        _write_funding_cache(funding_path, series)
        return series, 'cache'

    series = load_funding_from_supabase(symbol, url=url, key=key)
    _ensure_cache_dir()
    _write_funding_cache(funding_path, series)
    print(f'Saved {symbol} funding cache → {funding_path}', flush=True)
    return series, 'supabase'

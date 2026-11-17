#!/usr/bin/env python3
"""Local API for EMA + Donchian research results and live signal scan."""
from __future__ import annotations

import json
import os
import subprocess
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = '127.0.0.1'
PORT = 8765
ROOT = Path(__file__).resolve().parent
SUMMARY = ROOT / 'ui' / 'public' / 'strategy_summary.json'
TRADES_DIR = ROOT / 'ui' / 'public' / 'trades'
STRATEGIES = (
    'Donchian Breakout',
    'Hammer SMA VWAP',
)
SYMBOLS = (
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT', 'ADAUSDT',
)

_state_lock = threading.Lock()
_state: dict = {'last_scan': None}


def _load_summary() -> dict:
    if not SUMMARY.exists():
        raise FileNotFoundError(
            f'Missing {SUMMARY}. Run: python strategy_research_report.py'
        )
    return json.loads(SUMMARY.read_text(encoding='utf-8'))


def _load_trades(file_name: str | None) -> list:
    if not file_name:
        return []
    path = TRADES_DIR / Path(file_name).name
    if not path.exists():
        alt = ROOT / 'api' / 'trades' / Path(file_name).name
        path = alt if alt.exists() else path
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding='utf-8'))


def _run_node_scan(notify: bool, symbols: str | None = None) -> dict:
    args = ['node', str(ROOT / 'scripts' / 'run_scan.mjs')]
    if not notify:
        args.append('--no-notify')
        args.append('notify=0')
    if symbols:
        args.append(f'symbols={symbols}')
    env = os.environ.copy()
    proc = subprocess.run(
        args, cwd=str(ROOT), capture_output=True, text=True, env=env, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or 'scan failed')
    return json.loads(proc.stdout)


def _parse_time_ms(raw: str | None) -> int | None:
    if raw is None or raw == '':
        return None
    try:
        return int(float(raw))
    except ValueError:
        pass
    try:
        return int(datetime.fromisoformat(raw.replace('Z', '+00:00')).timestamp() * 1000)
    except ValueError:
        return None


def _run_node_ohlcv(symbol: str, timeframe: str, from_ms: int, to_ms: int) -> dict:
    args = [
        'node', str(ROOT / 'scripts' / 'run_ohlcv.mjs'),
        f'symbol={symbol}',
        f'timeframe={timeframe}',
        f'from={from_ms}',
        f'to={to_ms}',
    ]
    env = os.environ.copy()
    proc = subprocess.run(
        args, cwd=str(ROOT), capture_output=True, text=True, env=env, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or 'ohlcv failed')
    return json.loads(proc.stdout)


def _run_node_ticker(symbol: str | None = None, symbols: str | None = None) -> dict:
    args = ['node', str(ROOT / 'scripts' / 'run_ticker.mjs')]
    if symbols:
        args.append(f'symbols={symbols}')
    else:
        args.append(f'symbol={(symbol or "SOLUSDT").upper()}')
    env = os.environ.copy()
    proc = subprocess.run(
        args, cwd=str(ROOT), capture_output=True, text=True, env=env, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or 'ticker failed')
    return json.loads(proc.stdout)


def _run_node_live(symbol: str, timeframe: str, strategy: str, notify: bool = False) -> dict:
    args = [
        'node', str(ROOT / 'scripts' / 'run_live.mjs'),
        f'symbol={symbol}',
        f'timeframe={timeframe}',
        f'strategy={strategy}',
        f'notify={"1" if notify else "0"}',
    ]
    env = os.environ.copy()
    proc = subprocess.run(
        args, cwd=str(ROOT), capture_output=True, text=True, env=env, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or 'live failed')
    return json.loads(proc.stdout)


def _run_node_results(symbol: str, strategy: str, timeframe: str, period: str,
                      ondemand: bool = False) -> dict:
    args = [
        'node', str(ROOT / 'scripts' / 'run_results.mjs'),
        f'symbol={symbol}',
        f'strategy={strategy}',
        f'timeframe={timeframe}',
        f'period={period}',
    ]
    if ondemand:
        args.append('ondemand=1')
    env = os.environ.copy()
    proc = subprocess.run(
        args, cwd=str(ROOT), capture_output=True, text=True, env=env, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or 'results failed')
    return json.loads(proc.stdout)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f'[api] {self.address_string()} - {fmt % args}', flush=True)

    def _cors(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self._cors()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == '/api/watchlist':
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(length) if length else b'{}'
            try:
                body = json.loads(raw.decode('utf-8') or '{}')
            except Exception:
                body = {}
            symbols = ','.join(body.get('symbols') or [])
            try:
                proc = subprocess.run(
                    ['node', str(ROOT / 'scripts' / 'run_watchlist.mjs'), f'set={symbols}'],
                    cwd=str(ROOT), capture_output=True, text=True, env=os.environ.copy(), check=False,
                )
                if proc.returncode != 0:
                    raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or 'watchlist failed')
                self._json(200, json.loads(proc.stdout))
            except Exception as e:
                self._json(400, {'error': str(e)})
            return
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ('/api/health', '/api/status'):
            self._json(200, {
                'ok': True,
                'ready': SUMMARY.exists(),
                'strategies': list(STRATEGIES),
                'symbols': list(SYMBOLS),
                'service': 'crypto-ema-donchian-local',
            })
            return

        if path == '/api/symbols':
            q = (qs.get('q') or [''])[0]
            try:
                proc = subprocess.run(
                    ['node', str(ROOT / 'scripts' / 'run_symbols.mjs'), f'q={q}'],
                    cwd=str(ROOT), capture_output=True, text=True, env=os.environ.copy(), check=False,
                )
                if proc.returncode != 0:
                    raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or 'symbols failed')
                self._json(200, json.loads(proc.stdout))
            except Exception as e:
                self._json(500, {'error': str(e)})
            return

        if path == '/api/watchlist':
            try:
                proc = subprocess.run(
                    ['node', str(ROOT / 'scripts' / 'run_watchlist.mjs')],
                    cwd=str(ROOT), capture_output=True, text=True, env=os.environ.copy(), check=False,
                )
                if proc.returncode != 0:
                    raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or 'watchlist failed')
                self._json(200, json.loads(proc.stdout))
            except Exception as e:
                self._json(500, {'error': str(e)})
            return

        if path == '/api/signals':
            try:
                symbols = (qs.get('symbols') or [None])[0]
                result = _run_node_scan(notify=False, symbols=symbols)
                with _state_lock:
                    _state['last_scan'] = result
                self._json(200, result)
            except Exception as e:
                self._json(500, {'error': str(e)})
            return

        if path == '/api/scan':
            try:
                notify = (qs.get('notify') or ['1'])[0] != '0'
                symbols = (qs.get('symbols') or [None])[0]
                result = _run_node_scan(notify=notify, symbols=symbols)
                with _state_lock:
                    _state['last_scan'] = result
                self._json(200, result)
            except Exception as e:
                self._json(500, {'error': str(e)})
            return

        if path == '/api/ticker':
            symbol = (qs.get('symbol') or ['SOLUSDT'])[0].upper()
            symbols = (qs.get('symbols') or [None])[0]
            try:
                self._json(200, _run_node_ticker(symbol=symbol, symbols=symbols))
            except Exception as e:
                self._json(500, {'error': str(e)})
            return

        if path == '/api/live':
            symbol = (qs.get('symbol') or ['SOLUSDT'])[0].upper()
            timeframe = (qs.get('timeframe') or ['1h'])[0]
            strategy = (qs.get('strategy') or ['Donchian Breakout'])[0]
            notify = (qs.get('notify') or ['0'])[0] == '1'
            try:
                self._json(200, _run_node_live(symbol, timeframe, strategy, notify=notify))
            except Exception as e:
                self._json(500, {'error': str(e)})
            return

        if path == '/api/ohlcv':
            symbol = (qs.get('symbol') or ['SOLUSDT'])[0].upper()
            timeframe = (qs.get('timeframe') or ['1h'])[0]
            from_ms = _parse_time_ms((qs.get('from') or [None])[0])
            to_ms = _parse_time_ms((qs.get('to') or [None])[0])
            if from_ms is None or to_ms is None:
                self._json(400, {'error': 'from and to are required (ms or ISO)'})
                return
            try:
                self._json(200, _run_node_ohlcv(symbol, timeframe, from_ms, to_ms))
            except Exception as e:
                self._json(500, {'error': str(e)})
            return

        if path in ('/api/results', '/api/backtest'):
            symbol = (qs.get('symbol') or ['SOLUSDT'])[0].upper()
            strategy = (qs.get('strategy') or ['Donchian Breakout'])[0]
            timeframe = (qs.get('timeframe') or ['1h'])[0]
            period = (qs.get('period') or ['5y'])[0]
            ondemand = path == '/api/backtest' or (qs.get('ondemand') or ['0'])[0] == '1'
            try:
                self._json(200, _run_node_results(symbol, strategy, timeframe, period, ondemand))
            except Exception as e:
                self._json(400, {'error': str(e), 'ready': False})
            return

        self._json(404, {'error': 'not found'})


def main() -> None:
    if not SUMMARY.exists():
        print(f'WARNING: {SUMMARY} missing — run python strategy_research_report.py', flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f'EMA+Donchian API on http://{HOST}:{PORT}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()

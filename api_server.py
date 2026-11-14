#!/usr/bin/env python3
"""Local API for EMA + Donchian research results and live signal scan."""
from __future__ import annotations

import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = '127.0.0.1'
PORT = 8765
ROOT = Path(__file__).resolve().parent
SUMMARY = ROOT / 'ui' / 'public' / 'strategy_summary.json'
TRADES_DIR = ROOT / 'ui' / 'public' / 'trades'
STRATEGIES = ('EMA Trend Following', 'Donchian Breakout', 'Hammer SMA VWAP')
SYMBOLS = ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')

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


def _run_node_scan(notify: bool) -> dict:
    args = ['node', str(ROOT / 'scripts' / 'run_scan.mjs')]
    if not notify:
        args.append('--no-notify')
    env = os.environ.copy()
    proc = subprocess.run(
        args, cwd=str(ROOT), capture_output=True, text=True, env=env, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or 'scan failed')
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

        if path == '/api/signals':
            try:
                result = _run_node_scan(notify=False)
                with _state_lock:
                    _state['last_scan'] = result
                self._json(200, result)
            except Exception as e:
                self._json(500, {'error': str(e)})
            return

        if path == '/api/scan':
            try:
                notify = (qs.get('notify') or ['1'])[0] != '0'
                result = _run_node_scan(notify=notify)
                with _state_lock:
                    _state['last_scan'] = result
                self._json(200, result)
            except Exception as e:
                self._json(500, {'error': str(e)})
            return

        if path == '/api/results':
            symbol = (qs.get('symbol') or ['SOLUSDT'])[0].upper()
            strategy = (qs.get('strategy') or ['Donchian Breakout'])[0]
            timeframe = (qs.get('timeframe') or ['1h'])[0]
            period = (qs.get('period') or ['5y'])[0]
            try:
                data = _load_summary()
            except Exception as e:
                self._json(500, {'error': str(e), 'ready': False})
                return
            rows = [
                r for r in data.get('results', [])
                if r.get('symbol') == symbol and r.get('strategy') == strategy and r.get('timeframe') == timeframe
            ]
            if not rows:
                self._json(404, {
                    'error': 'no research row for this selection',
                    'strategies': data.get('strategies'),
                })
                return
            row = rows[0]
            periods = row.get('periods') or {}
            period_row = periods.get(period) or periods.get('5y') or {}
            trade_list = period_row.get('trade_list') or _load_trades(period_row.get('trades_file'))
            successful = sum(1 for t in trade_list if t.get('outcome') == 'successful')
            trades = int(period_row.get('trades') or len(trade_list) or 0)
            wr = period_row.get('win_rate_pct')
            period_cards = {}
            for key, p in periods.items():
                period_cards[key] = {
                    'period': key,
                    'trades': p.get('trades'),
                    'net_return_pct': p.get('net_return_pct'),
                    'win_rate_pct': p.get('win_rate_pct'),
                    'profit_factor': p.get('profit_factor'),
                    'max_dd_pct': p.get('max_dd_pct'),
                    'trades_file': p.get('trades_file'),
                }
            self._json(200, {
                'ready': True,
                'summary': {
                    'symbol': symbol,
                    'strategy': strategy,
                    'timeframe': timeframe,
                    'period': period,
                    'from': period_row.get('from'),
                    'to': period_row.get('to'),
                    'trades': trades,
                    'successful': successful,
                    'failed': max(0, trades - successful),
                    'success_rate_pct': round(wr, 2) if wr is not None else None,
                    'net_return_pct': period_row.get('net_return_pct'),
                    'profit_factor': period_row.get('profit_factor'),
                    'max_dd_pct': period_row.get('max_dd_pct'),
                    'expectancy': period_row.get('expectancy'),
                    'final_equity': period_row.get('final_equity'),
                    'stop_exit_pct': period_row.get('stop_exit_pct'),
                    'trades_file': period_row.get('trades_file'),
                    'data_source': 'research:strategy_summary.json',
                },
                'trade_list': trade_list,
                'period_cards': period_cards,
                'periods': data.get('periods') or list(periods.keys()),
                'ranking': data.get('ranking'),
                'updated': data.get('updated'),
            })
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

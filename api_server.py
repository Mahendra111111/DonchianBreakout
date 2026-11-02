#!/usr/bin/env python3
"""Live backtest API: market data from cache/Supabase, results kept in memory only (not saved)."""
from __future__ import annotations

import json
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from backtest_strategy import indicators, run_backtest
from supabase_data import load_funding, load_ohlcv

HOST = '127.0.0.1'
PORT = 8765
SYMBOLS = ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')
# Closer target (1.2R) favors win rate; 1.5R kept for comparison.
RR_VALUES = (1.2, 1.5)

_state_lock = threading.Lock()
_state = {
    'ready': False,
    'running': False,
    'error': None,
    'progress': 'starting',
    'results': {},  # key: f'{symbol}|{rr}' -> {summary, trades}
}


def _public_trade(row: dict) -> dict:
    pnl = float(row.get('net_pnl') or 0)
    return {
        'entry_time': row.get('entry_time'),
        'exit_time': row.get('exit_time'),
        'side_text': row.get('side_text'),
        'entry': row.get('entry'),
        'exit': row.get('exit'),
        'exit_reason': row.get('exit_reason'),
        'outcome': 'successful' if pnl > 0 else 'failed',
    }


def _public_summary(symbol: str, rr: float, metrics: dict, trades: list[dict], data_source: str) -> dict:
    successful = sum(1 for t in trades if t['outcome'] == 'successful')
    failed = len(trades) - successful
    return {
        'symbol': symbol,
        'rr': rr,
        'data_source': data_source,
        'candles': metrics.get('candles'),
        'funding_records': metrics.get('funding_records'),
        'data_start': metrics.get('data_start'),
        'data_end': metrics.get('data_end'),
        'total': len(trades),
        'successful': successful,
        'failed': failed,
        'success_rate_pct': round((successful / len(trades)) * 100, 2) if trades else None,
    }


def _set_progress(msg: str) -> None:
    with _state_lock:
        _state['progress'] = msg
    print(msg, flush=True)


def run_all_backtests() -> None:
    with _state_lock:
        _state['running'] = True
        _state['ready'] = False
        _state['error'] = None
        _state['results'] = {}
    try:
        # BTCUSDT first so the UI can show results while ETH/SOL still load.
        for symbol in SYMBOLS:
            _set_progress(f'Loading {symbol} market data (cache or Supabase)…')
            raw, ohlcv_src = load_ohlcv(symbol)
            funding, funding_src = load_funding(symbol)
            source_label = (
                f'cache:ohlcv_15m+funding_rates'
                if ohlcv_src == 'cache' and funding_src == 'cache'
                else f'{ohlcv_src}+{funding_src}:ohlcv_15m+funding_rates'
            )
            _set_progress(f'Computing indicators for {symbol} ({source_label})…')
            x = indicators(raw)
            for rr in RR_VALUES:
                _set_progress(f'Backtesting {symbol} @ {rr}R…')
                metrics, trades_df, _curve = run_backtest(
                    x, initial_equity=10000.0, risk_pct=0.005, rr=rr,
                    fee_rate=0.0005, slippage=0.0002, funding=funding,
                )
                metrics.update({
                    'symbol': symbol,
                    'rr': rr,
                    'candles': int(len(x)),
                    'funding_records': int(len(funding)),
                    'data_start': x.index.min().isoformat(),
                    'data_end': x.index.max().isoformat(),
                })
                trade_rows = trades_df.to_dict(orient='records') if not trades_df.empty else []
                public_trades = [_public_trade(t) for t in trade_rows]
                payload = {
                    'summary': _public_summary(symbol, rr, metrics, public_trades, source_label),
                    'trades': public_trades,
                }
                with _state_lock:
                    _state['results'][f'{symbol}|{rr}'] = payload
        with _state_lock:
            _state['ready'] = True
            _state['progress'] = 'ready'
        _set_progress('All live backtests ready (in memory, not saved to disk).')
    except Exception as e:
        with _state_lock:
            _state['error'] = str(e)
            _state['progress'] = 'error'
        traceback.print_exc()
    finally:
        with _state_lock:
            _state['running'] = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f'[api] {self.address_string()} - {fmt % args}', flush=True)

    def _cors(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

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

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ('/api/health', '/api/status'):
            with _state_lock:
                self._json(200, {
                    'ready': _state['ready'],
                    'running': _state['running'],
                    'progress': _state['progress'],
                    'error': _state['error'],
                    'symbols': list(SYMBOLS),
                    'rr': list(RR_VALUES),
                })
            return

        if path == '/api/results':
            symbol = (qs.get('symbol') or ['BTCUSDT'])[0].upper()
            try:
                rr = float((qs.get('rr') or ['1.5'])[0])
            except ValueError:
                self._json(400, {'error': 'rr must be a number'})
                return
            key = f'{symbol}|{rr}'
            with _state_lock:
                if _state['error'] and not _state['ready']:
                    self._json(500, {'error': _state['error'], 'progress': _state['progress']})
                    return
                if key not in _state['results']:
                    self._json(202, {
                        'ready': False,
                        'running': _state['running'],
                        'progress': _state['progress'],
                        'error': _state['error'],
                    })
                    return
                self._json(200, _state['results'][key])
            return

        self._json(404, {'error': 'not found'})


def main() -> None:
    threading.Thread(target=run_all_backtests, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f'Live backtest API on http://{HOST}:{PORT} (cache/Supabase market data, results memory-only)', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()

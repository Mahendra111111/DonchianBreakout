# BTCUSDT Perpetual Futures Backtester (5-year download)

This research package implements the previously discussed BTCUSDT trend-pullback rules. It does not place trades.

## 1. Install dependencies

Python 3.10+ is recommended.

```bash
python -m pip install --upgrade pip
python -m pip install pandas numpy python-binance python-dateutil
```

## 2. Download 5 years of real futures data and run both take-profit tests

```bash
python download_and_backtest.py --years 5 --symbol BTCUSDT --risk-pct 0.005
```

The downloader uses Binance USD-M perpetual futures public market-data endpoints. It fetches 15-minute OHLCV candles and historical funding rates, then runs the 1.5R and 2R variants. No API key is required for public market data. You need an internet connection. If downloads fail due to rate limits or network restrictions, wait and rerun; do not interpret an incomplete dataset as a valid result.

Output files are saved in `data/` and `results/`. Each take-profit variant gets `summary.json`, `trades.csv`, and `equity_curve.csv`; `results/comparison.json` compares the two runs. Delete the two cached CSVs in `data/` before rerunning if you want to redownload the entire range.

## Strategy rules operationalized

- Long bias: 4-hour close above EMA200 and EMA50 above EMA200. Short bias is the inverse.
- Entry: 15-minute pullback near EMA20 (within 0.5 ATR), RSI(14) crosses 50 in the direction of the trade, and the candle closes beyond the previous candle's high/low.
- Entry on the next candle open, with slippage.
- Stop beyond the prior 10-candle swing and at least 1 ATR from entry; skip if stop distance exceeds 3 ATR.
- Compare 1.5R and 2R take-profit targets; default risk 0.5% of equity per trade; one position at a time; notional capped at 1x equity.
- Conservative stop-first resolution when stop and target are both touched within the same candle.
- Default assumed fee 0.05% per side and slippage 0.02% per side. These are assumptions; set them to your actual venue/tier.
- Three consecutive losses per UTC day, 1% daily loss limit, 5% monthly pause.
- Funding rates included using the recorded funding event rates while positions are open.

## Limitations

This is a transparent first-pass implementation of the verbal rules, not a guarantee of profitability. The entry rules approximate “near support/resistance” as the 20 EMA. Funding is applied at the nearest candle-open price in the backtest, so the funding P&L is an approximation. Candle OHLC cannot resolve intrabar event ordering; if both stop and target are hit in one candle, stop is assumed first. Validate data completeness, exchange-specific fees, and the implementation before relying on results. Historical performance does not guarantee future results.

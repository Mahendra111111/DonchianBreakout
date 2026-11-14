/** On-demand strategy backtest: fetch OHLCV → signals → paper sim. */

import { fetchKlinesRange } from './binance.mjs'
import { cacheGet, cacheKey, cacheSet } from './backtestCache.mjs'
import { runPaperTrades } from './paper.mjs'
import { STRATEGIES } from './strategies.mjs'
import { isSupportedTimeframe, periodToRangeMs, PERIOD_DAYS } from './timeframes.mjs'

const PERIODS = Object.keys(PERIOD_DAYS)

function summarizeTrades(trades, equity, initial = 10000) {
  if (!trades.length) {
    return {
      trades: 0,
      successful: 0,
      failed: 0,
      win_rate_pct: null,
      net_return_pct: ((equity / initial) - 1) * 100,
      profit_factor: null,
      max_dd_pct: 0,
      expectancy: null,
      final_equity: equity,
      stop_exit_pct: null,
    }
  }
  const wins = trades.filter((t) => (t.net ?? 0) > 0)
  const losses = trades.filter((t) => (t.net ?? 0) <= 0)
  const gp = wins.reduce((s, t) => s + t.net, 0)
  const gl = -losses.reduce((s, t) => s + t.net, 0)
  let eq = initial
  let peak = eq
  let maxDd = 0
  for (const t of trades) {
    eq += t.net
    peak = Math.max(peak, eq)
    maxDd = Math.max(maxDd, peak ? (peak - eq) / peak : 0)
  }
  const stops = trades.filter((t) => t.reason === 'stop' || t.exit_reason === 'STOP_LOSS')
  return {
    trades: trades.length,
    successful: wins.length,
    failed: losses.length,
    win_rate_pct: (wins.length / trades.length) * 100,
    net_return_pct: ((equity / initial) - 1) * 100,
    profit_factor: gl > 0 ? gp / gl : null,
    max_dd_pct: maxDd * 100,
    expectancy: trades.reduce((s, t) => s + t.net, 0) / trades.length,
    final_equity: equity,
    stop_exit_pct: (stops.length / trades.length) * 100,
  }
}

function filterTradesByEntryWindow(trades, fromMs, toMs) {
  return trades.filter((t) => {
    const et = Date.parse(t.entry_time)
    return Number.isFinite(et) && et >= fromMs && et <= toMs
  })
}

/**
 * Run one on-demand backtest for a symbol/strategy/timeframe/period.
 */
export async function runOnDemandBacktest({
  symbol,
  strategy,
  timeframe,
  period = '5y',
  useCache = true,
}) {
  const sym = String(symbol || '').toUpperCase().trim()
  if (!sym) throw new Error('symbol is required')
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown strategy: ${strategy}. Supported: ${STRATEGIES.join(', ')}`)
  }
  if (!isSupportedTimeframe(timeframe)) {
    throw new Error(`Unsupported timeframe: ${timeframe}`)
  }
  if (!PERIOD_DAYS[period]) {
    throw new Error(`Unsupported period: ${period}`)
  }

  const key = cacheKey({ strategy, symbol: sym, timeframe, period })
  if (useCache) {
    const cached = await cacheGet(key)
    if (cached) return { ...cached, cache: 'hit' }
  }

  const { from, to } = periodToRangeMs(period)
  const data = await fetchKlinesRange(sym, timeframe, from, to, { padWarmup: true })
  const bars = data.bars
  if (!bars?.time?.length) {
    throw new Error(`No OHLCV returned for ${sym} ${timeframe}`)
  }

  const paper = runPaperTrades(bars, strategy, { entryFromMs: from })
  const windowTrades = filterTradesByEntryWindow(paper.trades, from, to)
  const metrics = summarizeTrades(windowTrades, paper.equity)

  const periodRow = {
    period,
    days: PERIOD_DAYS[period],
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    ...metrics,
  }

  // Light period cards: current period only (full matrix would be too slow on every request)
  const periodCards = {
    [period]: {
      period,
      trades: metrics.trades,
      net_return_pct: metrics.net_return_pct,
      win_rate_pct: metrics.win_rate_pct,
      profit_factor: metrics.profit_factor,
      max_dd_pct: metrics.max_dd_pct,
      trades_file: null,
    },
  }

  const summary = {
    symbol: sym,
    strategy,
    timeframe,
    period,
    from: periodRow.from,
    to: periodRow.to,
    trades: metrics.trades,
    successful: metrics.successful,
    failed: metrics.failed,
    success_rate_pct: metrics.win_rate_pct != null ? Number(metrics.win_rate_pct.toFixed(2)) : null,
    win_rate_pct: metrics.win_rate_pct,
    net_return_pct: metrics.net_return_pct,
    profit_factor: metrics.profit_factor,
    max_dd_pct: metrics.max_dd_pct,
    expectancy: metrics.expectancy,
    final_equity: metrics.final_equity,
    stop_exit_pct: metrics.stop_exit_pct,
    data_source: 'on_demand',
    trades_file: null,
  }

  const payload = {
    ready: true,
    source: 'on_demand',
    data_source: data.source || 'binance',
    truncated: Boolean(data.truncated),
    note: data.truncated
      ? 'Candle window truncated to platform max for this timeframe; results use most recent bars.'
      : 'On-demand backtest from live exchange OHLCV — research simulation only.',
    summary,
    trade_list: windowTrades,
    period_cards: periodCards,
    periods: PERIODS,
    open: paper.open,
    scannedAt: new Date().toISOString(),
  }

  if (useCache) await cacheSet(key, payload)
  return { ...payload, cache: 'miss' }
}

export { PERIODS, STRATEGIES }

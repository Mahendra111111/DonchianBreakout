import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOnDemandBacktest } from '../lib/backtest.mjs'
import { STRATEGIES } from '../lib/strategies.mjs'
import { PERIOD_DAYS, SUPPORTED_TIMEFRAMES } from '../lib/timeframes.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PERIODS = Object.keys(PERIOD_DAYS)

async function loadSummary() {
  const candidates = [
    path.join(root, 'api', 'strategy_summary.json'),
    path.join(root, 'ui', 'public', 'strategy_summary.json'),
  ]
  for (const p of candidates) {
    try {
      return JSON.parse(await readFile(p, 'utf8'))
    } catch {
      /* try next */
    }
  }
  return null
}

async function loadTrades(fileName) {
  if (!fileName) return []
  const candidates = [
    path.join(root, 'api', 'trades', fileName),
    path.join(root, 'ui', 'public', 'trades', fileName),
  ]
  for (const p of candidates) {
    try {
      return JSON.parse(await readFile(p, 'utf8'))
    } catch {
      /* try next */
    }
  }
  return []
}

function metricsFromPeriod(periodRow, tradeList, symbol, strategy, timeframe, period) {
  const successful = tradeList.filter((t) => t.outcome === 'successful').length
  const trades = periodRow.trades ?? tradeList.length
  return {
    symbol,
    strategy,
    timeframe,
    period,
    from: periodRow.from,
    to: periodRow.to,
    trades,
    successful,
    failed: Math.max(0, trades - successful),
    success_rate_pct: periodRow.win_rate_pct != null ? Number(Number(periodRow.win_rate_pct).toFixed(2)) : null,
    net_return_pct: periodRow.net_return_pct,
    profit_factor: periodRow.profit_factor,
    max_dd_pct: periodRow.max_dd_pct,
    expectancy: periodRow.expectancy,
    final_equity: periodRow.final_equity,
    stop_exit_pct: periodRow.stop_exit_pct,
    data_source: 'research:strategy_summary.json',
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }

  const symbol = String(req.query?.symbol || 'SOLUSDT').toUpperCase()
  const strategy = String(req.query?.strategy || 'Donchian Breakout')
  const timeframe = String(req.query?.timeframe || '1h')
  const period = String(req.query?.period || '5y')
  const forceOnDemand = String(req.query?.ondemand || '') === '1'

  try {
    const data = forceOnDemand ? null : await loadSummary()
    const rows = (data?.results || []).filter(
      (r) => r.symbol === symbol && r.strategy === strategy && r.timeframe === timeframe,
    )

    if (rows.length) {
      const row = rows[0]
      const periods = row.periods || {}
      const periodRow = periods[period] || periods['5y']
      if (periodRow) {
        const tradeList = await loadTrades(periodRow.trades_file)
        const periodCards = {}
        for (const key of data.periods || PERIODS) {
          const p = periods[key]
          if (!p) continue
          periodCards[key] = {
            period: key,
            trades: p.trades,
            net_return_pct: p.net_return_pct,
            win_rate_pct: p.win_rate_pct,
            profit_factor: p.profit_factor,
            max_dd_pct: p.max_dd_pct,
            trades_file: p.trades_file || null,
          }
        }
        const summary = metricsFromPeriod(periodRow, tradeList, symbol, strategy, timeframe, period)
        summary.trades_file = periodRow.trades_file || null
        res.status(200).json({
          ready: true,
          source: 'research',
          summary,
          trade_list: tradeList,
          period_cards: periodCards,
          periods: data.periods || PERIODS,
          ranking: data.ranking,
          updated: data.updated,
          strategies: data.strategies || STRATEGIES,
          timeframes: SUPPORTED_TIMEFRAMES,
        })
        return
      }
    }

    // Permanent path: on-demand backtest when no static research row
    const live = await runOnDemandBacktest({ symbol, strategy, timeframe, period })
    res.status(200).json({
      ...live,
      ranking: data?.ranking || [],
      updated: data?.updated || live.scannedAt,
      strategies: data?.strategies || STRATEGIES,
      timeframes: SUPPORTED_TIMEFRAMES,
    })
  } catch (e) {
    res.status(400).json({
      error: String(e.message || e),
      strategies: STRATEGIES,
      timeframes: SUPPORTED_TIMEFRAMES,
      periods: PERIODS,
    })
  }
}

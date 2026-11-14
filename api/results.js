import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PERIODS = ['7d', '15d', '1m', '3m', '6m', '1y', '3y', '5y']

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
  throw new Error('strategy_summary.json not found')
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

  try {
    const data = await loadSummary()
    const rows = (data.results || []).filter(
      (r) => r.symbol === symbol && r.strategy === strategy && r.timeframe === timeframe,
    )
    if (!rows.length) {
      res.status(404).json({
        error: 'no research row for this selection',
        strategies: data.strategies,
        periods: data.periods || PERIODS,
        hint: 'Run python strategy_research_report.py to refresh strategy_summary.json',
      })
      return
    }
    const row = rows[0]
    const periods = row.periods || {}
    const periodRow = periods[period] || periods['5y']
    if (!periodRow) {
      res.status(404).json({ error: `period ${period} missing`, periods: Object.keys(periods) })
      return
    }

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
      summary,
      trade_list: tradeList,
      period_cards: periodCards,
      periods: data.periods || PERIODS,
      ranking: data.ranking,
      updated: data.updated,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
}

/** CLI: node scripts/run_results.mjs symbol=BTCUSDT strategy=... timeframe=1h period=5y */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOnDemandBacktest } from '../lib/backtest.mjs'
import { STRATEGIES } from '../lib/strategies.mjs'
import { PERIOD_DAYS, SUPPORTED_TIMEFRAMES } from '../lib/timeframes.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PERIODS = Object.keys(PERIOD_DAYS)

function args() {
  const out = {}
  for (const a of process.argv.slice(2)) {
    const i = a.indexOf('=')
    if (i > 0) out[a.slice(0, i)] = a.slice(i + 1)
  }
  return out
}

async function loadSummary() {
  for (const p of [
    path.join(root, 'api', 'strategy_summary.json'),
    path.join(root, 'ui', 'public', 'strategy_summary.json'),
  ]) {
    try {
      return JSON.parse(await readFile(p, 'utf8'))
    } catch {
      /* next */
    }
  }
  return null
}

async function loadTrades(fileName) {
  if (!fileName) return []
  for (const p of [
    path.join(root, 'api', 'trades', fileName),
    path.join(root, 'ui', 'public', 'trades', fileName),
  ]) {
    try {
      return JSON.parse(await readFile(p, 'utf8'))
    } catch {
      /* next */
    }
  }
  return []
}

const a = args()
const symbol = String(a.symbol || 'BTCUSDT').toUpperCase()
const strategy = String(a.strategy || 'Donchian Breakout')
const timeframe = String(a.timeframe || '1h')
const period = String(a.period || '5y')
const force = a.ondemand === '1'

try {
  const data = force ? null : await loadSummary()
  const rows = (data?.results || []).filter(
    (r) => r.symbol === symbol && r.strategy === strategy && r.timeframe === timeframe,
  )
  if (rows.length) {
    const row = rows[0]
    const periods = row.periods || {}
    const periodRow = periods[period] || periods['5y']
    if (periodRow) {
      const tradeList = await loadTrades(periodRow.trades_file)
      const successful = tradeList.filter((t) => t.outcome === 'successful').length
      const trades = periodRow.trades ?? tradeList.length
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
      console.log(JSON.stringify({
        ready: true,
        source: 'research',
        summary: {
          symbol,
          strategy,
          timeframe,
          period,
          from: periodRow.from,
          to: periodRow.to,
          trades,
          successful,
          failed: Math.max(0, trades - successful),
          success_rate_pct: periodRow.win_rate_pct != null
            ? Number(Number(periodRow.win_rate_pct).toFixed(2))
            : null,
          net_return_pct: periodRow.net_return_pct,
          profit_factor: periodRow.profit_factor,
          max_dd_pct: periodRow.max_dd_pct,
          expectancy: periodRow.expectancy,
          final_equity: periodRow.final_equity,
          stop_exit_pct: periodRow.stop_exit_pct,
          data_source: 'research:strategy_summary.json',
          trades_file: periodRow.trades_file || null,
        },
        trade_list: tradeList,
        period_cards: periodCards,
        periods: data.periods || PERIODS,
        ranking: data.ranking,
        updated: data.updated,
        strategies: data.strategies || STRATEGIES,
        timeframes: SUPPORTED_TIMEFRAMES,
      }))
      process.exit(0)
    }
  }

  const live = await runOnDemandBacktest({ symbol, strategy, timeframe, period })
  console.log(JSON.stringify({
    ...live,
    ranking: data?.ranking || [],
    updated: data?.updated || live.scannedAt,
    strategies: data?.strategies || STRATEGIES,
    timeframes: SUPPORTED_TIMEFRAMES,
  }))
} catch (e) {
  console.error(String(e.message || e))
  process.exit(1)
}

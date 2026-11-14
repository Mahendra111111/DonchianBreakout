import { fetchKlines } from '../lib/binance.mjs'
import { barsToCandles, runPaperTrades } from '../lib/paper.mjs'
import { latestClosedSignals } from '../lib/strategies.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=')
    return i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a, '1']
  }),
)

const symbol = (args.symbol || 'SOLUSDT').toUpperCase()
const timeframe = args.timeframe || '1h'
const strategy = args.strategy || 'Donchian Breakout'
const limit = Math.min(1000, Math.max(300, Number(args.limit) || 500))

try {
  const bars = await fetchKlines(symbol, timeframe, limit)
  const paper = runPaperTrades(bars, strategy)
  const candles = barsToCandles(bars)
  const signals = latestClosedSignals(bars).filter((a) => a.strategy === strategy)
  const wins = paper.trades.filter((t) => t.outcome === 'successful').length
  process.stdout.write(JSON.stringify({
    ready: true,
    live: true,
    note: 'Paper simulation on live exchange candles — not real orders',
    scannedAt: new Date().toISOString(),
    symbol,
    timeframe,
    strategy,
    source: bars.source || 'binance',
    candles,
    trade_list: paper.trades,
    open: paper.open,
    signals,
    summary: {
      trades: paper.trades.length,
      successful: wins,
      failed: paper.trades.length - wins,
      open: Boolean(paper.open),
      equity: paper.equity,
      stop_atr: paper.stop_atr,
      rr: paper.rr,
    },
  }))
} catch (e) {
  console.error(String(e.message || e))
  process.exit(1)
}

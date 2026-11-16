import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchKlines } from '../lib/binance.mjs'
import { notifyPaperEntries } from '../lib/notifyPaper.mjs'
import { barsToCandles, runPaperTrades } from '../lib/paper.mjs'
import { latestClosedSignals } from '../lib/strategies.mjs'
import { telegramConfigured } from '../lib/telegram.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] == null) process.env[key] = val
  }
}

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
const notify = args.notify === '1'

try {
  const bars = await fetchKlines(symbol, timeframe, limit)
  const paper = runPaperTrades(bars, strategy)
  const candles = barsToCandles(bars)
  const signals = latestClosedSignals(bars).filter((a) => a.strategy === strategy)
  const wins = paper.trades.filter((t) => t.outcome === 'successful').length
  let telegram = { notified: [], skipped: !notify }
  if (notify) {
    telegram = await notifyPaperEntries({
      symbol,
      strategy,
      timeframe,
      open: paper.open,
      trades: paper.trades,
    })
  }
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
    telegramConfigured: telegramConfigured(),
    telegramNotifyCount: telegram.notified?.length || 0,
    telegramNotified: telegram.notified || [],
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

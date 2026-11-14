import { fetchKlines } from '../lib/binance.mjs'
import { barsToCandles, runPaperTrades } from '../lib/paper.mjs'
import { latestClosedSignals } from '../lib/strategies.mjs'

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
  const timeframe = String(req.query?.timeframe || '1h')
  const strategy = String(req.query?.strategy || 'Donchian Breakout')
  const limit = Math.min(1000, Math.max(300, Number(req.query?.limit) || 500))

  try {
    const bars = await fetchKlines(symbol, timeframe, limit)
    const paper = runPaperTrades(bars, strategy)
    const candles = barsToCandles(bars)
    const signals = latestClosedSignals(bars).filter((a) => a.strategy === strategy)
    const wins = paper.trades.filter((t) => t.outcome === 'successful').length

    res.status(200).json({
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
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
}

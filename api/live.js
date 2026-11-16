import { fetchKlines } from '../lib/binance.mjs'
import { notifyPaperEntries } from '../lib/notifyPaper.mjs'
import { barsToCandles, runPaperTrades } from '../lib/paper.mjs'
import { latestClosedSignals } from '../lib/strategies.mjs'
import { normalizeSymbol } from '../lib/symbolAliases.mjs'
import { telegramConfigured } from '../lib/telegram.mjs'

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

  const symbol = normalizeSymbol(req.query?.symbol || 'SOLUSDT')
  const timeframe = String(req.query?.timeframe || '1h')
  const strategy = String(req.query?.strategy || 'Donchian Breakout')
  const limit = Math.min(1000, Math.max(300, Number(req.query?.limit) || 500))
  // Desk paper poll: notify=1 sends Telegram for fresh entries on THIS chart TF
  const notify = String(req.query?.notify || '') === '1'

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
        trades: paper.trade_list || paper.trades,
      })
    }

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
    })
  } catch (e) {
    const msg = String(e.message || e)
    const bad = /HTTP 400|Symbol Is Invalid|invalid symbol/i.test(msg)
    res.status(bad ? 400 : 500).json({
      error: bad
        ? `${symbol} not tradable on Binance/Bybit USDT-M. Use + search (gold → XAUT/PAXG; meme → 1000PEPE). ${msg}`
        : msg,
      symbol,
    })
  }
}

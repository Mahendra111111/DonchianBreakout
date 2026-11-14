import { fetchKlines } from './binance.mjs'
import { SYMBOLS, latestClosedSignals, recentClosedSignals } from './strategies.mjs'
import { formatSignalMessage, sendTelegram, telegramConfigured } from './telegram.mjs'

const TIMEFRAME = process.env.SIGNAL_TIMEFRAME || '1h'
const RECENT_DAYS = Number(process.env.SIGNAL_RECENT_DAYS || 7)
const sent = globalThis.__signalSent || (globalThis.__signalSent = new Set())

function keyOf(symbol, alert) {
  return `${symbol}|${alert.strategy}|${alert.side}|${alert.barTime}`
}

export async function runSignalScan({ notify = true, recentDays = RECENT_DAYS } = {}) {
  const scannedAt = new Date().toISOString()
  const signals = []
  const recent = []
  const notified = []
  const errors = []

  for (const symbol of SYMBOLS) {
    try {
      const bars = await fetchKlines(symbol, TIMEFRAME, 300)
      const live = latestClosedSignals(bars).map((a) => ({
        ...a,
        symbol,
        timeframe: TIMEFRAME,
        kind: 'live',
      }))
      const hist = recentClosedSignals(bars, recentDays).map((a) => ({
        ...a,
        symbol,
        timeframe: TIMEFRAME,
        kind: 'recent',
      }))
      signals.push(...live)
      recent.push(...hist)

      if (!notify) continue
      // Prefer sending every recent opportunity as its own Telegram record (deduped).
      const queue = hist.length ? hist : live
      for (const alert of queue) {
        const k = keyOf(symbol, alert)
        if (sent.has(k)) continue
        if (!telegramConfigured()) continue
        const result = await sendTelegram(formatSignalMessage(alert))
        if (result.ok) {
          sent.add(k)
          notified.push({ ...alert, telegram: true })
        } else if (!result.skipped) {
          errors.push({ symbol, strategy: alert.strategy, error: result })
        }
      }
    } catch (e) {
      errors.push({ symbol, error: String(e.message || e) })
    }
  }

  recent.sort((a, b) => b.barTime - a.barTime)

  return {
    scannedAt,
    timeframe: TIMEFRAME,
    recentDays,
    telegramConfigured: telegramConfigured(),
    signalCount: signals.length,
    recentCount: recent.length,
    notifyCount: notified.length,
    signals,
    recent,
    notified,
    errors,
  }
}

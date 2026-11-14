import { fetchKlines } from './binance.mjs'
import { SYMBOLS, latestClosedSignals } from './strategies.mjs'
import { formatSignalMessage, sendTelegram, telegramConfigured } from './telegram.mjs'

const TIMEFRAME = process.env.SIGNAL_TIMEFRAME || '1h'
const sent = globalThis.__signalSent || (globalThis.__signalSent = new Set())

function keyOf(symbol, alert) {
  return `${symbol}|${alert.strategy}|${alert.side}|${alert.barTime}`
}

export async function runSignalScan({ notify = true } = {}) {
  const scannedAt = new Date().toISOString()
  const signals = []
  const notified = []
  const errors = []

  for (const symbol of SYMBOLS) {
    try {
      const bars = await fetchKlines(symbol, TIMEFRAME, 300)
      const alerts = latestClosedSignals(bars).map((a) => ({
        ...a,
        symbol,
        timeframe: TIMEFRAME,
      }))
      for (const alert of alerts) {
        signals.push(alert)
        if (!notify) continue
        const k = keyOf(symbol, alert)
        if (sent.has(k)) continue
        if (!telegramConfigured()) continue
        const msg = formatSignalMessage(alert)
        const result = await sendTelegram(msg)
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

  return {
    scannedAt,
    timeframe: TIMEFRAME,
    telegramConfigured: telegramConfigured(),
    signalCount: signals.length,
    notifyCount: notified.length,
    signals,
    notified,
    errors,
  }
}

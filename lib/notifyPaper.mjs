/** Telegram when desk paper sim opens a real entry (same TF/strategy as the chart). */

import { isWithinFreshWindow, loadSent, saveSent } from './signalDedupe.mjs'
import { formatSignalMessage, sendTelegram, telegramConfigured } from './telegram.mjs'
import { INTERVAL_MS } from './timeframes.mjs'

function entryKey(symbol, strategy, timeframe, side, entryTime) {
  return `entry|${symbol}|${strategy}|${timeframe}|${side}|${entryTime}`
}

/**
 * Notify for a fresh open position and/or freshly entered closed trades.
 * Same-bar stop-outs still get an entry alert (entry time must be fresh).
 */
export async function notifyPaperEntries({
  symbol,
  strategy,
  timeframe,
  open,
  trades = [],
}) {
  if (!telegramConfigured()) {
    return { notified: [], skipped: true, reason: 'telegram not configured' }
  }

  const sentMap = await loadSent()
  const notified = []
  const now = Date.now()
  const barMs = INTERVAL_MS[timeframe] || INTERVAL_MS['1h']

  const candidates = []
  if (open?.entry_time) {
    candidates.push({
      side: open.side,
      entry: open.entry,
      stop: open.stop,
      target: open.target,
      entry_time: open.entry_time,
      signal_timestamp: open.entry_time,
    })
  }
  for (const t of trades.slice(-8)) {
    if (!t?.entry_time) continue
    candidates.push(t)
  }

  for (const t of candidates) {
    const entryMs = Date.parse(t.entry_time)
    if (!isWithinFreshWindow(entryMs, now)) continue
    const k = entryKey(symbol, strategy, timeframe, t.side, t.entry_time)
    if (sentMap[k]) continue

    const signalMs = t.signal_timestamp ? Date.parse(t.signal_timestamp) : entryMs - barMs
    const tradeAlert = {
      symbol,
      strategy,
      timeframe,
      side: t.side,
      entry: t.entry,
      stop: t.stop ?? t.stop_loss,
      target: t.target ?? t.take_profit,
      entryTime: entryMs,
      signalCloseTime: Number.isFinite(signalMs) ? signalMs + barMs : entryMs,
      barTime: signalMs,
    }
    const result = await sendTelegram(formatSignalMessage(tradeAlert))
    if (result.ok) {
      sentMap[k] = now
      notified.push({ ...tradeAlert, telegram: true })
    }
  }

  if (notified.length) await saveSent(sentMap)
  return { notified, skipped: false }
}

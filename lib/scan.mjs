import { fetchKlines } from './binance.mjs'
import { isWithinFreshWindow, loadSent, saveSent } from './signalDedupe.mjs'
import { tradePlanFromSignal } from './paper.mjs'
import { SYMBOLS, latestClosedSignals, recentClosedSignals } from './strategies.mjs'
import { formatSignalMessage, sendTelegram, telegramConfigured } from './telegram.mjs'
import { INTERVAL_MS, isSupportedTimeframe } from './timeframes.mjs'
import { readWatchlist } from './watchlistStore.mjs'

/** Always 5m + 15m + 1h for Telegram (override with SIGNAL_TIMEFRAMES). */
const TIMEFRAMES = String(process.env.SIGNAL_TIMEFRAMES || '5m,15m,1h')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => isSupportedTimeframe(s))

const RECENT_HOURS = Number(process.env.SIGNAL_RECENT_HOURS || 24)

function normalizeSymbols(list) {
  const out = []
  const seen = new Set()
  for (const raw of list || []) {
    let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!s) continue
    if (!s.endsWith('USDT')) s = `${s}USDT`
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out.slice(0, 40)
}

async function resolveSymbols(override) {
  if (override?.length) return normalizeSymbols(override)
  const raw = process.env.SIGNAL_SYMBOLS
  if (raw && String(raw).trim()) {
    return normalizeSymbols(String(raw).split(','))
  }
  try {
    return normalizeSymbols(await readWatchlist())
  } catch {
    return [...SYMBOLS]
  }
}

function keyOf(symbol, timeframe, alert) {
  return `${symbol}|${timeframe}|${alert.strategy}|${alert.side}|${alert.barTime}`
}

/**
 * barTime = candle OPEN. Fresh = closed within SIGNAL_FRESH_MINUTES.
 */
function isFreshClosedBar(barOpenMs, timeframe, nowMs = Date.now()) {
  const barMs = INTERVAL_MS[timeframe] || INTERVAL_MS['1h']
  const open = Number(barOpenMs)
  if (!Number.isFinite(open)) return false
  return isWithinFreshWindow(open + barMs, nowMs)
}

/**
 * Scan watchlist × signal timeframes.
 * Telegram: fresh latest-closed-bar signals only (with entry/stop/target).
 */
export async function runSignalScan({
  notify = true,
  recentHours = RECENT_HOURS,
  symbols: symbolsOverride,
} = {}) {
  const scannedAt = new Date().toISOString()
  const timeframes = TIMEFRAMES.length ? TIMEFRAMES : ['5m', '15m', '1h']
  const symbols = await resolveSymbols(symbolsOverride)
  const recentDays = Math.max(1, Math.ceil(Number(recentHours) / 24) || 1)
  const cutoffMs = Date.now() - Number(recentHours) * 60 * 60_000

  const signals = []
  const recent = []
  const notified = []
  const errors = []
  const sentMap = notify ? await loadSent() : {}

  for (const symbol of symbols) {
    for (const timeframe of timeframes) {
      try {
        const bars = await fetchKlines(symbol, timeframe, 300)
        const live = latestClosedSignals(bars).map((a) => ({
          ...a,
          symbol,
          timeframe,
          kind: 'live',
        }))
        const hist = recentClosedSignals(bars, recentDays)
          .map((a) => ({
            ...a,
            symbol,
            timeframe,
            kind: 'recent',
          }))
          .filter((a) => Number(a.barTime) >= cutoffMs)

        signals.push(...live)
        recent.push(...hist)

        if (!notify || !telegramConfigured()) continue

        for (const alert of live) {
          if (!isFreshClosedBar(alert.barTime, timeframe)) continue
          if (Number(alert.barTime) < cutoffMs) continue
          const k = keyOf(symbol, timeframe, alert)
          if (sentMap[k]) continue
          const plan = tradePlanFromSignal(bars, alert.strategy, alert.side, alert.index)
          if (!plan) continue
          const barMs = INTERVAL_MS[timeframe] || INTERVAL_MS['1h']
          const tradeAlert = {
            ...alert,
            kind: 'live',
            entry: plan.entry,
            stop: plan.stop,
            target: plan.target,
            entryTime: plan.entryTime,
            signalCloseTime: Number(alert.barTime) + barMs,
          }
          const result = await sendTelegram(formatSignalMessage(tradeAlert))
          if (result.ok) {
            sentMap[k] = Date.now()
            notified.push({ ...tradeAlert, telegram: true })
          } else if (!result.skipped) {
            errors.push({ symbol, timeframe, strategy: alert.strategy, error: result })
          }
        }
      } catch (e) {
        errors.push({ symbol, timeframe, error: String(e.message || e) })
      }
    }
  }

  if (notify && Object.keys(sentMap).length) await saveSent(sentMap)

  recent.sort((a, b) => b.barTime - a.barTime)

  return {
    scannedAt,
    timeframe: timeframes.join(','),
    timeframes,
    recentHours: Number(recentHours),
    recentDays,
    symbols,
    telegramConfigured: telegramConfigured(),
    signalCount: signals.length,
    recentCount: recent.length,
    notifyCount: notified.length,
    signals,
    recent,
    notified,
    errors,
    note: notify
      ? `Telegram: fresh closed-bar signals on ${timeframes.join(', ')} watchlist.`
      : 'Telegram off. Desk list: last 24h real closed bars.',
  }
}

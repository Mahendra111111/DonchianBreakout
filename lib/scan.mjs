import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchKlines } from './binance.mjs'
import { SYMBOLS, latestClosedSignals, recentClosedSignals } from './strategies.mjs'
import { formatSignalMessage, sendTelegram, telegramConfigured } from './telegram.mjs'
import { INTERVAL_MS, isSupportedTimeframe } from './timeframes.mjs'

const TIMEFRAME = process.env.SIGNAL_TIMEFRAME || '1h'
/** Desk / UI: show real closed-bar signals from the last N hours (default 24). */
const RECENT_HOURS = Number(process.env.SIGNAL_RECENT_HOURS || 24)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dedupeFile = process.env.VERCEL
  ? path.join('/tmp', 'signal_sent.json')
  : path.join(root, 'exports', 'signal_sent.json')

function watchlistSymbols() {
  const raw = process.env.SIGNAL_SYMBOLS
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  }
  return [...SYMBOLS]
}

function keyOf(symbol, alert) {
  return `${symbol}|${alert.strategy}|${alert.side}|${alert.barTime}`
}

async function loadSent() {
  try {
    const raw = JSON.parse(await readFile(dedupeFile, 'utf8'))
    const cutoff = Date.now() - 48 * 60 * 60_000
    const map = {}
    for (const [k, ts] of Object.entries(raw || {})) {
      if (Number(ts) >= cutoff) map[k] = Number(ts)
    }
    return map
  } catch {
    return {}
  }
}

async function saveSent(map) {
  try {
    await mkdir(path.dirname(dedupeFile), { recursive: true })
    await writeFile(dedupeFile, JSON.stringify(map), 'utf8')
  } catch {
    /* ignore on read-only hosts */
  }
}

/** Last closed bar is "live" only if it closed recently (not a stale history dump). */
function isFreshClosedBar(barTimeMs, timeframe) {
  const barMs = INTERVAL_MS[timeframe] || INTERVAL_MS['1h']
  const age = Date.now() - Number(barTimeMs)
  // Bar open time → allow up to ~1.25 intervals after close (close ≈ open + barMs)
  return Number.isFinite(age) && age >= 0 && age <= barMs * 2.25
}

/**
 * Scan watchlist symbols.
 * - Always returns last-24h real closed-bar signals for the desk.
 * - Telegram (notify=true): ONLY fresh latest-closed-bar signals, never the history dump.
 */
export async function runSignalScan({
  notify = true,
  recentHours = RECENT_HOURS,
} = {}) {
  const scannedAt = new Date().toISOString()
  const timeframe = isSupportedTimeframe(TIMEFRAME) ? TIMEFRAME : '1h'
  const symbols = watchlistSymbols()
  const recentDays = Math.max(1, Math.ceil(Number(recentHours) / 24) || 1)
  const cutoffMs = Date.now() - Number(recentHours) * 60 * 60_000

  const signals = []
  const recent = []
  const notified = []
  const errors = []
  const sentMap = notify ? await loadSent() : {}

  for (const symbol of symbols) {
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

      // Real alerts only: latest closed bar, still fresh, not already sent
      for (const alert of live) {
        if (!isFreshClosedBar(alert.barTime, timeframe)) continue
        if (Number(alert.barTime) < cutoffMs) continue
        const k = keyOf(symbol, alert)
        if (sentMap[k]) continue
        const result = await sendTelegram(formatSignalMessage({ ...alert, kind: 'live' }))
        if (result.ok) {
          sentMap[k] = Date.now()
          notified.push({ ...alert, telegram: true })
        } else if (!result.skipped) {
          errors.push({ symbol, strategy: alert.strategy, error: result })
        }
      }
    } catch (e) {
      errors.push({ symbol, error: String(e.message || e) })
    }
  }

  if (notify && Object.keys(sentMap).length) await saveSent(sentMap)

  recent.sort((a, b) => b.barTime - a.barTime)

  return {
    scannedAt,
    timeframe,
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
      ? 'Telegram: fresh latest-closed signals only (watchlist). Desk list: last 24h real closed bars.'
      : 'Telegram off for this run. Desk list: last 24h real closed bars.',
  }
}

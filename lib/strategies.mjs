/** EMA Trend + Donchian Breakout signal helpers (mirrors Python research). */

export const STRATEGIES = ['EMA Trend Following', 'Donchian Breakout']
export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']

function ewma(values, span) {
  const out = new Array(values.length).fill(NaN)
  const alpha = 2 / (span + 1)
  let prev = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    prev = prev == null ? v : alpha * v + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

function rollingMax(values, n) {
  const out = new Array(values.length).fill(NaN)
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < n) continue
    let m = -Infinity
    for (let j = i - n + 1; j <= i; j++) m = Math.max(m, values[j])
    out[i] = m
  }
  return out
}

function rollingMin(values, n) {
  const out = new Array(values.length).fill(NaN)
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < n) continue
    let m = Infinity
    for (let j = i - n + 1; j <= i; j++) m = Math.min(m, values[j])
    out[i] = m
  }
  return out
}

/** @param {{ open:number[], high:number[], low:number[], close:number[], time:number[] }} bars */
export function emaSignals(bars) {
  const e20 = ewma(bars.close, 20)
  const e50 = ewma(bars.close, 50)
  const n = bars.close.length
  const longEntry = new Array(n).fill(false)
  const shortEntry = new Array(n).fill(false)
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(e20[i]) || !Number.isFinite(e50[i])) continue
    if (!Number.isFinite(e20[i - 1]) || !Number.isFinite(e50[i - 1])) continue
    longEntry[i] = e20[i] > e50[i] && e20[i - 1] <= e50[i - 1]
    shortEntry[i] = e20[i] < e50[i] && e20[i - 1] >= e50[i - 1]
  }
  return { longEntry, shortEntry }
}

/** @param {{ open:number[], high:number[], low:number[], close:number[], time:number[] }} bars */
export function donchianSignals(bars, lookback = 20) {
  const hi = rollingMax(bars.high, lookback)
  const lo = rollingMin(bars.low, lookback)
  const n = bars.close.length
  const longEntry = new Array(n).fill(false)
  const shortEntry = new Array(n).fill(false)
  for (let i = 1; i < n; i++) {
    const prevHi = hi[i - 1]
    const prevLo = lo[i - 1]
    if (!Number.isFinite(prevHi) || !Number.isFinite(prevLo)) continue
    longEntry[i] = bars.close[i] > prevHi
    shortEntry[i] = bars.close[i] < prevLo
  }
  return { longEntry, shortEntry }
}

export function signalsFor(name, bars) {
  if (name === 'EMA Trend Following') return emaSignals(bars)
  if (name === 'Donchian Breakout') return donchianSignals(bars)
  throw new Error(`Unknown strategy: ${name}`)
}

/**
 * Evaluate closed-bar signals (exclude forming candle at end).
 * Returns alerts for the last closed bar only.
 */
export function latestClosedSignals(bars) {
  // last index is usually the open/forming candle from Binance; use -2 as last closed
  const closed = bars.close.length >= 3 ? bars.close.length - 2 : bars.close.length - 1
  if (closed < 50) return []
  const alerts = []
  for (const name of STRATEGIES) {
    const { longEntry, shortEntry } = signalsFor(name, bars)
    if (longEntry[closed]) {
      alerts.push({
        strategy: name,
        side: 'LONG',
        barTime: bars.time[closed],
        close: bars.close[closed],
        index: closed,
      })
    }
    if (shortEntry[closed]) {
      alerts.push({
        strategy: name,
        side: 'SHORT',
        barTime: bars.time[closed],
        close: bars.close[closed],
        index: closed,
      })
    }
  }
  return alerts
}

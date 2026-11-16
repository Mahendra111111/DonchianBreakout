/** Strategy signal helpers (mirrors Python research / Pine hammer rules). */

export const STRATEGIES = [
  'EMA Trend Following',
  'Donchian Breakout',
  'Hammer SMA VWAP',
  'VWAP Rejection V1',
]

export const SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'LINKUSDT',
  'AVAXUSDT',
  'ADAUSDT',
]

/** Minimum closed-bar index required before evaluating a strategy. */
export const STRATEGY_WARMUP = {
  'EMA Trend Following': 50,
  'Donchian Breakout': 20,
  'Hammer SMA VWAP': 200,
  'VWAP Rejection V1': 25,
}

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

function sma(values, len) {
  const out = new Array(values.length).fill(NaN)
  for (let i = len - 1; i < values.length; i++) {
    let sum = 0
    let ok = true
    for (let j = i - len + 1; j <= i; j++) {
      if (!Number.isFinite(values[j])) {
        ok = false
        break
      }
      sum += values[j]
    }
    if (ok) out[i] = sum / len
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

function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
}

/** Session VWAP from HLC3, resets each UTC day (matches Pine ta.vwap session). */
export function sessionVwap(bars) {
  const n = bars.close.length
  const out = new Array(n).fill(NaN)
  let day = null
  let cumPv = 0
  let cumV = 0
  for (let i = 0; i < n; i++) {
    const key = dayKey(bars.time[i])
    if (key !== day) {
      day = key
      cumPv = 0
      cumV = 0
    }
    const typical = (bars.high[i] + bars.low[i] + bars.close[i]) / 3
    const vol = bars.volume?.[i] ?? 0
    if (!Number.isFinite(typical) || !Number.isFinite(vol)) continue
    cumPv += typical * vol
    cumV += vol
    if (cumV > 0) out[i] = cumPv / cumV
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

/**
 * Pine: Hammer / hanging man / inverted hammer / shooting star
 * + close vs SMA(200) + candle touches session VWAP.
 */
export function hammerSmaVwapSignals(bars, smaLen = 200) {
  const n = bars.close.length
  const longEntry = new Array(n).fill(false)
  const shortEntry = new Array(n).fill(false)
  const ma = sma(bars.close, smaLen)
  const vwap = sessionVwap(bars)

  for (let i = 0; i < n; i++) {
    const o = bars.open[i]
    const h = bars.high[i]
    const l = bars.low[i]
    const c = bars.close[i]
    if (![o, h, l, c].every(Number.isFinite)) continue
    const body = Math.abs(c - o)
    const range = h - l
    if (!(range > 0 && body > 0)) continue
    const upWick = h - Math.max(c, o)
    const dnWick = Math.min(c, o) - l
    const smallUpper = upWick <= Math.max(body * 0.5, range * 0.12)
    const smallLower = dnWick <= Math.max(body * 0.5, range * 0.12)
    const hammerShape = dnWick >= 2.0 * body && smallUpper
    const invShape = upWick >= 2.0 * body && smallLower
    const isPattern = hammerShape || invShape
    if (!isPattern || !Number.isFinite(ma[i]) || !Number.isFinite(vwap[i])) continue
    const touches = l <= vwap[i] && h >= vwap[i]
    if (!touches) continue
    if (c > ma[i]) longEntry[i] = true
    if (c < ma[i]) shortEntry[i] = true
  }
  return { longEntry, shortEntry }
}

/**
 * VWAP Rejection V1: session VWAP rejection + 3 increasing volumes above SMA20.
 * @param {{ open:number[], high:number[], low:number[], close:number[], volume?:number[], time:number[] }} bars
 * @param {{ minWickBody?: number, maxOppWickBody?: number, volumeSmaPeriod?: number, increasingCandles?: number }} [opts]
 */
export function vwapRejectionSignals(bars, opts = {}) {
  const minWickBody = opts.minWickBody ?? 2.0
  const maxOppWickBody = opts.maxOppWickBody ?? 1.0
  const volumeSmaPeriod = opts.volumeSmaPeriod ?? 20
  const increasingCandles = opts.increasingCandles ?? 3

  const n = bars.close.length
  const longEntry = new Array(n).fill(false)
  const shortEntry = new Array(n).fill(false)
  const vol = bars.volume || new Array(n).fill(NaN)
  const vwap = sessionVwap(bars)
  const volSma = sma(vol, volumeSmaPeriod)
  const need = Math.max(volumeSmaPeriod, increasingCandles) - 1

  for (let i = need; i < n; i++) {
    const o = bars.open[i]
    const h = bars.high[i]
    const l = bars.low[i]
    const c = bars.close[i]
    const v = vol[i]
    if (![o, h, l, c, v].every(Number.isFinite)) continue
    if (!Number.isFinite(vwap[i]) || !Number.isFinite(volSma[i])) continue

    let volInc = true
    for (let k = 0; k < increasingCandles - 1; k++) {
      const a = vol[i - k]
      const b = vol[i - k - 1]
      if (!(Number.isFinite(a) && Number.isFinite(b) && a > b)) {
        volInc = false
        break
      }
    }
    if (!volInc || !(v > volSma[i])) continue

    const body = Math.abs(c - o)
    if (!(body > 0)) continue
    const upWick = h - Math.max(c, o)
    const dnWick = Math.min(c, o) - l

    const bullish =
      dnWick >= minWickBody * body &&
      upWick <= maxOppWickBody * body &&
      l <= vwap[i] &&
      c > vwap[i]
    const bearish =
      upWick >= minWickBody * body &&
      dnWick <= maxOppWickBody * body &&
      h >= vwap[i] &&
      c < vwap[i]

    if (bullish) longEntry[i] = true
    if (bearish) shortEntry[i] = true
  }
  return { longEntry, shortEntry }
}

export function signalsFor(name, bars) {
  if (!name) {
    const z = new Array(bars.close.length).fill(false)
    return { longEntry: z, shortEntry: z }
  }
  if (name === 'EMA Trend Following') return emaSignals(bars)
  if (name === 'Donchian Breakout') return donchianSignals(bars)
  if (name === 'Hammer SMA VWAP') return hammerSmaVwapSignals(bars)
  if (name === 'VWAP Rejection V1') return vwapRejectionSignals(bars)
  throw new Error(`Unknown strategy: ${name}`)
}

function collectAlertsAt(bars, i, strategies = STRATEGIES) {
  const alerts = []
  for (const name of strategies) {
    const warm = STRATEGY_WARMUP[name] ?? 50
    if (i < warm) continue
    const { longEntry, shortEntry } = signalsFor(name, bars)
    if (longEntry[i]) {
      alerts.push({
        strategy: name,
        side: 'LONG',
        barTime: bars.time[i],
        close: bars.close[i],
        index: i,
      })
    }
    if (shortEntry[i]) {
      alerts.push({
        strategy: name,
        side: 'SHORT',
        barTime: bars.time[i],
        close: bars.close[i],
        index: i,
      })
    }
  }
  return alerts
}

/**
 * Evaluate closed-bar signals (exclude forming candle at end).
 * Returns alerts for the last closed bar only.
 */
export function latestClosedSignals(bars) {
  const closed = bars.close.length >= 3 ? bars.close.length - 2 : bars.close.length - 1
  if (closed < 0) return []
  return collectAlertsAt(bars, closed)
}

/**
 * All strategy entries on closed bars within the last `days` days (for Telegram digests).
 */
export function recentClosedSignals(bars, days = 7) {
  const closed = bars.close.length >= 3 ? bars.close.length - 2 : bars.close.length - 1
  if (closed < 0) return []
  const cutoff = bars.time[closed] - days * 24 * 60 * 60 * 1000
  const minWarm = Math.min(...Object.values(STRATEGY_WARMUP))
  const from = Math.max(minWarm, closed - days * 48)
  const out = []
  for (let i = from; i <= closed; i++) {
    if (bars.time[i] < cutoff) continue
    out.push(...collectAlertsAt(bars, i))
  }
  out.sort((a, b) => b.barTime - a.barTime)
  return out
}

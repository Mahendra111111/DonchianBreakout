/** Indicator overlays: strategy lines + Volume / RSI / Support & Resistance. */

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

function dayKey(sec) {
  const d = new Date(sec * 1000)
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
}

function sessionVwap(candles) {
  const n = candles.length
  const out = new Array(n).fill(NaN)
  let day = null
  let cumPv = 0
  let cumV = 0
  for (let i = 0; i < n; i++) {
    const key = dayKey(candles[i].time)
    if (key !== day) {
      day = key
      cumPv = 0
      cumV = 0
    }
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3
    const vol = candles[i].volume ?? 0
    if (!Number.isFinite(typical) || !Number.isFinite(vol)) continue
    cumPv += typical * vol
    cumV += vol
    if (cumV > 0) out[i] = cumPv / cumV
  }
  return out
}

function toLine(candles, values) {
  const out = []
  for (let i = 0; i < candles.length; i++) {
    if (Number.isFinite(values[i])) out.push({ time: candles[i].time, value: values[i] })
  }
  return out
}

/** Wilder RSI(14). */
export function rsiSeries(candles, period = 14) {
  if (!candles?.length) return []
  const closes = candles.map((c) => c.close)
  const out = new Array(closes.length).fill(NaN)
  if (closes.length <= period) return toLine(candles, out)

  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const g = d > 0 ? d : 0
    const l = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return toLine(candles, out)
}

/** Exact per-bar volume for histogram (color by candle direction). */
export function volumeHistogram(candles) {
  if (!candles?.length) return []
  return candles.map((c) => ({
    time: c.time,
    value: Number(c.volume) || 0,
    color: c.close >= c.open ? 'rgba(61, 186, 122, 0.55)' : 'rgba(227, 93, 93, 0.55)',
  }))
}

/**
 * Pivot-style Support & Resistance (fractal swings), like TV S/R levels.
 * @returns {{ price: number, kind: 'support'|'resistance', title: string }[]}
 */
export function supportResistanceLevels(candles, { left = 5, right = 5, maxLevels = 8 } = {}) {
  if (!candles || candles.length < left + right + 3) return []
  const pivots = []
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (candles[j].high >= candles[i].high) isHigh = false
      if (candles[j].low <= candles[i].low) isLow = false
    }
    if (isHigh) pivots.push({ price: candles[i].high, kind: 'resistance', at: i })
    if (isLow) pivots.push({ price: candles[i].low, kind: 'support', at: i })
  }

  const last = candles[candles.length - 1]?.close
  const tol = last > 0 ? last * 0.004 : 0
  const clustered = []
  for (const p of [...pivots].reverse()) {
    if (clustered.some((c) => Math.abs(c.price - p.price) <= tol)) continue
    clustered.push(p)
    if (clustered.length >= maxLevels * 2) break
  }

  const supports = clustered.filter((p) => p.kind === 'support').slice(0, maxLevels / 2)
  const resistances = clustered.filter((p) => p.kind === 'resistance').slice(0, maxLevels / 2)
  let si = 1
  let ri = 1
  return [
    ...resistances.map((p) => ({ ...p, title: `R${ri++}` })),
    ...supports.map((p) => ({ ...p, title: `S${si++}` })),
  ]
}

export function fmtVolume(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`
  return n.toFixed(2)
}

/**
 * @returns {{ label: string, lines: { title: string, color: string, data: {time:number,value:number}[] }[] }}
 */
export function strategyOverlays(strategy, candles) {
  if (!strategy || !candles?.length) return { label: '', lines: [] }

  if (strategy === 'Donchian Breakout') {
    const n = 20
    const hi = rollingMax(candles.map((c) => c.high), n)
    const lo = rollingMin(candles.map((c) => c.low), n)
    const upper = hi.map((_, i) => (i > 0 ? hi[i - 1] : NaN))
    const lower = lo.map((_, i) => (i > 0 ? lo[i - 1] : NaN))
    return {
      label: 'Donchian 20',
      lines: [
        { title: 'DC Upper', color: '#4aa3ff', data: toLine(candles, upper) },
        { title: 'DC Lower', color: '#d4a017', data: toLine(candles, lower) },
      ],
    }
  }

  if (strategy === 'Hammer SMA VWAP') {
    const closes = candles.map((c) => c.close)
    return {
      label: 'SMA 200 + VWAP',
      lines: [
        { title: 'SMA 200', color: '#c6f54c', data: toLine(candles, sma(closes, 200)) },
        { title: 'Session VWAP', color: '#b388ff', data: toLine(candles, sessionVwap(candles)) },
      ],
    }
  }

  return { label: '', lines: [] }
}

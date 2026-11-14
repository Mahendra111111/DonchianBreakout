/** Indicator overlays matching research / live strategy rules. */

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

/**
 * @returns {{ label: string, lines: { title: string, color: string, data: {time:number,value:number}[] }[] }}
 */
export function strategyOverlays(strategy, candles) {
  if (!candles?.length) return { label: '', lines: [] }

  if (strategy === 'Donchian Breakout') {
    const n = 20
    const hi = rollingMax(candles.map((c) => c.high), n)
    const lo = rollingMin(candles.map((c) => c.low), n)
    // Match research: breakout vs prior bar's channel
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

  if (strategy === 'EMA Trend Following') {
    const closes = candles.map((c) => c.close)
    return {
      label: 'EMA 20 / 50',
      lines: [
        { title: 'EMA 20', color: '#c6f54c', data: toLine(candles, ewma(closes, 20)) },
        { title: 'EMA 50', color: '#4aa3ff', data: toLine(candles, ewma(closes, 50)) },
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

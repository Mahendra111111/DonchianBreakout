/** Public kline fetch with Binance primary + Bybit fallback (Vercel US often gets Binance HTTP 451). */

const INTERVAL_TO_BYBIT = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
}

export const INTERVAL_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

function normalizeBars(rows) {
  return {
    time: rows.map((r) => Number(r[0])),
    open: rows.map((r) => Number(r[1])),
    high: rows.map((r) => Number(r[2])),
    low: rows.map((r) => Number(r[3])),
    close: rows.map((r) => Number(r[4])),
    volume: rows.map((r) => Number(r[5])),
  }
}

function toCandles(bars) {
  return bars.time.map((t, i) => ({
    time: Math.floor(t / 1000),
    open: bars.open[i],
    high: bars.high[i],
    low: bars.low[i],
    close: bars.close[i],
  }))
}

async function fetchBinance(symbol, interval, { limit, startTime, endTime } = {}) {
  const url = new URL('https://fapi.binance.com/fapi/v1/klines')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('interval', interval)
  if (limit != null) url.searchParams.set('limit', String(limit))
  if (startTime != null) url.searchParams.set('startTime', String(startTime))
  if (endTime != null) url.searchParams.set('endTime', String(endTime))
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Binance klines ${symbol} ${interval}: HTTP ${res.status}`)
  }
  return normalizeBars(await res.json())
}

async function fetchBybit(symbol, interval, { limit, startTime, endTime } = {}) {
  const bybitInterval = INTERVAL_TO_BYBIT[interval]
  if (!bybitInterval) {
    throw new Error(`Unsupported interval for Bybit fallback: ${interval}`)
  }
  const url = new URL('https://api.bybit.com/v5/market/kline')
  url.searchParams.set('category', 'linear')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('interval', bybitInterval)
  url.searchParams.set('limit', String(limit ?? 200))
  if (startTime != null) url.searchParams.set('start', String(startTime))
  if (endTime != null) url.searchParams.set('end', String(endTime))
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Bybit klines ${symbol} ${interval}: HTTP ${res.status}`)
  }
  const body = await res.json()
  if (body.retCode !== 0 || !body.result?.list?.length) {
    throw new Error(`Bybit klines ${symbol}: ${body.retMsg || 'empty'}`)
  }
  // Bybit returns newest-first: [start, open, high, low, close, volume, turnover]
  const rows = body.result.list
    .map((r) => [r[0], r[1], r[2], r[3], r[4], r[5]])
    .reverse()
  return normalizeBars(rows)
}

async function fetchWithFallback(symbol, interval, opts) {
  try {
    const bars = await fetchBinance(symbol, interval, opts)
    bars.source = 'binance'
    return bars
  } catch (binanceErr) {
    try {
      const bars = await fetchBybit(symbol, interval, opts)
      bars.source = 'bybit'
      return bars
    } catch (bybitErr) {
      throw new Error(`${binanceErr.message}; fallback ${bybitErr.message}`)
    }
  }
}

export async function fetchKlines(symbol, interval = '1h', limit = 120) {
  return fetchWithFallback(symbol, interval, { limit })
}

/** Historical window for trade chart review. Times are unix ms. */
export async function fetchKlinesRange(symbol, interval, startTime, endTime) {
  const barMs = INTERVAL_MS[interval]
  if (!barMs) throw new Error(`Unsupported interval: ${interval}`)
  const from = Number(startTime)
  const to = Number(endTime)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    throw new Error('from/to must be valid ms timestamps with to >= from')
  }
  const padBefore = 40 * barMs
  const padAfter = 20 * barMs
  const start = from - padBefore
  const end = to + padAfter
  const approxBars = Math.ceil((end - start) / barMs) + 2
  const limit = Math.min(1500, Math.max(50, approxBars))
  const bars = await fetchWithFallback(symbol, interval, {
    startTime: start,
    endTime: end,
    limit,
  })
  const candles = toCandles(bars).filter((c) => {
    const ms = c.time * 1000
    return ms >= start && ms <= end
  })
  return {
    symbol,
    timeframe: interval,
    source: bars.source || 'binance',
    from: start,
    to: end,
    candles,
  }
}

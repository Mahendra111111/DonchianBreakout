/** Public kline fetch with Binance primary + Bybit fallback (Vercel US often gets Binance HTTP 451). */

import { INTERVAL_MS as TF_MS, isSupportedTimeframe } from './timeframes.mjs'

const INTERVAL_TO_BYBIT = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '1d': 'D',
}

export const INTERVAL_MS = TF_MS

/** Soft cap so on-demand backtests stay within serverless time/memory. */
export const MAX_ON_DEMAND_BARS = 12_000

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
    volume: bars.volume?.[i] ?? 0,
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

async function tickerBinance(symbol) {
  const url = new URL('https://fapi.binance.com/fapi/v1/ticker/price')
  url.searchParams.set('symbol', symbol)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status}`)
  const body = await res.json()
  const price = Number(body.price)
  if (!Number.isFinite(price)) throw new Error('Binance ticker empty')
  return { symbol, price, source: 'binance', ts: Date.now() }
}

async function tickerBybit(symbol) {
  const url = new URL('https://api.bybit.com/v5/market/tickers')
  url.searchParams.set('category', 'linear')
  url.searchParams.set('symbol', symbol)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Bybit ticker HTTP ${res.status}`)
  const body = await res.json()
  const row = body?.result?.list?.[0]
  const price = Number(row?.lastPrice ?? row?.markPrice)
  if (!Number.isFinite(price)) throw new Error(`Bybit ticker: ${body.retMsg || 'empty'}`)
  return { symbol, price, source: 'bybit', ts: Date.now() }
}

/** Latest mark/last price for live chart ticks. */
export async function fetchTicker(symbol) {
  try {
    return await tickerBinance(symbol)
  } catch (binanceErr) {
    try {
      return await tickerBybit(symbol)
    } catch (bybitErr) {
      throw new Error(`${binanceErr.message}; fallback ${bybitErr.message}`)
    }
  }
}

/** Batch last prices for watchlist (one Binance all-ticker call, Bybit per-symbol fallback). */
export async function fetchTickers(symbols) {
  const want = [...new Set((symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean))]
  if (!want.length) return []
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price')
    if (!res.ok) throw new Error(`Binance tickers HTTP ${res.status}`)
    const rows = await res.json()
    const map = new Map(rows.map((r) => [r.symbol, Number(r.price)]))
    const ts = Date.now()
    const out = []
    for (const symbol of want) {
      const price = map.get(symbol)
      if (Number.isFinite(price)) out.push({ symbol, price, source: 'binance', ts })
    }
    if (out.length) return out
    throw new Error('Binance tickers empty for requested symbols')
  } catch (binanceErr) {
    const settled = await Promise.allSettled(want.map((s) => tickerBybit(s)))
    const out = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    if (!out.length) throw new Error(`${binanceErr.message}; Bybit batch empty`)
    return out
  }
}

function concatBars(chunks) {
  const out = { time: [], open: [], high: [], low: [], close: [], volume: [], source: null }
  const seen = new Set()
  for (const bars of chunks) {
    if (!out.source && bars.source) out.source = bars.source
    for (let i = 0; i < bars.time.length; i++) {
      const t = bars.time[i]
      if (seen.has(t)) continue
      seen.add(t)
      out.time.push(t)
      out.open.push(bars.open[i])
      out.high.push(bars.high[i])
      out.low.push(bars.low[i])
      out.close.push(bars.close[i])
      out.volume.push(bars.volume[i])
    }
  }
  return out
}

/**
 * Historical window (paginated). Times are unix ms.
 * @param {{ padWarmup?: boolean, maxBars?: number }} [opts]
 */
export async function fetchKlinesRange(symbol, interval, startTime, endTime, opts = {}) {
  if (!isSupportedTimeframe(interval)) throw new Error(`Unsupported interval: ${interval}`)
  const barMs = INTERVAL_MS[interval]
  const from = Number(startTime)
  const to = Number(endTime)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    throw new Error('from/to must be valid ms timestamps with to >= from')
  }
  const padWarmup = opts.padWarmup !== false
  const maxBars = opts.maxBars ?? MAX_ON_DEMAND_BARS
  // 220 bars before covers SMA(200) / EMA(50) / Donchian(20) warmup
  const padBefore = padWarmup ? 220 * barMs : 0
  const padAfter = padWarmup ? 20 * barMs : 0
  let start = from - padBefore
  const end = to + padAfter

  // Prefer most recent history when over maxBars
  const spanBars = Math.ceil((end - start) / barMs) + 2
  let truncated = false
  if (spanBars > maxBars) {
    start = end - maxBars * barMs
    truncated = true
  }

  const chunks = []
  let cursor = start
  let guard = 0
  while (cursor < end && guard < 40) {
    guard += 1
    const batch = await fetchWithFallback(symbol, interval, {
      startTime: cursor,
      endTime: end,
      limit: 1500,
    })
    if (!batch.time.length) break
    chunks.push(batch)
    const last = batch.time[batch.time.length - 1]
    const next = last + barMs
    if (next <= cursor) break
    cursor = next
    if (batch.time.length < 1500) break
  }

  const bars = concatBars(chunks)
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
    entryFrom: from,
    entryTo: to,
    truncated,
    candles,
    bars,
  }
}

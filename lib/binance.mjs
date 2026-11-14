/** Public kline fetch with Binance primary + Bybit fallback (Vercel US often gets Binance HTTP 451). */

const INTERVAL_TO_BYBIT = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
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

async function fetchBinance(symbol, interval, limit) {
  const url = new URL('https://fapi.binance.com/fapi/v1/klines')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('interval', interval)
  url.searchParams.set('limit', String(limit))
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Binance klines ${symbol} ${interval}: HTTP ${res.status}`)
  }
  return normalizeBars(await res.json())
}

async function fetchBybit(symbol, interval, limit) {
  const bybitInterval = INTERVAL_TO_BYBIT[interval]
  if (!bybitInterval) {
    throw new Error(`Unsupported interval for Bybit fallback: ${interval}`)
  }
  const url = new URL('https://api.bybit.com/v5/market/kline')
  url.searchParams.set('category', 'linear')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('interval', bybitInterval)
  url.searchParams.set('limit', String(limit))
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

export async function fetchKlines(symbol, interval = '1h', limit = 120) {
  try {
    return await fetchBinance(symbol, interval, limit)
  } catch (binanceErr) {
    try {
      const bars = await fetchBybit(symbol, interval, limit)
      bars.source = 'bybit'
      return bars
    } catch (bybitErr) {
      throw new Error(`${binanceErr.message}; fallback ${bybitErr.message}`)
    }
  }
}

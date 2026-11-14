/** Public Binance USD-M kline fetch (no API key). */

export async function fetchKlines(symbol, interval = '1h', limit = 120) {
  const url = new URL('https://fapi.binance.com/fapi/v1/klines')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('interval', interval)
  url.searchParams.set('limit', String(limit))
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Binance klines ${symbol} ${interval}: HTTP ${res.status}`)
  }
  const raw = await res.json()
  return {
    time: raw.map((r) => Number(r[0])),
    open: raw.map((r) => Number(r[1])),
    high: raw.map((r) => Number(r[2])),
    low: raw.map((r) => Number(r[3])),
    close: raw.map((r) => Number(r[4])),
    volume: raw.map((r) => Number(r[5])),
  }
}

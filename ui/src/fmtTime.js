import { tradingViewInterval } from './timeframes'

export function fmtTime(isoOrMs) {
  if (isoOrMs == null || isoOrMs === '') return '—'
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs)
  if (!Number.isFinite(ms)) return String(isoOrMs)
  const d = new Date(ms)
  const datePart = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d)
  const timePart = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(d)
    .replace(/\s/g, '')
    .replace(':', '.')
    .toLowerCase()
  return `${datePart}, ${timePart} IST`
}

export function tradingViewUrl(symbol, timeframe) {
  const params = new URLSearchParams({
    symbol: `BINANCE:${symbol}.P`,
    interval: tradingViewInterval(timeframe),
  })
  return `https://www.tradingview.com/chart/?${params}`
}

export function toMs(isoOrMs) {
  if (typeof isoOrMs === 'number') return isoOrMs
  return Date.parse(isoOrMs)
}

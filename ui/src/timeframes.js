/** Browser copy of shared timeframe helpers (keep in sync with lib/timeframes.mjs). */

export const SUPPORTED_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d']

export const INTERVAL_MS = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

export function barMsFor(timeframe) {
  const ms = INTERVAL_MS[timeframe]
  if (!ms) throw new Error(`Unsupported timeframe: ${timeframe}`)
  return ms
}

export function tradingViewInterval(timeframe) {
  const map = {
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
  return map[timeframe] || '60'
}

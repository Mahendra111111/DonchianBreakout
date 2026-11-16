/** Common names → Binance USDT-M perpetual tickers. */

export const SYMBOL_ALIASES = {
  GOLD: 'XAUTUSDT',
  XAU: 'XAUTUSDT',
  XAUUSD: 'XAUTUSDT',
  XAUUSDT: 'XAUTUSDT',
  PAXG: 'PAXGUSDT',
  SILVER: 'XAGUSDT',
  XAG: 'XAGUSDT',
  XAGUSD: 'XAGUSDT',
  PEPE: '1000PEPEUSDT',
  SHIB: '1000SHIBUSDT',
  FLOKI: '1000FLOKIUSDT',
  BONK: '1000BONKUSDT',
}

export function normalizeSymbol(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!s) return ''
  if (SYMBOL_ALIASES[s]) return SYMBOL_ALIASES[s]
  if (!s.endsWith('USDT')) s = `${s}USDT`
  const base = s.replace(/USDT$/, '')
  if (SYMBOL_ALIASES[base]) return SYMBOL_ALIASES[base]
  return s
}

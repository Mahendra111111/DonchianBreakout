/** Map common names → Binance USDT-M perpetuals; validate before chart/watchlist add. */

export const SYMBOL_ALIASES = {
  GOLD: 'XAUTUSDT',
  XAU: 'XAUTUSDT',
  XAUUSD: 'XAUTUSDT',
  XAUUSDT: 'XAUTUSDT',
  PAXG: 'PAXGUSDT',
  SILVER: 'XAGUSDT',
  XAG: 'XAGUSDT',
  XAGUSD: 'XAGUSDT',
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  ADA: 'ADAUSDT',
  DOGE: 'DOGEUSDT',
  BNB: 'BNBUSDT',
  XRP: 'XRPUSDT',
  LINK: 'LINKUSDT',
  AVAX: 'AVAXUSDT',
  PEPE: '1000PEPEUSDT',
  SHIB: '1000SHIBUSDT',
  FLOKI: '1000FLOKIUSDT',
  BONK: '1000BONKUSDT',
}

export function normalizeSymbolInput(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!s) return ''
  if (SYMBOL_ALIASES[s]) return SYMBOL_ALIASES[s]
  if (!s.endsWith('USDT')) s = `${s}USDT`
  if (SYMBOL_ALIASES[s.replace(/USDT$/, '')]) return SYMBOL_ALIASES[s.replace(/USDT$/, '')]
  return s
}

/** Confirm symbol trades on Binance USDT-M (or suggest closest). */
export async function resolveTradableSymbol(raw) {
  const wanted = normalizeSymbolInput(raw)
  if (!wanted) return { ok: false, error: 'Empty symbol' }
  const aliasedFrom = SYMBOL_ALIASES[String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')]

  const tryQuery = async (q) => {
    const res = await fetch(`/api/symbols?q=${encodeURIComponent(q)}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Symbol lookup failed')
    return (data.symbols || []).map((x) => x.symbol || x)
  }

  try {
    const q = wanted.replace(/USDT$/, '')
    let list = await tryQuery(q)
    if (list.includes(wanted)) {
      return { ok: true, symbol: wanted, aliased: Boolean(aliasedFrom && aliasedFrom === wanted) }
    }
    // Gold: try PAXG if XAUT missing on this venue
    if (wanted === 'XAUTUSDT') {
      const paxg = await tryQuery('PAXG')
      if (paxg.includes('PAXGUSDT')) {
        return { ok: true, symbol: 'PAXGUSDT', aliased: true }
      }
      list = [...list, ...paxg]
    }
    const exact = list.find((s) => s === wanted || s === `${q}USDT` || s.startsWith(q))
    if (exact) return { ok: true, symbol: exact, aliased: exact !== wanted }
    if (list[0]) {
      return {
        ok: false,
        error: `${wanted} not on Binance USDT-M. Try ${list.slice(0, 3).join(', ')}`,
        suggestions: list.slice(0, 5),
      }
    }
    return {
      ok: false,
      error: `${wanted} is not a Binance USDT-M perpetual. Gold → XAUT/PAXG; FX like AUD usually unavailable. Meme coins need the listed ticker (e.g. 1000PEPE).`,
    }
  } catch (e) {
    return { ok: false, error: e.message || 'Symbol lookup failed' }
  }
}

/** Searchable Binance USDT-M symbols (crypto + metal/forex perps Binance lists). */

import { SYMBOL_ALIASES, normalizeSymbol } from '../lib/symbolAliases.mjs'

let cache = { at: 0, symbols: [] }
const TTL = 60 * 60_000

async function loadExchangeSymbols() {
  if (cache.symbols.length && Date.now() - cache.at < TTL) return cache.symbols
  const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo')
  if (!res.ok) throw new Error(`Binance exchangeInfo HTTP ${res.status}`)
  const body = await res.json()
  const symbols = (body.symbols || [])
    .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map((s) => ({
      symbol: s.symbol,
      base: s.baseAsset,
      quote: s.quoteAsset,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
  cache = { at: Date.now(), symbols }
  return symbols
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=300')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }
  try {
    const raw = String(req.query?.q || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const aliased = SYMBOL_ALIASES[raw] || normalizeSymbol(raw)
    const q = raw
    const all = await loadExchangeSymbols()
    let rows = all
    if (q) {
      const prefer = aliased && aliased !== `${q}USDT` ? aliased : ''
      rows = all.filter(
        (s) =>
          s.symbol.includes(q)
          || s.base.includes(q)
          || s.symbol.replace('USDT', '').includes(q)
          || (prefer && s.symbol === prefer),
      )
      if (prefer) {
        rows = [
          ...rows.filter((s) => s.symbol === prefer),
          ...rows.filter((s) => s.symbol !== prefer),
        ]
      }
    }
    res.status(200).json({
      count: rows.length,
      symbols: rows.slice(0, q ? 40 : 80),
      alias: aliased && aliased !== `${q}USDT` ? aliased : undefined,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
}

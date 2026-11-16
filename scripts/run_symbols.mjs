/** CLI wrapper for /api/symbols locally. */
const q = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=')
    return i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a, '1']
  }),
).q || ''

try {
  const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo')
  if (!res.ok) throw new Error(`Binance exchangeInfo HTTP ${res.status}`)
  const body = await res.json()
  const raw = String(q).toUpperCase().replace(/[^A-Z0-9]/g, '')
  let rows = (body.symbols || [])
    .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map((s) => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
  if (raw) {
    rows = rows.filter(
      (s) => s.symbol.includes(raw) || s.base.includes(raw) || s.symbol.replace('USDT', '').includes(raw),
    )
  }
  process.stdout.write(JSON.stringify({
    count: rows.length,
    symbols: rows.slice(0, raw ? 40 : 80),
  }))
} catch (e) {
  console.error(String(e.message || e))
  process.exit(1)
}

import { fetchTicker } from '../lib/binance.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=')
    return i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a, '1']
  }),
)

try {
  const data = await fetchTicker((args.symbol || 'SOLUSDT').toUpperCase())
  process.stdout.write(JSON.stringify(data))
} catch (e) {
  console.error(String(e.message || e))
  process.exit(1)
}

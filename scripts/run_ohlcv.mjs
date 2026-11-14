import { fetchKlinesRange } from '../lib/binance.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=')
    return i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a, '1']
  }),
)

const symbol = (args.symbol || 'SOLUSDT').toUpperCase()
const timeframe = args.timeframe || '1h'
const from = Number(args.from)
const to = Number(args.to)

try {
  const data = await fetchKlinesRange(symbol, timeframe, from, to)
  process.stdout.write(JSON.stringify(data))
} catch (e) {
  console.error(String(e.message || e))
  process.exit(1)
}

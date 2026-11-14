import { fetchKlinesRange } from '../lib/binance.mjs'

function parseTime(v) {
  if (v == null || v === '') return NaN
  const n = Number(v)
  if (Number.isFinite(n)) return n
  const ms = Date.parse(String(v))
  return Number.isFinite(ms) ? ms : NaN
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }

  const symbol = String(req.query?.symbol || 'SOLUSDT').toUpperCase()
  const timeframe = String(req.query?.timeframe || '1h')
  const from = parseTime(req.query?.from)
  const to = parseTime(req.query?.to)

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    res.status(400).json({ error: 'from and to are required (ms or ISO)' })
    return
  }

  try {
    const data = await fetchKlinesRange(symbol, timeframe, from, to)
    res.status(200).json(data)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
}

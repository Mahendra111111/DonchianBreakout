import { fetchTicker } from '../lib/binance.mjs'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }
  const symbol = String(req.query?.symbol || 'SOLUSDT').toUpperCase()
  try {
    const data = await fetchTicker(symbol)
    res.status(200).json(data)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
}

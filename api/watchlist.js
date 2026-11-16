import { readWatchlist, writeWatchlist } from '../lib/watchlistStore.mjs'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  try {
    if (req.method === 'GET') {
      const symbols = await readWatchlist()
      res.status(200).json({ symbols })
      return
    }
    if (req.method === 'POST') {
      let body = req.body
      if (typeof body === 'string') {
        try { body = JSON.parse(body) } catch { body = {} }
      }
      if (!body || typeof body !== 'object') body = {}
      // Vercel may leave body unset — parse raw if needed
      if (!body.symbols && req.body == null) {
        body = {}
      }
      const symbols = await writeWatchlist(body.symbols || [])
      res.status(200).json({ ok: true, symbols })
      return
    }
    res.status(405).json({ error: 'method not allowed' })
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) })
  }
}

import { runSignalScan } from '../lib/scan.mjs'

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
  try {
    // Read-only scan: no Telegram spam from the UI poller
    const result = await runSignalScan({ notify: false })
    res.status(200).json(result)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
}

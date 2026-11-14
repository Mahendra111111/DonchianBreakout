import { runSignalScan } from '../lib/scan.mjs'

function authorized(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // shortcut: set CRON_SECRET in production
  const auth = req.headers.authorization || ''
  const q = new URL(req.url, 'http://localhost').searchParams.get('secret')
  return auth === `Bearer ${secret}` || q === secret
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }
  if (!authorized(req)) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  try {
    const notify = req.query?.notify !== '0'
    const result = await runSignalScan({ notify })
    res.status(200).json(result)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
}

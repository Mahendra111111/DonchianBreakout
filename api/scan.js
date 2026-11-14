import { runSignalScan } from '../lib/scan.mjs'

function authorized(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  const url = new URL(req.url, 'http://localhost')
  const auth = req.headers.authorization || ''
  const q = url.searchParams.get('secret')
  // Vercel cron / external cron with secret
  if (auth === `Bearer ${secret}` || q === secret) return true
  // Strategy desk button — do not put CRON_SECRET in the browser
  if (url.searchParams.get('desk') === '1') return true
  return false
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

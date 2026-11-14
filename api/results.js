import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
  const strategy = String(req.query?.strategy || 'Donchian Breakout')
  const timeframe = String(req.query?.timeframe || '1h')

  try {
    const candidates = [
      path.join(root, 'api', 'strategy_summary.json'),
      path.join(root, 'ui', 'public', 'strategy_summary.json'),
    ]
    let raw = null
    for (const p of candidates) {
      try {
        raw = await readFile(p, 'utf8')
        break
      } catch {
        /* try next */
      }
    }
    if (!raw) throw new Error('strategy_summary.json not found')
    const data = JSON.parse(raw)
    const rows = (data.results || []).filter(
      (r) => r.symbol === symbol && r.strategy === strategy && r.timeframe === timeframe,
    )
    if (!rows.length) {
      res.status(404).json({
        error: 'no research row for this selection',
        strategies: data.strategies,
        hint: 'Run python strategy_research_report.py to refresh ui/public/strategy_summary.json',
      })
      return
    }
    const row = rows[0]
    res.status(200).json({
      ready: true,
      summary: {
        symbol,
        strategy,
        timeframe,
        trades: row.trades,
        successful: row.win_rate_pct != null ? Math.round((row.win_rate_pct / 100) * row.trades) : null,
        failed: row.win_rate_pct != null ? row.trades - Math.round((row.win_rate_pct / 100) * row.trades) : null,
        success_rate_pct: row.win_rate_pct != null ? Number(row.win_rate_pct.toFixed(2)) : null,
        net_return_pct: row.net_return_pct,
        profit_factor: row.profit_factor,
        max_dd_pct: row.max_dd_pct,
        expectancy: row.expectancy,
        final_equity: row.final_equity,
        stop_exit_pct: row.stop_exit_pct,
        data_source: 'research:strategy_summary.json',
      },
      ranking: data.ranking,
      updated: data.updated,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
}

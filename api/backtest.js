import { runOnDemandBacktest } from '../lib/backtest.mjs'
import { STRATEGIES as STRATEGY_LIST } from '../lib/strategies.mjs'
import { SUPPORTED_TIMEFRAMES } from '../lib/timeframes.mjs'

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

  const symbol = String(req.query?.symbol || 'BTCUSDT').toUpperCase()
  const strategy = String(req.query?.strategy || 'Donchian Breakout')
  const timeframe = String(req.query?.timeframe || '1h')
  const period = String(req.query?.period || '5y')

  try {
    const result = await runOnDemandBacktest({ symbol, strategy, timeframe, period })
    res.status(200).json({
      ...result,
      strategies: STRATEGY_LIST,
      timeframes: SUPPORTED_TIMEFRAMES,
    })
  } catch (e) {
    res.status(400).json({
      error: String(e.message || e),
      strategies: STRATEGY_LIST,
      timeframes: SUPPORTED_TIMEFRAMES,
    })
  }
}

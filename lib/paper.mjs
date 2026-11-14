/** Live paper trades from OHLCV + strategy signals (research rules, no exchange orders). */

import { signalsFor } from './strategies.mjs'

const FEE = 0.0005
const SLIP = 0.0002
const RISK_PCT = 0.005
const INITIAL = 10000
const STOP_ATR = 1.5

const RR = {
  'EMA Trend Following': 1.5,
  'Donchian Breakout': 1.5,
  'Hammer SMA VWAP': 2.0,
}

function atr(bars, n = 14) {
  const trs = new Array(bars.close.length)
  for (let i = 0; i < bars.close.length; i++) {
    if (i === 0) {
      trs[i] = bars.high[i] - bars.low[i]
      continue
    }
    const pc = bars.close[i - 1]
    trs[i] = Math.max(
      bars.high[i] - bars.low[i],
      Math.abs(bars.high[i] - pc),
      Math.abs(bars.low[i] - pc),
    )
  }
  const out = new Array(trs.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < trs.length; i++) {
    if (i < n) {
      sum += trs[i]
      if (i === n - 1) out[i] = sum / n
      continue
    }
    out[i] = (out[i - 1] * (n - 1) + trs[i]) / n
  }
  return out
}

/**
 * One-position paper sim on closed bars (exclude forming candle).
 * Entry next open after signal; ATR stop + RR target; optional opposite signal exit.
 */
export function runPaperTrades(bars, strategy) {
  const n = bars.close.length
  if (n < 220) {
    return { trades: [], open: null, equity: INITIAL }
  }
  const closedEnd = n >= 2 ? n - 2 : n - 1
  const { longEntry, shortEntry } = signalsFor(strategy, bars)
  // Opposite signal exits (matches research Donchian/Hammer wiring)
  const longExit = shortEntry
  const shortExit = longEntry
  const a = atr(bars)
  const rr = RR[strategy] ?? 1.5

  let equity = INITIAL
  const trades = []
  let pos = null

  for (let i = 1; i <= closedEnd; i++) {
    const atrI = a[i]
    if (pos) {
      const hi = bars.high[i]
      const lo = bars.low[i]
      let exitPrice = null
      let reason = null
      const stopHit = pos.side === 1 ? lo <= pos.stop : hi >= pos.stop
      const tpHit = pos.side === 1 ? hi >= pos.target : lo <= pos.target
      const sigExit = pos.side === 1 ? longExit[i] : shortExit[i]
      if (stopHit) {
        exitPrice = pos.stop
        reason = 'stop'
      } else if (tpHit) {
        exitPrice = pos.target
        reason = 'target'
      } else if (sigExit) {
        exitPrice = bars.open[i]
        reason = 'signal'
      }
      if (exitPrice != null) {
        exitPrice *= pos.side === 1 ? 1 - SLIP : 1 + SLIP
        const gross = pos.side * (exitPrice - pos.entry) * pos.qty
        const fees = FEE * (pos.entry * pos.qty + exitPrice * pos.qty)
        const net = gross - fees
        equity += gross - FEE * exitPrice * pos.qty
        trades.push({
          entry_time: new Date(bars.time[pos.i]).toISOString(),
          exit_time: new Date(bars.time[i]).toISOString(),
          side: pos.side === 1 ? 'LONG' : 'SHORT',
          entry: pos.entry,
          exit: exitPrice,
          stop: pos.stop,
          target: pos.target,
          net,
          reason,
          outcome: net > 0 ? 'successful' : 'failed',
          live: true,
        })
        pos = null
      }
    }

    if (pos == null && Number.isFinite(atrI) && atrI > 0) {
      const side = longEntry[i - 1] ? 1 : shortEntry[i - 1] ? -1 : 0
      if (side) {
        const entry = bars.open[i] * (side === 1 ? 1 + SLIP : 1 - SLIP)
        const stop = entry - side * STOP_ATR * atrI
        const dist = Math.abs(entry - stop)
        if (dist > 0) {
          const qty = Math.min((equity * RISK_PCT) / dist, equity / entry)
          if (qty > 0) {
            const target = entry + side * rr * dist
            equity -= FEE * entry * qty
            pos = { side, entry, stop, target, qty, i }
          }
        }
      }
    }
  }

  let open = null
  if (pos) {
    const last = closedEnd
    const mark = bars.close[last]
    const unreal = pos.side * (mark - pos.entry) * pos.qty
    open = {
      side: pos.side === 1 ? 'LONG' : 'SHORT',
      entry: pos.entry,
      stop: pos.stop,
      target: pos.target,
      entry_time: new Date(bars.time[pos.i]).toISOString(),
      mark,
      unrealized: unreal,
      bars_held: last - pos.i,
    }
  }

  return { trades, open, equity, rr, stop_atr: STOP_ATR }
}

export function barsToCandles(bars) {
  return bars.time.map((t, i) => ({
    time: Math.floor(Number(t) / 1000),
    open: bars.open[i],
    high: bars.high[i],
    low: bars.low[i],
    close: bars.close[i],
    volume: bars.volume?.[i] ?? 0,
  }))
}

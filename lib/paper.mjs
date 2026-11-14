/** Live paper trades from OHLCV + strategy signals (research rules, no exchange orders). */

import { signalsFor } from './strategies.mjs'

const FEE = 0.0005
const SLIP = 0.0002
const RISK_PCT = 0.005
const INITIAL = 10000
const STOP_ATR = 1.5
const FUNDING_8H = {
  'VWAP Rejection V1': 0.0001,
}

const RR = {
  'EMA Trend Following': 1.5,
  'Donchian Breakout': 1.5,
  'Hammer SMA VWAP': 2.0,
  'VWAP Rejection V1': 2.0,
}

const STOP_MODE = {
  'EMA Trend Following': 'atr',
  'Donchian Breakout': 'atr',
  'Hammer SMA VWAP': 'atr',
  'VWAP Rejection V1': 'signal_extreme',
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

function fundingCost(side, qty, entry, entryI, exitI, times, rate8h) {
  if (!rate8h || exitI <= entryI) return 0
  const hours = Math.max((times[exitI] - times[entryI]) / 3600000, 0)
  const periods = hours / 8
  const signed = rate8h * periods * Math.abs(entry * qty)
  return side === 1 ? signed : -signed
}

/**
 * One-position paper sim on closed bars (exclude forming candle).
 * Entry next open after signal; ATR or rejection-extreme stop + RR target.
 */
export function runPaperTrades(bars, strategy) {
  const n = bars.close.length
  if (n < 30) {
    return { trades: [], open: null, equity: INITIAL }
  }
  const closedEnd = n >= 2 ? n - 2 : n - 1
  const { longEntry, shortEntry } = signalsFor(strategy, bars)
  const stopMode = STOP_MODE[strategy] ?? 'atr'
  // Opposite signal exits (matches research Donchian/Hammer wiring); VWAP uses SL/TP only
  const longExit = stopMode === 'signal_extreme' ? null : shortEntry
  const shortExit = stopMode === 'signal_extreme' ? null : longEntry
  const a = atr(bars)
  const rr = RR[strategy] ?? 1.5
  const rate8h = FUNDING_8H[strategy] ?? 0

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
      const sigExit =
        pos.side === 1
          ? longExit != null && longExit[i]
          : shortExit != null && shortExit[i]
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
        const raw = exitPrice
        exitPrice *= pos.side === 1 ? 1 - SLIP : 1 + SLIP
        const entryFee = FEE * pos.entry * pos.qty
        const exitFee = FEE * exitPrice * pos.qty
        const fund = fundingCost(pos.side, pos.qty, pos.entry, pos.i, i, bars.time, rate8h)
        const gross = pos.side * (exitPrice - pos.entry) * pos.qty
        const net = gross - entryFee - exitFee - fund
        equity += gross - exitFee - fund
        trades.push({
          entry_time: new Date(bars.time[pos.i]).toISOString(),
          exit_time: new Date(bars.time[i]).toISOString(),
          signal_timestamp: new Date(bars.time[pos.signalI]).toISOString(),
          side: pos.side === 1 ? 'LONG' : 'SHORT',
          entry: pos.entry,
          exit: exitPrice,
          stop: pos.stop,
          target: pos.target,
          stop_loss: pos.stop,
          take_profit: pos.target,
          gross_pnl: gross,
          entry_fee: entryFee,
          exit_fee: exitFee,
          slippage_cost: Math.abs(exitPrice - raw) * pos.qty,
          funding_cost: fund,
          net,
          reason,
          exit_reason: reason === 'stop' ? 'STOP_LOSS' : reason === 'target' ? 'TAKE_PROFIT' : 'SIGNAL',
          trade_status: 'CLOSED',
          outcome: net > 0 ? 'successful' : 'failed',
          live: true,
        })
        pos = null
      }
    }

    if (pos == null) {
      const side = longEntry[i - 1] ? 1 : shortEntry[i - 1] ? -1 : 0
      if (!side) continue
      const signalI = i - 1
      const rawOpen = bars.open[i]
      const entry = rawOpen * (side === 1 ? 1 + SLIP : 1 - SLIP)
      let stop
      if (stopMode === 'signal_extreme') {
        stop = side === 1 ? bars.low[signalI] : bars.high[signalI]
        if (side === 1 && rawOpen <= stop) continue
        if (side === -1 && rawOpen >= stop) continue
      } else {
        if (!(Number.isFinite(atrI) && atrI > 0)) continue
        stop = entry - side * STOP_ATR * atrI
      }
      const dist = Math.abs(entry - stop)
      if (!(dist > 0) || entry === stop) continue
      const qty = Math.min((equity * RISK_PCT) / dist, equity / entry)
      if (!(qty > 0)) continue
      const target = entry + side * rr * dist
      equity -= FEE * entry * qty
      pos = { side, entry, stop, target, qty, i, signalI }
      // Entry at open — same bar OHLC can still hit SL/TP (SL first)
      const hi = bars.high[i]
      const lo = bars.low[i]
      const stopHit = pos.side === 1 ? lo <= pos.stop : hi >= pos.stop
      const tpHit = pos.side === 1 ? hi >= pos.target : lo <= pos.target
      if (stopHit || tpHit) {
        const raw = stopHit ? pos.stop : pos.target
        const reason = stopHit ? 'stop' : 'target'
        let exitPrice = raw * (pos.side === 1 ? 1 - SLIP : 1 + SLIP)
        const entryFee = FEE * pos.entry * pos.qty
        const exitFee = FEE * exitPrice * pos.qty
        const fund = fundingCost(pos.side, pos.qty, pos.entry, pos.i, i, bars.time, rate8h)
        const gross = pos.side * (exitPrice - pos.entry) * pos.qty
        const net = gross - entryFee - exitFee - fund
        equity += gross - exitFee - fund
        trades.push({
          entry_time: new Date(bars.time[pos.i]).toISOString(),
          exit_time: new Date(bars.time[i]).toISOString(),
          signal_timestamp: new Date(bars.time[pos.signalI]).toISOString(),
          side: pos.side === 1 ? 'LONG' : 'SHORT',
          entry: pos.entry,
          exit: exitPrice,
          stop: pos.stop,
          target: pos.target,
          stop_loss: pos.stop,
          take_profit: pos.target,
          gross_pnl: gross,
          entry_fee: entryFee,
          exit_fee: exitFee,
          slippage_cost: Math.abs(exitPrice - raw) * pos.qty,
          funding_cost: fund,
          net,
          reason,
          exit_reason: stopHit ? 'STOP_LOSS' : 'TAKE_PROFIT',
          trade_status: 'CLOSED',
          outcome: net > 0 ? 'successful' : 'failed',
          live: true,
        })
        pos = null
      }
    }
  }

  let open = null
  if (pos) {
    const last = closedEnd
    const mark = bars.close[last]
    const fund = fundingCost(pos.side, pos.qty, pos.entry, pos.i, last, bars.time, rate8h)
    const unreal = pos.side * (mark - pos.entry) * pos.qty - fund
    open = {
      side: pos.side === 1 ? 'LONG' : 'SHORT',
      entry: pos.entry,
      stop: pos.stop,
      target: pos.target,
      entry_time: new Date(bars.time[pos.i]).toISOString(),
      mark,
      unrealized: unreal,
      funding_cost: fund,
      trade_status: 'OPEN',
      exit_reason: 'END_OF_DATA',
      bars_held: last - pos.i,
    }
  }

  return {
    trades,
    open,
    equity,
    rr,
    stop_atr: stopMode === 'atr' ? STOP_ATR : null,
    stop_mode: stopMode,
  }
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

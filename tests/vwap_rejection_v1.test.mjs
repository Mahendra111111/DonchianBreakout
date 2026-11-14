import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionVwap, vwapRejectionSignals } from '../lib/strategies.mjs'

function makeBars(n = 25) {
  const time = []
  const open = []
  const high = []
  const low = []
  const close = []
  const volume = []
  const start = Date.UTC(2024, 0, 1, 0, 0, 0)
  for (let i = 0; i < n; i++) {
    time.push(start + i * 3600000)
    open.push(100)
    high.push(101)
    low.push(99)
    close.push(100.5)
    volume.push(10 + i)
  }
  return { time, open, high, low, close, volume }
}

test('session VWAP resets at UTC day', () => {
  const bars = makeBars(3)
  bars.time[2] = Date.UTC(2024, 0, 2, 1, 0, 0)
  bars.open[2] = bars.close[2] = 200
  bars.high[2] = 210
  bars.low[2] = 190
  bars.volume[2] = 10
  const v = sessionVwap(bars)
  const tp0 = (101 + 99 + 100.5) / 3
  assert.ok(Math.abs(v[0] - tp0) < 1e-9)
  const tp2 = (210 + 190 + 200) / 3
  assert.ok(Math.abs(v[2] - tp2) < 1e-9)
})

test('vwapRejectionSignals long on bullish rejection + volume', () => {
  const bars = makeBars(25)
  const i = 24
  bars.time[i] = Date.UTC(2024, 0, 2, 0, 0, 0)
  bars.open[i] = 100
  bars.high[i] = 101.5
  bars.low[i] = 96
  bars.close[i] = 101
  bars.volume[i] = 200
  const { longEntry, shortEntry } = vwapRejectionSignals(bars)
  assert.equal(longEntry[i], true)
  assert.equal(shortEntry[i], false)
})

test('equal volume rejects signal', () => {
  const bars = makeBars(25)
  const i = 24
  bars.time[i] = Date.UTC(2024, 0, 2, 0, 0, 0)
  bars.open[i] = 100
  bars.high[i] = 101.5
  bars.low[i] = 96
  bars.close[i] = 101
  bars.volume[i] = 33
  bars.volume[i - 1] = 33
  bars.volume[i - 2] = 32
  const { longEntry } = vwapRejectionSignals(bars)
  assert.equal(longEntry[i], false)
})

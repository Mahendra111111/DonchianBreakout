import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
} from 'lightweight-charts'
import { fmtTime } from './fmtTime'
import { strategyOverlays } from './strategyIndicators'

const POLL_MS = 60_000

function barTimeSec(isoOrMs, timeframe) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs)
  const barMs = timeframe === '15m' ? 15 * 60_000 : 60 * 60_000
  return Math.floor(ms / barMs) * (barMs / 1000)
}

export default function LiveDesk({ symbol, timeframe, strategy, onSelectTrade }) {
  const hostRef = useRef(null)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const knownClosed = useRef(new Set())
  const [freshNote, setFreshNote] = useState('')

  async function load() {
    setBusy(true)
    try {
      const qs = new URLSearchParams({ symbol, timeframe, strategy })
      const res = await fetch(`/api/live?${qs}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Live ${res.status}`)

      const prev = knownClosed.current
      const newly = []
      for (const t of body.trade_list || []) {
        const key = `${t.entry_time}|${t.exit_time}|${t.side}`
        if (!prev.has(key)) newly.push(t)
        prev.add(key)
      }
      if (newly.length) {
        setFreshNote(
          `Recorded ${newly.length} new paper trade(s) · latest exit ${fmtTime(newly.at(-1).exit_time)}`,
        )
      }

      setData(body)
      setError('')
    } catch (e) {
      setError(e.message || 'Live feed failed')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    knownClosed.current = new Set()
    setFreshNote('')
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [symbol, timeframe, strategy])

  useEffect(() => {
    if (!data?.candles?.length || !hostRef.current) return undefined
    let chart
    let resizeObs

    hostRef.current.replaceChildren()
    chart = createChart(hostRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#121916' },
        textColor: '#8fa297',
      },
      grid: {
        vertLines: { color: '#2a3830' },
        horzLines: { color: '#2a3830' },
      },
      rightPriceScale: { borderColor: '#2a3830' },
      timeScale: { borderColor: '#2a3830', timeVisible: true, secondsVisible: false },
      width: hostRef.current.clientWidth,
      height: hostRef.current.clientHeight || 420,
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#3dba7a',
      downColor: '#e35d5d',
      borderVisible: false,
      wickUpColor: '#3dba7a',
      wickDownColor: '#e35d5d',
    })
    const candles = data.candles.map(({ time, open, high, low, close }) => ({
      time, open, high, low, close,
    }))
    series.setData(candles)

    const overlays = strategyOverlays(strategy, data.candles)
    for (const line of overlays.lines) {
      if (!line.data.length) continue
      chart.addSeries(LineSeries, {
        color: line.color,
        lineWidth: 2,
        title: line.title,
        lastValueVisible: true,
        priceLineVisible: false,
      }).setData(line.data)
    }

    const markers = []
    for (const t of (data.trade_list || []).slice(-40)) {
      const long = t.side === 'LONG'
      const ok = t.outcome === 'successful'
      markers.push({
        time: barTimeSec(t.entry_time, timeframe),
        position: long ? 'belowBar' : 'aboveBar',
        color: long ? '#4aa3ff' : '#d4a017',
        shape: long ? 'arrowUp' : 'arrowDown',
        text: 'IN',
      })
      markers.push({
        time: barTimeSec(t.exit_time, timeframe),
        position: ok ? 'aboveBar' : 'belowBar',
        color: ok ? '#3dba7a' : '#e35d5d',
        shape: 'circle',
        text: t.reason,
      })
    }
    if (markers.length) createSeriesMarkers(series, markers)

    if (data.open) {
      series.createPriceLine({
        price: Number(data.open.entry),
        color: data.open.side === 'LONG' ? '#4aa3ff' : '#d4a017',
        lineWidth: 2,
        lineStyle: 0,
        title: `Open ${data.open.side}`,
      })
      series.createPriceLine({
        price: Number(data.open.stop),
        color: '#e35d5d',
        lineWidth: 1,
        lineStyle: 2,
        title: 'Stop',
      })
      series.createPriceLine({
        price: Number(data.open.target),
        color: '#3dba7a',
        lineWidth: 1,
        lineStyle: 2,
        title: 'Target',
      })
    }

    chart.timeScale().fitContent()
    resizeObs = new ResizeObserver(() => {
      if (!hostRef.current || !chart) return
      chart.applyOptions({
        width: hostRef.current.clientWidth,
        height: hostRef.current.clientHeight || 420,
      })
    })
    resizeObs.observe(hostRef.current)

    return () => {
      resizeObs?.disconnect()
      chart?.remove()
    }
  }, [data, strategy, timeframe])

  const trades = data?.trade_list || []
  const open = data?.open
  const summary = data?.summary

  return (
    <section className="live-desk table-wrap">
      <div className="table-head">
        <h2>
          Live paper desk
          <span>
            auto-refresh 60s · {data?.source || '…'}
            {data?.scannedAt ? ` · ${fmtTime(data.scannedAt)}` : ''}
            {busy ? ' · updating…' : ''}
          </span>
        </h2>
        <button type="button" className="scan-btn" disabled={busy} onClick={load}>
          Refresh live
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {freshNote && <div className="banner">{freshNote}</div>}
      <div className="banner">
        Paper only — fetches live candles, auto-records strategy entries/exits (stop / target / signal). No exchange orders.
      </div>

      {summary && (
        <div className="stats live-stats">
          <article>
            <span>Live window trades</span>
            <strong>{summary.trades}</strong>
          </article>
          <article>
            <span>Successful</span>
            <strong className="up">{summary.successful}</strong>
          </article>
          <article>
            <span>Failed</span>
            <strong className="down">{summary.failed}</strong>
          </article>
          <article>
            <span>Open position</span>
            <strong className={open ? 'up' : ''}>{open ? `${open.side} @ ${Number(open.entry).toFixed(4)}` : 'Flat'}</strong>
          </article>
          {open && (
            <article>
              <span>Unrealized</span>
              <strong className={open.unrealized >= 0 ? 'up' : 'down'}>{Number(open.unrealized).toFixed(2)}</strong>
            </article>
          )}
        </div>
      )}

      <div className="chart-host live-chart-host" ref={hostRef} />

      <div className="table-head">
        <h2>
          Live paper records
          <span>{trades.length} closed in feed window · click row for detail chart</span>
        </h2>
      </div>
      <div className="scroll live-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Side</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Net $</th>
              <th>Reason</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {[...trades].reverse().map((t, i) => {
              const ok = t.outcome === 'successful'
              return (
                <tr
                  key={`${t.entry_time}-${t.exit_time}-${i}`}
                  className={`${ok ? 'row-win' : 'row-loss'} trade-row`}
                  onClick={() => onSelectTrade?.(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelectTrade?.(t)
                    }
                  }}
                  tabIndex={0}
                  role="button"
                >
                  <td>{trades.length - i}</td>
                  <td><span className={`side ${t.side === 'LONG' ? 'long' : 'short'}`}>{t.side}</span></td>
                  <td>
                    <div className="stack">
                      <span>{Number(t.entry).toFixed(4)}</span>
                      <small>{fmtTime(t.entry_time)}</small>
                    </div>
                  </td>
                  <td>
                    <div className="stack">
                      <span>{Number(t.exit).toFixed(4)}</span>
                      <small>{fmtTime(t.exit_time)}</small>
                    </div>
                  </td>
                  <td className={t.net >= 0 ? 'up' : 'down'}>{Number(t.net).toFixed(2)}</td>
                  <td>{t.reason}</td>
                  <td><span className={`badge ${ok ? 'win' : 'loss'}`}>{ok ? 'Successful' : 'Failed'}</span></td>
                </tr>
              )
            })}
            {trades.length === 0 && (
              <tr><td colSpan={7} className="empty">No closed paper trades in the live window yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

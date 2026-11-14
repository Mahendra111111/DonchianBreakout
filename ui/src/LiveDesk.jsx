import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
} from 'lightweight-charts'
import { fmtTime } from './fmtTime'
import { subscribeLiveStream } from './liveSocket'
import { strategyOverlays } from './strategyIndicators'

const PAPER_POLL_MS = 60_000
const TICK_POLL_MS = 1_000

function barMsFor(timeframe) {
  return timeframe === '15m' ? 15 * 60_000 : 60 * 60_000
}

function barTimeSec(isoOrMs, timeframe) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs)
  const barMs = barMsFor(timeframe)
  return Math.floor(ms / barMs) * (barMs / 1000)
}

function barOpenSec(timeframe, nowMs = Date.now()) {
  const barMs = barMsFor(timeframe)
  return Math.floor(nowMs / barMs) * (barMs / 1000)
}

function candleCountdown(timeframe, nowMs = Date.now()) {
  const barMs = barMsFor(timeframe)
  const left = barMs - (nowMs % barMs)
  const totalSec = Math.floor(left / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function LiveDesk({ symbol, timeframe, strategy, onSelectTrade }) {
  const hostRef = useRef(null)
  const chartRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const overlaySeriesRef = useRef([])
  const markersApiRef = useRef(null)
  const priceLinesRef = useRef([])
  const lastPriceLineRef = useRef(null)
  const candlesRef = useRef([])
  const readyRef = useRef(false)
  const pendingTickRef = useRef(null)

  const [paper, setPaper] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [stream, setStream] = useState({ connected: false, source: null })
  const [tickSource, setTickSource] = useState(null)
  const [lastPrice, setLastPrice] = useState(null)
  const [tickAt, setTickAt] = useState(null)
  const [countdown, setCountdown] = useState(() => candleCountdown(timeframe))
  const knownClosed = useRef(new Set())
  const [freshNote, setFreshNote] = useState('')

  function clearPriceLines() {
    const series = candleSeriesRef.current
    if (!series) return
    for (const line of priceLinesRef.current) {
      try { series.removePriceLine(line) } catch { /* */ }
    }
    priceLinesRef.current = []
    if (lastPriceLineRef.current) {
      try { series.removePriceLine(lastPriceLineRef.current) } catch { /* */ }
      lastPriceLineRef.current = null
    }
  }

  function setLivePriceLine(price) {
    const series = candleSeriesRef.current
    if (!series || !Number.isFinite(price)) return
    if (lastPriceLineRef.current) {
      try { series.removePriceLine(lastPriceLineRef.current) } catch { /* */ }
    }
    lastPriceLineRef.current = series.createPriceLine({
      price,
      color: '#e35d5d',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: true,
      title: countdown,
    })
  }

  function applyOverlays(candles) {
    const chart = chartRef.current
    if (!chart) return
    for (const s of overlaySeriesRef.current) {
      try { chart.removeSeries(s) } catch { /* */ }
    }
    overlaySeriesRef.current = []
    const overlays = strategyOverlays(strategy, candles)
    for (const line of overlays.lines) {
      if (!line.data.length) continue
      const ls = chart.addSeries(LineSeries, {
        color: line.color,
        lineWidth: 2,
        title: line.title,
        lastValueVisible: true,
        priceLineVisible: false,
      })
      ls.setData(line.data)
      overlaySeriesRef.current.push(ls)
    }
  }

  function applyPaperMarkers(body) {
    const series = candleSeriesRef.current
    if (!series) return
    const savedLast = lastPrice
    clearPriceLines()
    if (markersApiRef.current) {
      try { markersApiRef.current.setMarkers([]) } catch { /* */ }
    }
    const markers = []
    for (const t of (body.trade_list || []).slice(-40)) {
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
    markersApiRef.current = createSeriesMarkers(series, markers)

    if (body.open) {
      priceLinesRef.current = [
        series.createPriceLine({
          price: Number(body.open.entry),
          color: body.open.side === 'LONG' ? '#4aa3ff' : '#d4a017',
          lineWidth: 2,
          lineStyle: 0,
          title: `Open ${body.open.side}`,
        }),
        series.createPriceLine({
          price: Number(body.open.stop),
          color: '#e35d5d',
          lineWidth: 1,
          lineStyle: 2,
          title: 'Stop',
        }),
        series.createPriceLine({
          price: Number(body.open.target),
          color: '#3dba7a',
          lineWidth: 1,
          lineStyle: 2,
          title: 'Target',
        }),
      ]
    }
    if (savedLast != null) setLivePriceLine(Number(savedLast))
  }

  function pushCandleUpdate(bar, volume) {
    const series = candleSeriesRef.current
    if (!series || !readyRef.current) return
    try {
      series.update(bar)
    } catch {
      return
    }
    setLastPrice(bar.close)
    setTickAt(Date.now())
    setLivePriceLine(bar.close)

    const list = candlesRef.current
    const last = list[list.length - 1]
    if (last && last.time === bar.time) {
      list[list.length - 1] = { ...bar, volume: volume ?? last.volume ?? 0 }
    } else if (!last || bar.time > last.time) {
      list.push({ ...bar, volume: volume ?? 0 })
      if (list.length > 600) list.shift()
    }
    chartRef.current?.timeScale().scrollToRealTime()
  }

  function applyTickPrice(price, source) {
    if (!Number.isFinite(price)) return
    if (!readyRef.current) {
      pendingTickRef.current = { price, source }
      setLastPrice(price)
      setTickAt(Date.now())
      if (source) setTickSource(source)
      return
    }
    const list = candlesRef.current
    let last = list[list.length - 1]
    if (!last) return

    const openT = barOpenSec(timeframe)
    if (openT > last.time) {
      last = {
        time: openT,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
      }
      list.push(last)
      if (list.length > 600) list.shift()
    } else {
      last = {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
      }
      list[list.length - 1] = last
    }

    if (source) setTickSource(source)
    pushCandleUpdate(
      { time: last.time, open: last.open, high: last.high, low: last.low, close: last.close },
      last.volume,
    )
  }

  async function loadPaper({ seedChart } = { seedChart: false }) {
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

      setPaper(body)
      setError('')

      const series = candleSeriesRef.current
      if (seedChart && series && body.candles?.length) {
        const candles = body.candles.map(({ time, open, high, low, close, volume }) => ({
          time, open, high, low, close, volume: volume ?? 0,
        }))
        candlesRef.current = candles
        series.setData(candles.map(({ time, open, high, low, close }) => ({
          time, open, high, low, close,
        })))
        applyOverlays(candles)
        applyPaperMarkers(body)
        chartRef.current?.timeScale().scrollToRealTime()
        readyRef.current = true
        const last = candles.at(-1)
        if (last) {
          setLastPrice(last.close)
          setTickAt(Date.now())
          setLivePriceLine(last.close)
        }
      } else if (series && readyRef.current) {
        applyPaperMarkers(body)
      }
    } catch (e) {
      setError(e.message || 'Live feed failed')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!hostRef.current) return undefined
    readyRef.current = false
    hostRef.current.replaceChildren()
    const chart = createChart(hostRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#121916' },
        textColor: '#8fa297',
      },
      grid: {
        vertLines: { color: '#2a3830' },
        horzLines: { color: '#2a3830' },
      },
      rightPriceScale: { borderColor: '#2a3830' },
      timeScale: {
        borderColor: '#2a3830',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
      },
      width: hostRef.current.clientWidth,
      height: hostRef.current.clientHeight || 420,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#3dba7a',
      downColor: '#e35d5d',
      borderVisible: false,
      wickUpColor: '#3dba7a',
      wickDownColor: '#e35d5d',
      lastValueVisible: true,
      priceLineVisible: true,
    })
    chartRef.current = chart
    candleSeriesRef.current = series
    overlaySeriesRef.current = []
    markersApiRef.current = null
    priceLinesRef.current = []
    lastPriceLineRef.current = null
    candlesRef.current = []

    const resizeObs = new ResizeObserver(() => {
      if (!hostRef.current || !chartRef.current) return
      chartRef.current.applyOptions({
        width: hostRef.current.clientWidth,
        height: hostRef.current.clientHeight || 420,
      })
    })
    resizeObs.observe(hostRef.current)

    return () => {
      readyRef.current = false
      resizeObs.disconnect()
      clearPriceLines()
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
    }
  }, [symbol, timeframe])

  // Seed history + paper sync (not used for live price)
  useEffect(() => {
    knownClosed.current = new Set()
    setFreshNote('')
    readyRef.current = false
    loadPaper({ seedChart: true })
    const t = setInterval(() => loadPaper({ seedChart: false }), PAPER_POLL_MS)
    return () => clearInterval(t)
  }, [symbol, timeframe, strategy])

  // Reliable live price: server ticker every 1s (works even when browser WS is blocked)
  useEffect(() => {
    let cancelled = false
    async function tick() {
      try {
        const res = await fetch(`/api/ticker?symbol=${encodeURIComponent(symbol)}`)
        const body = await res.json()
        if (cancelled || !res.ok) return
        applyTickPrice(Number(body.price), body.source || 'ticker')
      } catch {
        /* keep last price */
      }
    }
    tick()
    const id = setInterval(tick, TICK_POLL_MS)
    const cd = setInterval(() => setCountdown(candleCountdown(timeframe)), 1000)
    return () => {
      cancelled = true
      clearInterval(id)
      clearInterval(cd)
    }
  }, [symbol, timeframe])

  // Optional WS acceleration when browser can reach the exchange
  useEffect(() => {
    const disconnect = subscribeLiveStream(
      symbol,
      timeframe,
      (ev) => {
        if (ev.type === 'tick') {
          applyTickPrice(ev.price, ev.source)
          return
        }
        if (ev.type === 'kline') {
          pushCandleUpdate(
            {
              time: ev.time,
              open: ev.open,
              high: ev.high,
              low: ev.low,
              close: ev.close,
            },
            ev.volume,
          )
          setTickSource(ev.source)
        }
      },
      (st) => setStream(st),
    )
    return disconnect
  }, [symbol, timeframe])

  // Refresh countdown label on live price line
  useEffect(() => {
    if (lastPrice != null) setLivePriceLine(lastPrice)
  }, [countdown, lastPrice])

  const trades = paper?.trade_list || []
  const open = paper?.open
  const summary = paper?.summary
  const liveLabel = tickSource
    ? `LIVE · ${tickSource}`
    : stream.connected
      ? `LIVE · ${stream.source}`
      : 'starting live ticks…'

  return (
    <section className="live-desk table-wrap">
      <div className="table-head">
        <h2>
          Live paper desk
          <span>
            {liveLabel}
            {lastPrice != null ? ` · ${Number(lastPrice).toFixed(4)}` : ''}
            {` · ${countdown} left`}
            {busy ? ' · paper sync…' : ''}
          </span>
        </h2>
        <button type="button" className="scan-btn" disabled={busy} onClick={() => loadPaper({ seedChart: true })}>
          Sync paper
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {freshNote && <div className="banner">{freshNote}</div>}
      <div className="banner">
        Live price updates every 1s automatically (no refresh). Candle countdown on the price tag. Paper trades sync every 60s.
      </div>

      {summary && (
        <div className="stats live-stats">
          <article>
            <span>Last price · {countdown}</span>
            <strong className="live-price live-on">
              {lastPrice != null ? Number(lastPrice).toFixed(4) : '—'}
            </strong>
          </article>
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

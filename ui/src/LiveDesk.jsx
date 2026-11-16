import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
} from 'lightweight-charts'
import { fmtTime } from './fmtTime'
import { subscribeLiveStream } from './liveSocket'
import {
  fmtVolume,
  rsiSeries,
  strategyOverlays,
  supportResistanceLevels,
  volumeHistogram,
} from './strategyIndicators'
import { barMsFor } from './timeframes'

const PAPER_POLL_MS = 30_000
const TICK_POLL_MS = 1_000
const MAX_BARS = 800
const VISIBLE_BARS = 120

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

  /** Reject corrupt OHLC that paints giant red wicks after symbol switches. */
  function sanitizeBar(bar, refClose) {
    if (!bar) return null
    let { time, open, high, low, close } = bar
    open = Number(open)
    high = Number(high)
    low = Number(low)
    close = Number(close)
    if (![time, open, high, low, close].every(Number.isFinite)) return null
    if (!(high >= low)) {
      const mid = (open + close) / 2
      high = Math.max(open, close, mid)
      low = Math.min(open, close, mid)
    }
    high = Math.max(high, open, close)
    low = Math.min(low, open, close)
    const ref = Number.isFinite(refClose) && refClose > 0 ? refClose : close
    // Stale tick from another symbol (e.g. SOL ~70 on AVAX ~7) → drop
    if (ref > 0 && (close > ref * 4 || close < ref * 0.25)) return null
    if (ref > 0 && (high > ref * 4 || low < ref * 0.25)) {
      high = Math.max(open, close)
      low = Math.min(open, close)
    }
    return { time, open, high, low, close }
  }

  export default function LiveDesk({ symbol, timeframe, strategy, onSelectTrade, onPaperUpdate }) {
    const hostRef = useRef(null)
    const chartRef = useRef(null)
    const candleSeriesRef = useRef(null)
    const overlaySeriesRef = useRef([])
    const volumeSeriesRef = useRef(null)
    const rsiSeriesRef = useRef(null)
    const srLinesRef = useRef([])
    const markersApiRef = useRef(null)
    const priceLinesRef = useRef([])
    const lastPriceLineRef = useRef(null)
    const candlesRef = useRef([])
    const readyRef = useRef(false)
    const pendingTickRef = useRef(null)
    const timeframeRef = useRef(timeframe)
    const symbolRef = useRef(symbol)
    timeframeRef.current = timeframe
    symbolRef.current = symbol
    const feedGenRef = useRef(0)
    const showVolRef = useRef(true)
    const showRsiRef = useRef(true)
    const showSrRef = useRef(true)

  const [paper, setPaper] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [stream, setStream] = useState({ connected: false, source: null })
  const [tickSource, setTickSource] = useState(null)
  const [lastPrice, setLastPrice] = useState(null)
  const [tickAt, setTickAt] = useState(null)
  const [countdown, setCountdown] = useState(() => candleCountdown(timeframe))
  const knownClosed = useRef(new Set())
  const loadGenRef = useRef(0)
  const stickToRealtimeRef = useRef(true)
  const suppressRangeRef = useRef(false)
  const [pinned, setPinned] = useState(true)
  const [freshNote, setFreshNote] = useState('')
  const [showVolume, setShowVolume] = useState(true)
  const [showRsi, setShowRsi] = useState(true)
  const [showSr, setShowSr] = useState(true)
  const [lastVol, setLastVol] = useState(null)
  showVolRef.current = showVolume
  showRsiRef.current = showRsi
  showSrRef.current = showSr

  function syncSeriesData() {
    const series = candleSeriesRef.current
    if (!series) return
    series.setData(
      candlesRef.current.map(({ time, open, high, low, close }) => ({
        time, open, high, low, close,
      })),
    )
  }

  /** Keep the same candles on screen after front-trim + setData remaps logical indexes. */
  function trimCandleBuffer() {
    const list = candlesRef.current
    if (list.length <= MAX_BARS) return
    const removed = list.length - MAX_BARS
    const chart = chartRef.current
    const keptRange = !stickToRealtimeRef.current
      ? chart?.timeScale().getVisibleLogicalRange()
      : null
    list.splice(0, removed)
    syncSeriesData()
    if (stickToRealtimeRef.current) {
      showRecentBars()
      return
    }
    if (keptRange && chart) {
      suppressRangeRef.current = true
      chart.timeScale().setVisibleLogicalRange({
        from: keptRange.from - removed,
        to: keptRange.to - removed,
      })
      requestAnimationFrame(() => { suppressRangeRef.current = false })
    }
  }

  function showRecentBars() {
    const chart = chartRef.current
    const n = candlesRef.current.length
    if (!chart || n < 2) return
    suppressRangeRef.current = true
    const from = Math.max(0, n - VISIBLE_BARS)
    chart.timeScale().setVisibleLogicalRange({ from: from - 0.5, to: n + 8 })
    stickToRealtimeRef.current = true
    setPinned(true)
    requestAnimationFrame(() => { suppressRangeRef.current = false })
  }

  useEffect(() => {
    setCountdown(candleCountdown(timeframe))
  }, [timeframe])

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
    if (!series || !Number.isFinite(price) || price <= 0) return
    const title = candleCountdown(timeframeRef.current)
    if (lastPriceLineRef.current) {
      try {
        lastPriceLineRef.current.applyOptions({ price, title })
        return
      } catch {
        try { series.removePriceLine(lastPriceLineRef.current) } catch { /* */ }
        lastPriceLineRef.current = null
      }
    }
    lastPriceLineRef.current = series.createPriceLine({
      price,
      color: '#e35d5d',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: true,
      title,
    })
  }

  function clearSrLines() {
    const series = candleSeriesRef.current
    if (!series) {
      srLinesRef.current = []
      return
    }
    for (const line of srLinesRef.current) {
      try { series.removePriceLine(line) } catch { /* */ }
    }
    srLinesRef.current = []
  }

  function applyOverlays(candles) {
    const chart = chartRef.current
    if (!chart || !candles?.length) return

    for (const s of overlaySeriesRef.current) {
      try { chart.removeSeries(s) } catch { /* */ }
    }
    overlaySeriesRef.current = []

    if (strategy) {
      const overlays = strategyOverlays(strategy, candles)
      for (const line of overlays.lines) {
        if (!line.data.length) continue
        const ls = chart.addSeries(LineSeries, {
          color: line.color,
          lineWidth: 2,
          title: line.title,
          lastValueVisible: true,
          priceLineVisible: false,
        }, 0)
        ls.setData(line.data)
        overlaySeriesRef.current.push(ls)
      }
    }

    // Rebuild indicator panes; drop empty panes so no black strip under the axis
    if (volumeSeriesRef.current) {
      try { chart.removeSeries(volumeSeriesRef.current) } catch { /* */ }
      volumeSeriesRef.current = null
    }
    if (rsiSeriesRef.current) {
      try { chart.removeSeries(rsiSeriesRef.current) } catch { /* */ }
      rsiSeriesRef.current = null
    }
    try {
      const panes = chart.panes()
      for (let i = panes.length - 1; i >= 1; i--) {
        if ((panes[i].getSeries?.() || []).length === 0) chart.removePane(i)
      }
    } catch { /* */ }

    let nextPane = 1
    if (showVolRef.current) {
      const pane = nextPane++
      volumeSeriesRef.current = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: true,
        title: 'Volume',
      }, pane)
      try {
        chart.priceScale('vol', pane).applyOptions({
          scaleMargins: { top: 0.15, bottom: 0 },
        })
      } catch { /* */ }
      volumeSeriesRef.current.setData(volumeHistogram(candles))
    }

    if (showRsiRef.current) {
      const pane = nextPane++
      rsiSeriesRef.current = chart.addSeries(LineSeries, {
        color: '#c6f54c',
        lineWidth: 2,
        priceScaleId: 'rsi',
        lastValueVisible: true,
        title: 'RSI 14',
        priceLineVisible: false,
      }, pane)
      try {
        chart.priceScale('rsi', pane).applyOptions({
          scaleMargins: { top: 0.1, bottom: 0.1 },
        })
      } catch { /* */ }
      rsiSeriesRef.current.setData(rsiSeries(candles))
    }

    try {
      const panes = chart.panes()
      panes[0]?.setStretchFactor?.(3)
      for (let i = 1; i < panes.length; i++) panes[i]?.setStretchFactor?.(1)
    } catch { /* */ }

    // Support & Resistance on price pane
    clearSrLines()
    if (showSrRef.current && candleSeriesRef.current) {
      const levels = supportResistanceLevels(candles)
      for (const lv of levels) {
        const line = candleSeriesRef.current.createPriceLine({
          price: lv.price,
          color: lv.kind === 'resistance' ? '#e35d5d' : '#3dba7a',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: lv.title,
        })
        srLinesRef.current.push(line)
      }
    }

    const last = candles[candles.length - 1]
    setLastVol(last?.volume ?? null)
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

  function pushCandleUpdate(bar, volume, feedGen) {
    const series = candleSeriesRef.current
    if (!series || !readyRef.current) return
    if (feedGen != null && feedGen !== feedGenRef.current) return
    const list = candlesRef.current
    const prev = list[list.length - 1]
    const clean = sanitizeBar(bar, prev?.close ?? bar.close)
    if (!clean) return
    try {
      series.update(clean)
    } catch {
      return
    }
    setLastPrice(clean.close)
    setTickAt(Date.now())
    setLivePriceLine(clean.close)

    let isNewBar = false
    if (prev && prev.time === clean.time) {
      list[list.length - 1] = { ...clean, volume: volume ?? prev.volume ?? 0 }
    } else if (!prev || clean.time > prev.time) {
      list.push({ ...clean, volume: volume ?? 0 })
      if (list.length > MAX_BARS) trimCandleBuffer()
      isNewBar = true
    }
    if (stickToRealtimeRef.current && isNewBar) {
      chartRef.current?.timeScale().scrollToRealTime()
    }
    setLastVol(list[list.length - 1]?.volume ?? null)
    // Keep volume / RSI series in sync on live bars
    if (volumeSeriesRef.current && showVolRef.current) {
      try {
        const c = list[list.length - 1]
        volumeSeriesRef.current.update({
          time: c.time,
          value: Number(c.volume) || 0,
          color: c.close >= c.open ? 'rgba(61, 186, 122, 0.55)' : 'rgba(227, 93, 93, 0.55)',
        })
      } catch { /* */ }
    }
  }

  function applyTickPrice(price, source, feedGen) {
    if (!Number.isFinite(price) || price <= 0) return
    if (feedGen != null && feedGen !== feedGenRef.current) return
    if (!readyRef.current) {
      pendingTickRef.current = { price, source, feedGen: feedGenRef.current }
      setLastPrice(price)
      setTickAt(Date.now())
      if (source) setTickSource(source)
      return
    }
    const list = candlesRef.current
    let last = list[list.length - 1]
    if (!last) return
    // Drop cross-symbol stale ticks (SOL price on AVAX chart)
    if (last.close > 0 && (price > last.close * 4 || price < last.close * 0.25)) return

    const openT = barOpenSec(timeframeRef.current)
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
      if (list.length > MAX_BARS) trimCandleBuffer()
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
      feedGenRef.current,
    )
  }

  async function loadPaper({ seedChart } = { seedChart: false }) {
    const gen = ++loadGenRef.current
    setBusy(true)
    try {
      // notify=1 → Telegram for fresh entries on this chart TF/strategy (not 1h-only scan)
      const qs = new URLSearchParams({
        symbol, timeframe, strategy, notify: '1', limit: '1000',
      })
      const res = await fetch(`/api/live?${qs}`)
      const body = await res.json()
      // Ignore stale responses from a previous symbol/TF (fixes 1h flash on 15m switch)
      if (gen !== loadGenRef.current) return
      if (!res.ok) throw new Error(body.error || `Live ${res.status}`)

      const prev = knownClosed.current
      const newly = []
      for (const t of body.trade_list || []) {
        const key = `${t.entry_time}|${t.exit_time}|${t.side}`
        if (!prev.has(key)) newly.push(t)
        prev.add(key)
      }
      if (body.telegramNotifyCount > 0) {
        setFreshNote(
          `Telegram · ${body.telegramNotifyCount} live entry alert(s) sent for ${symbol} ${timeframe}`,
        )
      } else if (newly.length) {
        setFreshNote(
          `Recorded ${newly.length} new paper trade(s) · latest exit ${fmtTime(newly.at(-1).exit_time)}`
          + (body.telegramConfigured === false ? ' · Telegram not configured on server' : ''),
        )
      }

      setPaper(body)
      onPaperUpdate?.(body)
      setError('')

      const series = candleSeriesRef.current
      if (seedChart && series && body.candles?.length) {
        if (gen !== loadGenRef.current) return
        const candles = []
        for (const c of body.candles) {
          const clean = sanitizeBar(
            { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close },
            candles.at(-1)?.close,
          )
          if (clean) candles.push({ ...clean, volume: c.volume ?? 0 })
        }
        candlesRef.current = candles
        series.setData(candles.map(({ time, open, high, low, close }) => ({
          time, open, high, low, close,
        })))
        applyOverlays(candles)
        applyPaperMarkers(body)
        readyRef.current = true
        showRecentBars()
        const last = candles.at(-1)
        if (last) {
          setLastPrice(last.close)
          setTickAt(Date.now())
          setLivePriceLine(last.close)
        }
        if (pendingTickRef.current) {
          const p = pendingTickRef.current
          pendingTickRef.current = null
          if (p.feedGen == null || p.feedGen === feedGenRef.current) {
            applyTickPrice(p.price, p.source, feedGenRef.current)
          }
        }
      } else if (series && readyRef.current && gen === loadGenRef.current) {
        applyPaperMarkers(body)
      }
    } catch (e) {
      if (gen === loadGenRef.current) setError(e.message || 'Live feed failed')
    } finally {
      if (gen === loadGenRef.current) setBusy(false)
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
        // Only Jump-to-realtime / stick scroll moves the viewport (TV-style history pan)
        shiftVisibleRangeOnNewBar: false,
      },
      width: hostRef.current.clientWidth,
      height: hostRef.current.clientHeight || 520,
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
    volumeSeriesRef.current = null
    rsiSeriesRef.current = null
    srLinesRef.current = []
    markersApiRef.current = null
    priceLinesRef.current = []
    lastPriceLineRef.current = null
    candlesRef.current = []
    stickToRealtimeRef.current = true
    suppressRangeRef.current = false

    const onRange = (range) => {
      if (suppressRangeRef.current || !range) return
      const n = candlesRef.current.length
      if (n < 2) return
      // Allow blank past (TV pan). Never yank history view back to live.
      const atEnd = range.to >= n - 1
      if (stickToRealtimeRef.current !== atEnd) {
        stickToRealtimeRef.current = atEnd
        setPinned(atEnd)
      }
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    const resizeObs = new ResizeObserver(() => {
      if (!hostRef.current || !chartRef.current) return
      chartRef.current.applyOptions({
        width: hostRef.current.clientWidth,
        height: hostRef.current.clientHeight || 520,
      })
    })
    resizeObs.observe(hostRef.current)

    return () => {
      readyRef.current = false
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      } catch { /* */ }
      resizeObs.disconnect()
      clearSrLines()
      clearPriceLines()
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      rsiSeriesRef.current = null
    }
  }, [symbol, timeframe])

  useEffect(() => {
    if (!readyRef.current || !candlesRef.current.length) return
    applyOverlays(candlesRef.current)
  }, [showVolume, showRsi, showSr, strategy])

  // Seed history + paper sync (not used for live price)
  useEffect(() => {
    knownClosed.current = new Set()
    setFreshNote('')
    readyRef.current = false
    pendingTickRef.current = null
    candlesRef.current = []
    setLastPrice(null)
    feedGenRef.current += 1
    loadGenRef.current += 1
    loadPaper({ seedChart: true })
    const t = setInterval(() => loadPaper({ seedChart: false }), PAPER_POLL_MS)
    return () => {
      clearInterval(t)
      loadGenRef.current += 1
      feedGenRef.current += 1
      pendingTickRef.current = null
      readyRef.current = false
    }
  }, [symbol, timeframe, strategy])

  // Reliable live price: server ticker every 1s (works even when browser WS is blocked)
  useEffect(() => {
    let cancelled = false
    const gen = feedGenRef.current
    async function tick() {
      try {
        const res = await fetch(`/api/ticker?symbol=${encodeURIComponent(symbol)}`)
        const body = await res.json()
        if (cancelled || !res.ok || gen !== feedGenRef.current) return
        if (symbolRef.current !== symbol) return
        applyTickPrice(Number(body.price), body.source || 'ticker', gen)
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
    const gen = feedGenRef.current
    const disconnect = subscribeLiveStream(
      symbol,
      timeframe,
      (ev) => {
        if (gen !== feedGenRef.current || symbolRef.current !== symbol) return
        if (ev.type === 'tick') {
          applyTickPrice(ev.price, ev.source, gen)
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
            gen,
          )
          setTickSource(ev.source)
        }
      },
      (st) => {
        if (gen === feedGenRef.current) setStream(st)
      },
    )
    return disconnect
  }, [symbol, timeframe])

  // Refresh countdown label on live price line
  useEffect(() => {
    if (lastPrice != null) setLivePriceLine(lastPrice)
  }, [countdown, lastPrice])

  const open = paper?.open
  const summary = paper?.summary
  const liveLabel = tickSource
    ? `LIVE · ${tickSource}`
    : stream.connected
      ? `LIVE · ${stream.source}`
      : 'starting live ticks…'

  return (
    <section className="live-desk">
      <div className="live-toolbar">
        <div className="live-toolbar-meta">
          <strong className="live-price live-on">
            {lastPrice != null ? Number(lastPrice).toFixed(4) : '—'}
          </strong>
          <span>{liveLabel}</span>
          <span>{countdown} left · {timeframe}</span>
          {open && (
            <span className={open.unrealized >= 0 ? 'up' : 'down'}>
              {open.side} · {Number(open.unrealized).toFixed(2)}
            </span>
          )}
          {!open && summary && strategy && <span>Flat · {summary.trades} paper trades</span>}
          {!strategy && <span>No strategy</span>}
          {busy && <span>sync…</span>}
          <span className="live-vol">Vol {fmtVolume(lastVol)}</span>
        </div>
        <div className="live-toolbar-actions">
          {!pinned && (
            <button
              type="button"
              className="tv-scan ghost"
              onClick={() => showRecentBars()}
            >
              Jump to realtime
            </button>
          )}
          <button type="button" className="tv-scan" disabled={busy} onClick={() => loadPaper({ seedChart: true })}>
            Sync
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {freshNote && <div className="banner quiet">{freshNote}</div>}

      <div className="live-chart-wrap">
        <div className="chart-legend" aria-label="Indicators">
          <button
            type="button"
            className={`ind-eye ${showVolume ? 'on' : ''}`}
            title={showVolume ? 'Hide Volume' : 'Show Volume'}
            onClick={() => setShowVolume((v) => !v)}
          >
            <span aria-hidden="true">{showVolume ? '👁' : '👁‍🗨'}</span> Volume
          </button>
          <button
            type="button"
            className={`ind-eye ${showRsi ? 'on' : ''}`}
            title={showRsi ? 'Hide RSI' : 'Show RSI'}
            onClick={() => setShowRsi((v) => !v)}
          >
            <span aria-hidden="true">{showRsi ? '👁' : '👁‍🗨'}</span> RSI
          </button>
          <button
            type="button"
            className={`ind-eye ${showSr ? 'on' : ''}`}
            title={showSr ? 'Hide Support & Resistance' : 'Show Support & Resistance'}
            onClick={() => setShowSr((v) => !v)}
          >
            <span aria-hidden="true">{showSr ? '👁' : '👁‍🗨'}</span> S&amp;R
          </button>
        </div>
        <div className="chart-host live-chart-host" ref={hostRef} />
      </div>
    </section>
  )
}

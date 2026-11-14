import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
} from 'lightweight-charts'
import { fmtTime, toMs, tradingViewUrl } from './fmtTime'
import { strategyOverlays } from './strategyIndicators'

function barTimeSec(isoOrMs, timeframe) {
  const ms = toMs(isoOrMs)
  const barMs = timeframe === '15m' ? 15 * 60_000 : 60 * 60_000
  return Math.floor(ms / barMs) * (barMs / 1000)
}

export default function TradeChartModal({
  trade,
  symbol,
  timeframe,
  strategy,
  tradeIndex,
  tradeCount,
  onClose,
  onPrev,
  onNext,
}) {
  const hostRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [meta, setMeta] = useState(null)

  useEffect(() => {
    if (!trade) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
      if (e.key === 'ArrowLeft') onPrev?.()
      if (e.key === 'ArrowRight') onNext?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [trade, onClose, onPrev, onNext])

  useEffect(() => {
    if (!trade || !hostRef.current) return undefined
    let cancelled = false
    let chart
    let resizeObs

    async function run() {
      setLoading(true)
      setError('')
      setMeta(null)
      try {
        const from = toMs(trade.entry_time)
        const to = toMs(trade.exit_time)
        const qs = new URLSearchParams({
          symbol,
          timeframe,
          from: String(from),
          to: String(to),
        })
        const res = await fetch(`/api/ohlcv?${qs}`)
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(data.error || `OHLCV ${res.status}`)
        const candles = data.candles || []
        if (!candles.length) throw new Error('No candles for this trade window')

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
        series.setData(candles.map(({ time, open, high, low, close }) => ({
          time, open, high, low, close,
        })))

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
        }

        const entryT = barTimeSec(trade.entry_time, timeframe)
        const exitT = barTimeSec(trade.exit_time, timeframe)
        const ok = trade.outcome === 'successful'
        const long = trade.side === 'LONG'

        series.createPriceLine({
          price: Number(trade.entry),
          color: long ? '#4aa3ff' : '#d4a017',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Entry',
        })
        series.createPriceLine({
          price: Number(trade.exit),
          color: ok ? '#3dba7a' : '#e35d5d',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Exit',
        })

        createSeriesMarkers(series, [
          {
            time: entryT,
            position: long ? 'belowBar' : 'aboveBar',
            color: long ? '#4aa3ff' : '#d4a017',
            shape: long ? 'arrowUp' : 'arrowDown',
            text: `ENTRY ${trade.side}`,
          },
          {
            time: exitT,
            position: ok ? 'aboveBar' : 'belowBar',
            color: ok ? '#3dba7a' : '#e35d5d',
            shape: 'circle',
            text: `EXIT ${trade.reason}`,
          },
        ])

        const pad = timeframe === '15m' ? 20 * 15 * 60 : 20 * 60 * 60
        chart.timeScale().setVisibleRange({
          from: entryT - pad,
          to: exitT + pad,
        })

        resizeObs = new ResizeObserver(() => {
          if (!hostRef.current || !chart) return
          chart.applyOptions({
            width: hostRef.current.clientWidth,
            height: hostRef.current.clientHeight || 420,
          })
        })
        resizeObs.observe(hostRef.current)

        setMeta({
          source: data.source,
          count: candles.length,
          indicators: overlays.label || null,
        })
        setLoading(false)
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'Failed to load chart')
          setLoading(false)
        }
      }
    }

    run()
    return () => {
      cancelled = true
      resizeObs?.disconnect()
      chart?.remove()
    }
  }, [trade, symbol, timeframe, strategy])

  if (!trade) return null
  const ok = trade.outcome === 'successful'
  const tv = tradingViewUrl(symbol, timeframe)

  return (
    <div className="chart-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="chart-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Trade chart"
      >
        <div className="chart-modal-head">
          <div>
            <h2>
              {strategy} · {symbol} · {timeframe}
              <span className={`side ${trade.side === 'LONG' ? 'long' : 'short'}`}>{trade.side}</span>
              <span className={`badge ${ok ? 'win' : 'loss'}`}>{ok ? 'Successful' : 'Failed'}</span>
            </h2>
            <p>
              Entry {fmtTime(trade.entry_time)} → Exit {fmtTime(trade.exit_time)}
              {' · '}
              <span className={trade.net >= 0 ? 'up' : 'down'}>{Number(trade.net).toFixed(2)}</span>
              {' · '}{trade.reason}
              {meta?.indicators ? ` · ${meta.indicators}` : ''}
              {meta ? ` · ${meta.count} bars (${meta.source})` : ''}
            </p>
          </div>
          <div className="chart-modal-actions">
            <button type="button" disabled={!onPrev} onClick={onPrev}>Prev</button>
            <span>{tradeIndex + 1} / {tradeCount}</span>
            <button type="button" disabled={!onNext} onClick={onNext}>Next</button>
            <a href={tv} target="_blank" rel="noreferrer" className="tv-link">Open on TradingView</a>
            <button type="button" className="close-btn" onClick={onClose}>Close</button>
          </div>
        </div>
        {error && <div className="banner error">{error}</div>}
        {loading && !error && <div className="banner">Loading candles…</div>}
        <div className="chart-host" ref={hostRef} />
        {meta?.indicators && (
          <div className="chart-legend">
            Indicators on by default: <strong>{meta.indicators}</strong>
          </div>
        )}
      </div>
    </div>
  )
}

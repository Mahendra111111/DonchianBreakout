import { useEffect, useMemo, useState } from 'react'
import './App.css'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
const STRATEGIES = ['Donchian Breakout', 'EMA Trend Following', 'Hammer SMA VWAP']
const TIMEFRAMES = ['1h', '15m']
const PERIODS = [
  { id: '7d', label: '7 days' },
  { id: '15d', label: '15 days' },
  { id: '1m', label: '1 month' },
  { id: '3m', label: '3 months' },
  { id: '6m', label: '6 months' },
  { id: '1y', label: '1 year' },
  { id: '3y', label: '3 years' },
  { id: '5y', label: '5 years' },
]

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—'
  const v = Number(n)
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function fmtTime(isoOrMs) {
  if (isoOrMs == null || isoOrMs === '') return '—'
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs)
  if (!Number.isFinite(ms)) return String(isoOrMs)
  const d = new Date(ms)
  const datePart = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d)
  const timePart = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(d)
    .replace(/\s/g, '')
    .replace(':', '.')
    .toLowerCase()
  return `${datePart}, ${timePart} IST`
}

export default function App() {
  const [symbol, setSymbol] = useState('SOLUSDT')
  const [strategy, setStrategy] = useState('Donchian Breakout')
  const [timeframe, setTimeframe] = useState('1h')
  const [period, setPeriod] = useState('5y')
  const [summary, setSummary] = useState(null)
  const [tradeList, setTradeList] = useState([])
  const [periodCards, setPeriodCards] = useState({})
  const [ranking, setRanking] = useState([])
  const [signals, setSignals] = useState([])
  const [recent, setRecent] = useState([])
  const [scanMeta, setScanMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scanBusy, setScanBusy] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [page, setPage] = useState(0)
  const pageSize = 50

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      setPage(0)
      try {
        const qs = new URLSearchParams({ symbol, strategy, timeframe, period })
        const res = await fetch(`/api/results?${qs}`)
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(data.error || `API ${res.status}`)
        setSummary(data.summary)
        let trades = data.trade_list || []
        if (!trades.length && data.summary?.trades_file) {
          const tr = await fetch(`/trades/${data.summary.trades_file}`)
          if (tr.ok) trades = await tr.json()
        } else if (!trades.length && data.period_cards?.[period]?.trades_file) {
          const tr = await fetch(`/trades/${data.period_cards[period].trades_file}`)
          if (tr.ok) trades = await tr.json()
        }
        if (cancelled) return
        setTradeList(Array.isArray(trades) ? trades : [])
        setPeriodCards(data.period_cards || {})
        setRanking(data.ranking || [])
      } catch (e) {
        if (!cancelled) {
          setSummary(null)
          setTradeList([])
          setError(e.message || 'Failed to load research results')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [symbol, strategy, timeframe, period])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch('/api/signals')
        const data = await res.json()
        if (cancelled || !res.ok) return
        setSignals(data.signals || [])
        setRecent(data.recent || [])
        setScanMeta({
          scannedAt: data.scannedAt,
          telegramConfigured: data.telegramConfigured,
          timeframe: data.timeframe,
          recentDays: data.recentDays,
        })
      } catch {
        /* ignore */
      }
    }
    poll()
    const t = setInterval(poll, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  async function triggerScan() {
    setScanBusy(true)
    setScanMsg('')
    try {
      setError('')
      const res = await fetch('/api/scan?notify=1&desk=1')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Scan ${res.status}`)
      setSignals(data.signals || [])
      setRecent(data.recent || [])
      setScanMeta({
        scannedAt: data.scannedAt,
        telegramConfigured: data.telegramConfigured,
        timeframe: data.timeframe,
        recentDays: data.recentDays,
      })
      setScanMsg(
        data.telegramConfigured
          ? `Scan done · ${data.recentCount || 0} opportunity record(s) · ${data.notifyCount} Telegram message(s)`
          : `Scan done · ${data.recentCount || 0} opportunity record(s) · Telegram not configured`,
      )
    } catch (e) {
      setError(e.message || 'Scan failed')
      setScanMsg('')
    } finally {
      setScanBusy(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(tradeList.length / pageSize))
  const pageRows = useMemo(
    () => tradeList.slice(page * pageSize, (page + 1) * pageSize),
    [tradeList, page],
  )

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="eyebrow">EMA + Donchian + Hammer</p>
          <h1>Strategy Desk</h1>
        </div>
        <div className="controls">
          <label>
            Strategy
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Symbol
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {SYMBOLS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Candle TF
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Lookback
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <button type="button" className="scan-btn" disabled={scanBusy} onClick={triggerScan}>
            {scanBusy ? 'Scanning…' : 'Scan + Telegram'}
          </button>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {loading && !summary && !error && <div className="banner">Loading research…</div>}
      {scanMsg && <div className="banner">{scanMsg}</div>}

      {Object.keys(periodCards).length > 0 && (
        <section className="period-grid">
          {PERIODS.map((p) => {
            const c = periodCards[p.id]
            if (!c) return null
            const active = period === p.id
            return (
              <button
                key={p.id}
                type="button"
                className={`period-card ${active ? 'active' : ''}`}
                onClick={() => setPeriod(p.id)}
              >
                <span>{p.label}</span>
                <strong className={c.net_return_pct >= 0 ? 'up' : 'down'}>{fmtPct(c.net_return_pct)}</strong>
                <small>{c.trades ?? 0} trades · WR {c.win_rate_pct != null ? `${Number(c.win_rate_pct).toFixed(1)}%` : '—'}</small>
              </button>
            )
          })}
        </section>
      )}

      {summary && (
        <section className="stats">
          <article>
            <span>Net return ({period})</span>
            <strong className={summary.net_return_pct >= 0 ? 'up' : 'down'}>
              {fmtPct(summary.net_return_pct)}
            </strong>
          </article>
          <article>
            <span>Win rate</span>
            <strong>{summary.success_rate_pct != null ? `${summary.success_rate_pct}%` : '—'}</strong>
          </article>
          <article>
            <span>Trades</span>
            <strong>{summary.trades?.toLocaleString?.() ?? summary.trades}</strong>
          </article>
          <article>
            <span>Successful</span>
            <strong className="up">{summary.successful ?? '—'}</strong>
          </article>
          <article>
            <span>Failed</span>
            <strong className="down">{summary.failed ?? '—'}</strong>
          </article>
          <article>
            <span>Profit factor</span>
            <strong>{summary.profit_factor != null ? Number(summary.profit_factor).toFixed(3) : '—'}</strong>
          </article>
          <article>
            <span>Max drawdown</span>
            <strong className="down">{fmtPct(summary.max_dd_pct)}</strong>
          </article>
          <article>
            <span>Stop exits</span>
            <strong>{summary.stop_exit_pct != null ? `${Number(summary.stop_exit_pct).toFixed(1)}%` : '—'}</strong>
          </article>
        </section>
      )}

      <section className="table-wrap">
        <div className="table-head">
          <h2>
            Trade records
            <span>{tradeList.length} in {period}{summary?.from ? ` · ${fmtTime(summary.from)} → ${fmtTime(summary.to)}` : ''}</span>
          </h2>
          <div className="pager">
            <button type="button" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
            <span>{page + 1} / {pageCount}</span>
            <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </div>
        <div className="scroll">
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
              {pageRows.map((t, i) => {
                const ok = t.outcome === 'successful'
                return (
                  <tr key={`${t.entry_time}-${i}`} className={ok ? 'row-win' : 'row-loss'}>
                    <td>{page * pageSize + i + 1}</td>
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
              {pageRows.length === 0 && (
                <tr><td colSpan={7} className="empty">No trades in this lookback window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="table-wrap">
        <div className="table-head">
          <h2>
            Live + recent opportunities
            <span>
              {scanMeta?.telegramConfigured ? 'Telegram on' : 'Telegram off'}
              {scanMeta?.recentDays ? ` · last ${scanMeta.recentDays}d` : ''}
              {scanMeta?.scannedAt ? ` · ${fmtTime(scanMeta.scannedAt)}` : ''}
            </span>
          </h2>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Symbol</th>
                <th>Strategy</th>
                <th>Side</th>
                <th>Close</th>
                <th>Bar</th>
              </tr>
            </thead>
            <tbody>
              {(recent.length ? recent : signals).map((s) => (
                <tr key={`${s.symbol}-${s.strategy}-${s.side}-${s.barTime}`}>
                  <td>{s.kind || 'live'}</td>
                  <td>{s.symbol}</td>
                  <td>{s.strategy}</td>
                  <td><span className={`side ${s.side === 'LONG' ? 'long' : 'short'}`}>{s.side}</span></td>
                  <td>{Number(s.close).toFixed(4)}</td>
                  <td>{fmtTime(s.barTime)}</td>
                </tr>
              ))}
              {(recent.length ? recent : signals).length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">No opportunities in the recent window / last closed bar.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {ranking.length > 0 && (
        <section className="table-wrap">
          <div className="table-head">
            <h2>Research ranking <span>full-sample avg</span></h2>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Avg 1h</th>
                  <th>Avg 15m</th>
                  <th>Best cell</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r) => (
                  <tr key={r.strategy}>
                    <td>{r.strategy}</td>
                    <td className={r.avg_net_return_pct_1h >= 0 ? 'up' : 'down'}>{fmtPct(r.avg_net_return_pct_1h)}</td>
                    <td className={r.avg_net_return_pct_15m >= 0 ? 'up' : 'down'}>{fmtPct(r.avg_net_return_pct_15m)}</td>
                    <td>
                      {r.best_cell
                        ? `${r.best_cell.symbol} ${r.best_cell.timeframe} (${fmtPct(r.best_cell.net_return_pct)})`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

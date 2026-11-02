import { useEffect, useMemo, useState } from 'react'
import './App.css'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
const RR_OPTIONS = [
  { label: '1.2R', value: 1.2 },
  { label: '1.5R', value: 1.5 },
]

function isSuccessful(trade) {
  return trade.outcome === 'successful'
}

function fmtTime(iso) {
  if (!iso) return '—'
  return String(iso).replace('T', ' ').replace('+00:00', ' UTC')
}

export default function App() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [rr, setRr] = useState(1.2)
  const [filter, setFilter] = useState('all')
  const [sideFilter, setSideFilter] = useState('all')
  const [summary, setSummary] = useState(null)
  const [trades, setTrades] = useState([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('Connecting…')
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const pageSize = 50

  useEffect(() => {
    let cancelled = false
    let timer

    async function load() {
      setLoading(true)
      setError('')
      setPage(0)
      try {
        const res = await fetch(`/api/results?symbol=${encodeURIComponent(symbol)}&rr=${rr}`)
        const data = await res.json()
        if (cancelled) return

        if (res.status === 202 || data.ready === false) {
          setSummary(null)
          setTrades([])
          setProgress(data.progress || 'Running backtest from Supabase…')
          timer = setTimeout(load, 2000)
          return
        }
        if (!res.ok) {
          throw new Error(data.error || `API error ${res.status}`)
        }
        setSummary(data.summary)
        setTrades(data.trades || [])
        setProgress(data.summary?.data_source || 'supabase')
      } catch (e) {
        if (!cancelled) {
          setSummary(null)
          setTrades([])
          setError(e.message || 'Failed to load live results')
          setProgress('Waiting for API…')
          timer = setTimeout(load, 2500)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [symbol, rr])

  const filtered = useMemo(() => {
    return trades.filter((t) => {
      const ok = isSuccessful(t)
      if (filter === 'successful' && !ok) return false
      if (filter === 'failed' && ok) return false
      if (sideFilter !== 'all' && t.side_text !== sideFilter) return false
      return true
    })
  }, [trades, filter, sideFilter])

  const counts = useMemo(() => {
    let successful = 0
    let failed = 0
    for (const t of trades) {
      if (isSuccessful(t)) successful += 1
      else failed += 1
    }
    return { successful, failed, total: trades.length }
  }, [trades])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice(page * pageSize, (page + 1) * pageSize)

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="eyebrow">Live Supabase Backtest</p>
          <h1>Trade Results</h1>
        </div>
        <div className="controls">
          <label>
            Symbol
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {SYMBOLS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Take-profit
            <select value={rr} onChange={(e) => setRr(Number(e.target.value))}>
              {RR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            Outcome
            <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0) }}>
              <option value="all">All trades</option>
              <option value="successful">Successful only</option>
              <option value="failed">Failed only</option>
            </select>
          </label>
          <label>
            Side
            <select value={sideFilter} onChange={(e) => { setSideFilter(e.target.value); setPage(0) }}>
              <option value="all">Long + Short</option>
              <option value="LONG">Long</option>
              <option value="SHORT">Short</option>
            </select>
          </label>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {(loading || !summary) && !error && (
        <div className="banner">{progress}</div>
      )}

      {summary && (
        <>
          <section className="stats">
            <article>
              <span>Total trades</span>
              <strong>{counts.total}</strong>
            </article>
            <article>
              <span>Successful trades</span>
              <strong className="up">{counts.successful}</strong>
            </article>
            <article>
              <span>Failed trades</span>
              <strong className="down">{counts.failed}</strong>
            </article>
            <article>
              <span>Success rate</span>
              <strong>
                {summary.success_rate_pct != null ? `${summary.success_rate_pct}%` : '—'}
              </strong>
            </article>
            <article>
              <span>Data source</span>
              <strong className="source">{summary.data_source}</strong>
            </article>
            <article>
              <span>Candles used</span>
              <strong>{summary.candles?.toLocaleString?.() ?? summary.candles ?? '—'}</strong>
            </article>
          </section>

          <section className="table-wrap">
            <div className="table-head">
              <h2>
                Trades
                <span>{filtered.length} shown</span>
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
                    <th>Reason</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((t, i) => {
                    const ok = isSuccessful(t)
                    return (
                      <tr key={`${t.entry_time}-${i}`} className={ok ? 'row-win' : 'row-loss'}>
                        <td>{page * pageSize + i + 1}</td>
                        <td>
                          <span className={`side ${t.side_text === 'LONG' ? 'long' : 'short'}`}>
                            {t.side_text}
                          </span>
                        </td>
                        <td>
                          <div className="stack">
                            <span>{Number(t.entry).toFixed(2)}</span>
                            <small>{fmtTime(t.entry_time)}</small>
                          </div>
                        </td>
                        <td>
                          <div className="stack">
                            <span>{Number(t.exit).toFixed(2)}</span>
                            <small>{fmtTime(t.exit_time)}</small>
                          </div>
                        </td>
                        <td>{t.exit_reason}</td>
                        <td>
                          <span className={`badge ${ok ? 'win' : 'loss'}`}>
                            {ok ? 'Successful' : 'Failed'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                  {pageRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty">No trades match this filter.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

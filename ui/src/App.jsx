import { useEffect, useState } from 'react'
import './App.css'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
const STRATEGIES = ['Donchian Breakout', 'EMA Trend Following']
const TIMEFRAMES = ['1h', '15m']

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—'
  const v = Number(n)
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function fmtTime(ms) {
  if (!ms) return '—'
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

export default function App() {
  const [symbol, setSymbol] = useState('SOLUSDT')
  const [strategy, setStrategy] = useState('Donchian Breakout')
  const [timeframe, setTimeframe] = useState('1h')
  const [summary, setSummary] = useState(null)
  const [ranking, setRanking] = useState([])
  const [signals, setSignals] = useState([])
  const [scanMeta, setScanMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scanBusy, setScanBusy] = useState(false)
  const [scanMsg, setScanMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const qs = new URLSearchParams({ symbol, strategy, timeframe })
        const res = await fetch(`/api/results?${qs}`)
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(data.error || `API ${res.status}`)
        setSummary(data.summary)
        setRanking(data.ranking || [])
      } catch (e) {
        if (!cancelled) {
          setSummary(null)
          setError(e.message || 'Failed to load research results')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [symbol, strategy, timeframe])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch('/api/signals')
        const data = await res.json()
        if (cancelled || !res.ok) return
        setSignals(data.signals || [])
        setScanMeta({
          scannedAt: data.scannedAt,
          telegramConfigured: data.telegramConfigured,
          timeframe: data.timeframe,
        })
      } catch {
        /* ignore poll errors */
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
      const res = await fetch('/api/scan?notify=1')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Scan ${res.status}`)
      setSignals(data.signals || [])
      setScanMeta({
        scannedAt: data.scannedAt,
        telegramConfigured: data.telegramConfigured,
        timeframe: data.timeframe,
      })
      setScanMsg(
        data.telegramConfigured
          ? `Scan done · ${data.signalCount} signal(s) · ${data.notifyCount} Telegram sent`
          : `Scan done · ${data.signalCount} signal(s) · Telegram not configured`,
      )
    } catch (e) {
      setScanMsg(e.message || 'Scan failed')
    } finally {
      setScanBusy(false)
    }
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="eyebrow">EMA + Donchian</p>
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
            Timeframe
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t}>{t}</option>
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

      {summary && (
        <section className="stats">
          <article>
            <span>Net return (5y research)</span>
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
            Live signals
            <span>
              {scanMeta?.telegramConfigured ? 'Telegram on' : 'Telegram off'}
              {scanMeta?.scannedAt ? ` · ${fmtTime(Date.parse(scanMeta.scannedAt))}` : ''}
            </span>
          </h2>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Strategy</th>
                <th>Side</th>
                <th>Close</th>
                <th>Bar</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={`${s.symbol}-${s.strategy}-${s.side}-${s.barTime}`}>
                  <td>{s.symbol}</td>
                  <td>{s.strategy}</td>
                  <td>
                    <span className={`side ${s.side === 'LONG' ? 'long' : 'short'}`}>{s.side}</span>
                  </td>
                  <td>{Number(s.close).toFixed(4)}</td>
                  <td>{fmtTime(s.barTime)}</td>
                </tr>
              ))}
              {signals.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">No entry signal on the last closed {scanMeta?.timeframe || '1h'} bar.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {ranking.length > 0 && (
        <section className="table-wrap">
          <div className="table-head">
            <h2>Research ranking <span>EMA + Donchian only</span></h2>
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

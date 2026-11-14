import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { fmtTime } from './fmtTime'
import LiveDesk from './LiveDesk'
import SymbolSearch from './SymbolSearch'
import TradeChartModal from './TradeChartModal'
import { SUPPORTED_TIMEFRAMES } from './timeframes'

const FAVORITE_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'LINKUSDT',
  'AVAXUSDT',
  'ADAUSDT',
]
const STRATEGIES = [
  'Donchian Breakout',
  'EMA Trend Following',
  'Hammer SMA VWAP',
  'VWAP Rejection V1',
]
const TIMEFRAMES = SUPPORTED_TIMEFRAMES
const PERIODS = [
  { id: '7d', label: '7D' },
  { id: '15d', label: '15D' },
  { id: '1m', label: '1M' },
  { id: '3m', label: '3M' },
  { id: '6m', label: '6M' },
  { id: '1y', label: '1Y' },
  { id: '3y', label: '3Y' },
  { id: '5y', label: '5Y' },
]

/** Typed digits → only supported intervals (no invented 40m etc.) */
const DIGIT_TO_TF = {
  1: '1m',
  3: '3m',
  5: '5m',
  15: '15m',
  30: '30m',
  60: '1h',
  120: '2h',
  240: '4h',
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—'
  const v = Number(n)
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function isTypingTarget(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
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
  const [resultSource, setResultSource] = useState(null)
  const [signals, setSignals] = useState([])
  const [recent, setRecent] = useState([])
  const [scanMeta, setScanMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scanBusy, setScanBusy] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [page, setPage] = useState(0)
  const [selectedIdx, setSelectedIdx] = useState(null)
  const [selectedLiveTrade, setSelectedLiveTrade] = useState(null)
  const [symOpen, setSymOpen] = useState(false)
  const [symSeed, setSymSeed] = useState('')
  const [tfHint, setTfHint] = useState('')
  const [testerTab, setTesterTab] = useState('overview')
  const [paperTrades, setPaperTrades] = useState([])
  const [watchQuotes, setWatchQuotes] = useState({})
  const digitBuf = useRef('')
  const digitTimer = useRef(null)
  const pageSize = 50

  const openSymbolSearch = useCallback((seed = '') => {
    setSymSeed(String(seed || '').toUpperCase())
    setSymOpen(true)
  }, [])

  const pickSymbol = useCallback((sym) => {
    setSymbol(sym)
    setSymOpen(false)
    setSymSeed('')
  }, [])

  const applyDigitBuffer = useCallback((buf) => {
    const n = Number(buf)
    if (!Number.isFinite(n) || buf === '') return
    const tf = DIGIT_TO_TF[n]
    if (tf && TIMEFRAMES.includes(tf)) {
      setTimeframe(tf)
      setTfHint(`${tf}`)
    } else {
      setTfHint(`${buf}m not available · use ${TIMEFRAMES.join(', ')}`)
    }
    window.setTimeout(() => setTfHint(''), 2200)
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (symOpen) return
      if (isTypingTarget(e.target)) return
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          openSymbolSearch('')
        }
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        openSymbolSearch('')
        return
      }
      // TradingView: any letter opens symbol search and seeds the query
      if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault()
        openSymbolSearch(e.key)
        return
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        digitBuf.current += e.key
        setTfHint(digitBuf.current)
        if (digitTimer.current) clearTimeout(digitTimer.current)
        digitTimer.current = setTimeout(() => {
          applyDigitBuffer(digitBuf.current)
          digitBuf.current = ''
        }, 550)
        return
      }
      if (e.key === 'Enter' && digitBuf.current) {
        e.preventDefault()
        if (digitTimer.current) clearTimeout(digitTimer.current)
        applyDigitBuffer(digitBuf.current)
        digitBuf.current = ''
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (digitTimer.current) clearTimeout(digitTimer.current)
    }
  }, [symOpen, applyDigitBuffer, openSymbolSearch])

  useEffect(() => {
    let cancelled = false
    async function pollWatch() {
      try {
        const qs = new URLSearchParams({ symbols: FAVORITE_SYMBOLS.join(',') })
        const res = await fetch(`/api/ticker?${qs}`)
        const data = await res.json()
        if (cancelled || !res.ok) return
        const next = {}
        for (const t of data.tickers || []) {
          next[t.symbol] = Number(t.price)
        }
        setWatchQuotes((prev) => {
          const merged = { ...prev }
          for (const [sym, price] of Object.entries(next)) {
            const old = prev[sym]
            merged[sym] = {
              price,
              dir: old?.price == null ? 0 : price > old.price ? 1 : price < old.price ? -1 : (old.dir || 0),
            }
          }
          return merged
        })
      } catch {
        /* ignore */
      }
    }
    pollWatch()
    const t = setInterval(pollWatch, 3000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      setPage(0)
      setSelectedIdx(null)
      setSelectedLiveTrade(null)
      try {
        const qs = new URLSearchParams({ symbol, strategy, timeframe, period })
        const res = await fetch(`/api/results?${qs}`)
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(data.error || `API ${res.status}`)
        setSummary(data.summary)
        setResultSource(data.source || data.summary?.data_source || null)
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
          setResultSource(null)
          setError(e.message || 'Failed to load backtest results')
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
      // Desk Scan: refresh last-24h real signals only — no Telegram history flood
      const res = await fetch('/api/scan?notify=0&desk=1')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Scan ${res.status}`)
      setSignals(data.signals || [])
      setRecent(data.recent || [])
      setScanMeta({
        scannedAt: data.scannedAt,
        telegramConfigured: data.telegramConfigured,
        timeframe: data.timeframe,
        recentDays: data.recentDays,
        recentHours: data.recentHours,
      })
      setScanMsg(
        `Last ${data.recentHours || 24}h · ${data.recentCount || 0} real closed-bar signal(s) on ${data.timeframe || '1h'} watchlist · Telegram live alerts via hourly cron (not Scan)`,
      )
      setTesterTab('signals')
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
  const selectedTrade = selectedLiveTrade || (selectedIdx != null ? tradeList[selectedIdx] : null)
  const canPrev = !selectedLiveTrade && selectedIdx != null && selectedIdx > 0
  const canNext = !selectedLiveTrade && selectedIdx != null && selectedIdx < tradeList.length - 1
  const chartTradeIndex = selectedLiveTrade ? 0 : (selectedIdx ?? 0)
  const chartTradeCount = selectedLiveTrade ? 1 : tradeList.length
  const periodLabel = PERIODS.find((p) => p.id === period)?.label || period

  return (
    <div className="desk">
      <header className="tv-bar">
        <button type="button" className="tv-symbol" onClick={() => openSymbolSearch('')} title="Symbol search — type any letter, / or Ctrl+K">
          <span className="tv-symbol-name">{symbol}</span>
          <span className="tv-symbol-hint">Search</span>
        </button>

        <div className="tv-tfs" role="group" aria-label="Timeframes">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              type="button"
              className={`tv-tf ${timeframe === t ? 'active' : ''}`}
              onClick={() => setTimeframe(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <label className="tv-field">
          <span>Strategy</span>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            {STRATEGIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>

        <div className="tv-periods" role="group" aria-label="Backtest lookback">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`tv-period ${period === p.id ? 'active' : ''}`}
              onClick={() => setPeriod(p.id)}
              title={periodCards[p.id] ? `${fmtPct(periodCards[p.id].net_return_pct)} · ${periodCards[p.id].trades ?? 0} trades` : p.label}
            >
              {p.label}
            </button>
          ))}
        </div>

        <button type="button" className="tv-scan" disabled={scanBusy} onClick={triggerScan}>
          {scanBusy ? 'Scanning…' : 'Scan'}
        </button>
      </header>

      {tfHint && <div className="tv-toast">{tfHint}</div>}
      {error && <div className="banner error">{error}</div>}
      {loading && !summary && !error && (
        <div className="banner">Fetching candles + running backtest…</div>
      )}
      {!loading && resultSource === 'on_demand' && (
        <div className="banner quiet">On-demand backtest · exchange OHLCV</div>
      )}
      {scanMsg && <div className="banner">{scanMsg}</div>}

      <div className="tv-workspace">
        <main className="tv-chart-col">
          <LiveDesk
            symbol={symbol}
            timeframe={timeframe}
            strategy={strategy}
            onPaperUpdate={(body) => setPaperTrades(body?.trade_list || [])}
            onSelectTrade={(t) => {
              setSelectedIdx(null)
              setSelectedLiveTrade(t)
              setTesterTab('recent')
            }}
          />
        </main>

        <aside className="tv-watch">
          <div className="tv-watch-head">
            <h2>Watchlist</h2>
            <button type="button" onClick={() => openSymbolSearch('')}>+</button>
          </div>
          <div className="tv-watch-cols">
            <span>Symbol</span>
            <span>Last</span>
          </div>
          <ul className="tv-watch-list">
            {FAVORITE_SYMBOLS.map((s) => {
              const q = watchQuotes[s]
              const dirClass = q?.dir > 0 ? 'up' : q?.dir < 0 ? 'down' : ''
              return (
                <li key={s}>
                  <button
                    type="button"
                    className={s === symbol ? 'active' : ''}
                    onClick={() => setSymbol(s)}
                  >
                    <strong>{s.replace('USDT', '')}</strong>
                    <span className={`tv-watch-px ${dirClass}`}>
                      {q?.price != null ? Number(q.price).toPrecision(6) : '…'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="tv-watch-detail">
            <span className="muted">Selected</span>
            <strong>{symbol}</strong>
            <span>{strategy}</span>
            <span className="muted">{timeframe} · lookback {periodLabel}</span>
          </div>
        </aside>
      </div>

      <section className="tv-tester">
        <div className="tv-tester-head">
          <div className="tv-tester-tabs">
            <button
              type="button"
              className={testerTab === 'overview' ? 'active' : ''}
              onClick={() => setTesterTab('overview')}
            >
              Overview
            </button>
            <button
              type="button"
              className={testerTab === 'recent' ? 'active' : ''}
              onClick={() => setTesterTab('recent')}
            >
              Recent ({paperTrades.length})
            </button>
            <button
              type="button"
              className={testerTab === 'trades' ? 'active' : ''}
              onClick={() => setTesterTab('trades')}
            >
              Trades ({tradeList.length})
            </button>
            <button
              type="button"
              className={testerTab === 'signals' ? 'active' : ''}
              onClick={() => setTesterTab('signals')}
            >
              Signals ({(recent.length ? recent : signals).length})
            </button>
            {ranking.length > 0 && (
              <button
                type="button"
                className={testerTab === 'ranking' ? 'active' : ''}
                onClick={() => setTesterTab('ranking')}
              >
                Ranking
              </button>
            )}
          </div>
          <div className="tv-tester-meta">
            <span>{strategy}</span>
            <span>{symbol}</span>
            <span>{timeframe}</span>
            <span>{periodLabel}</span>
            {loading && <span className="muted">updating…</span>}
          </div>
        </div>

        {testerTab === 'overview' && (
          <div className="tv-overview">
            <div className="tv-kpis">
              <article>
                <span>Net return</span>
                <strong className={summary?.net_return_pct >= 0 ? 'up' : 'down'}>
                  {fmtPct(summary?.net_return_pct)}
                </strong>
              </article>
              <article>
                <span>Max drawdown</span>
                <strong className="down">{fmtPct(summary?.max_dd_pct)}</strong>
              </article>
              <article>
                <span>Profitable trades</span>
                <strong>
                  {summary?.success_rate_pct != null ? `${summary.success_rate_pct}%` : '—'}
                </strong>
              </article>
              <article>
                <span>Profit factor</span>
                <strong>
                  {summary?.profit_factor != null ? Number(summary.profit_factor).toFixed(3) : '—'}
                </strong>
              </article>
              <article>
                <span>Trades</span>
                <strong>{summary?.trades?.toLocaleString?.() ?? summary?.trades ?? '—'}</strong>
              </article>
              <article>
                <span>Win / Loss</span>
                <strong>
                  <span className="up">{summary?.successful ?? '—'}</span>
                  {' / '}
                  <span className="down">{summary?.failed ?? '—'}</span>
                </strong>
              </article>
            </div>
            {Object.keys(periodCards).length > 0 && (
              <div className="tv-period-strip">
                {PERIODS.map((p) => {
                  const c = periodCards[p.id]
                  if (!c) return null
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`tv-period-chip ${period === p.id ? 'active' : ''}`}
                      onClick={() => setPeriod(p.id)}
                    >
                      <span>{p.label}</span>
                      <strong className={c.net_return_pct >= 0 ? 'up' : 'down'}>
                        {fmtPct(c.net_return_pct)}
                      </strong>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {testerTab === 'recent' && (
          <div className="tv-table-pane">
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
                  {[...paperTrades].reverse().map((t, i) => {
                    const ok = t.outcome === 'successful'
                    return (
                      <tr
                        key={`${t.entry_time}-${t.exit_time}-${i}`}
                        className={`${ok ? 'row-win' : 'row-loss'} trade-row`}
                        onClick={() => {
                          setSelectedIdx(null)
                          setSelectedLiveTrade(t)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setSelectedIdx(null)
                            setSelectedLiveTrade(t)
                          }
                        }}
                        tabIndex={0}
                        role="button"
                      >
                        <td>{paperTrades.length - i}</td>
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
                  {paperTrades.length === 0 && (
                    <tr><td colSpan={7} className="empty">No recent paper trades in the live window yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {testerTab === 'trades' && (
          <div className="tv-table-pane">
            <div className="pager">
              <button type="button" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <span>{page + 1} / {pageCount}</span>
              <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
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
                    const absIdx = page * pageSize + i
                    return (
                      <tr
                        key={`${t.entry_time}-${i}`}
                        className={`${ok ? 'row-win' : 'row-loss'} trade-row${selectedIdx === absIdx ? ' selected' : ''}`}
                        onClick={() => {
                          setSelectedLiveTrade(null)
                          setSelectedIdx(absIdx)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setSelectedLiveTrade(null)
                            setSelectedIdx(absIdx)
                          }
                        }}
                        tabIndex={0}
                        role="button"
                      >
                        <td>{absIdx + 1}</td>
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
          </div>
        )}

        {testerTab === 'signals' && (
          <div className="tv-table-pane">
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
                      <td colSpan={6} className="empty">
                        No real closed-bar signals in the last {scanMeta?.recentHours || 24}h on watchlist
                        {scanMeta?.timeframe ? ` · ${scanMeta.timeframe}` : ''}
                        {scanMeta?.telegramConfigured ? ' · Telegram live via hourly cron' : ' · Telegram not configured'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {testerTab === 'ranking' && ranking.length > 0 && (
          <div className="tv-table-pane">
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
          </div>
        )}
      </section>

      <SymbolSearch
        open={symOpen}
        favorites={FAVORITE_SYMBOLS}
        value={symbol}
        initialQuery={symSeed}
        onPick={pickSymbol}
        onClose={() => {
          setSymOpen(false)
          setSymSeed('')
        }}
      />

      {selectedTrade && (
        <TradeChartModal
          trade={selectedTrade}
          symbol={symbol}
          timeframe={timeframe}
          strategy={strategy}
          tradeIndex={chartTradeIndex}
          tradeCount={chartTradeCount}
          onClose={() => {
            setSelectedIdx(null)
            setSelectedLiveTrade(null)
          }}
          onPrev={canPrev ? () => setSelectedIdx((i) => i - 1) : undefined}
          onNext={canNext ? () => setSelectedIdx((i) => i + 1) : undefined}
        />
      )}
    </div>
  )
}

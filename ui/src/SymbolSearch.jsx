import { useEffect, useMemo, useRef, useState } from 'react'

const EXTRA_HINTS = [
  'OPUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'SUIUSDT', 'MATICUSDT',
  'DOTUSDT', 'ATOMUSDT', 'LTCUSDT', 'UNIUSDT', 'AAVEUSDT', 'FILUSDT',
  'XAUUSDT', 'XAGUSDT',
]

/**
 * TradingView-style symbol search.
 * mode: 'pick' = open chart; 'add' = add to watchlist (+ button).
 */
export default function SymbolSearch({
  open,
  favorites,
  value,
  initialQuery = '',
  mode = 'pick',
  onPick,
  onAdd,
  onClose,
}) {
  const [q, setQ] = useState('')
  const [remote, setRemote] = useState([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    setQ(String(initialQuery || '').toUpperCase())
    const t = setTimeout(() => {
      inputRef.current?.focus()
      const el = inputRef.current
      if (el) {
        const n = el.value.length
        el.setSelectionRange(n, n)
      }
    }, 30)
    return () => clearTimeout(t)
  }, [open, initialQuery])

  useEffect(() => {
    if (!open) return undefined
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return undefined
    const raw = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    let cancelled = false
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        const qs = raw ? `?q=${encodeURIComponent(raw)}` : ''
        const res = await fetch(`/api/symbols${qs}`)
        const data = await res.json()
        if (cancelled || !res.ok) return
        setRemote((data.symbols || []).map((s) => s.symbol || s))
      } catch {
        if (!cancelled) setRemote([])
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, q])

  const pool = useMemo(() => {
    const set = new Set([...(favorites || []), ...EXTRA_HINTS, ...remote])
    if (value) set.add(value)
    return [...set]
  }, [favorites, value, remote])

  const results = useMemo(() => {
    const raw = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!raw) return pool.slice(0, 30)
    const scored = pool.filter(
      (s) => s.includes(raw) || s.replace('USDT', '').includes(raw),
    )
    const custom = raw.endsWith('USDT') ? raw : `${raw}USDT`
    if (!scored.includes(custom) && raw.length >= 2) scored.unshift(custom)
    return scored.slice(0, 30)
  }, [q, pool])

  if (!open) return null

  const isAdd = mode === 'add'

  return (
    <div className="sym-modal" role="dialog" aria-modal="true" aria-label="Symbol search">
      <button type="button" className="sym-backdrop" aria-label="Close" onClick={onClose} />
      <div className="sym-panel">
        <div className="sym-head">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value.toUpperCase())}
            placeholder={isAdd ? 'Add Binance USDT-M (BTC, XAU, EUR…)' : 'Open symbol (BTC, ETH, XAU…)'}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) {
                e.preventDefault()
                if (isAdd) onAdd?.(results[0])
                else onPick?.(results[0])
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <p className="sym-mode-hint">
          {isAdd ? 'Add to watchlist · Telegram scans 5m / 15m / 1h' : 'Open on chart'}
          {busy ? ' · searching…' : ''}
        </p>
        <ul className="sym-list">
          {results.map((s) => {
            const inList = (favorites || []).includes(s)
            return (
              <li key={s}>
                <button
                  type="button"
                  className={s === value ? 'active' : ''}
                  onClick={() => {
                    if (isAdd) onAdd?.(s)
                    else onPick?.(s)
                  }}
                >
                  <strong>{s}</strong>
                  <span>{inList ? 'WATCHLIST' : 'BINANCE · USDT-M'}{isAdd && !inList ? ' · ADD' : ''}</span>
                </button>
              </li>
            )
          })}
          {results.length === 0 && <li className="sym-empty">No matches</li>}
        </ul>
      </div>
    </div>
  )
}

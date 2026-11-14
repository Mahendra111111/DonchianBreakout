import { useEffect, useMemo, useRef, useState } from 'react'

const EXTRA_HINTS = [
  'OPUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'SUIUSDT', 'MATICUSDT',
  'DOTUSDT', 'ATOMUSDT', 'LTCUSDT', 'UNIUSDT', 'AAVEUSDT', 'FILUSDT',
]

/**
 * TradingView-style symbol search overlay.
 * Typing any letter on the desk opens this and seeds `initialQuery`.
 */
export default function SymbolSearch({
  open,
  favorites,
  value,
  initialQuery = '',
  onPick,
  onClose,
}) {
  const [q, setQ] = useState('')
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

  const pool = useMemo(() => {
    const set = new Set([...(favorites || []), ...EXTRA_HINTS])
    if (value) set.add(value)
    return [...set].sort()
  }, [favorites, value])

  const results = useMemo(() => {
    const raw = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!raw) return pool.slice(0, 24)
    const scored = pool
      .map((s) => {
        const hit = s.includes(raw) || s.replace('USDT', '').includes(raw)
        return hit ? s : null
      })
      .filter(Boolean)
    const custom = raw.endsWith('USDT') ? raw : `${raw}USDT`
    if (!scored.includes(custom) && raw.length >= 2) scored.unshift(custom)
    return scored.slice(0, 24)
  }, [q, pool])

  if (!open) return null

  return (
    <div className="sym-modal" role="dialog" aria-modal="true" aria-label="Symbol search">
      <button type="button" className="sym-backdrop" aria-label="Close" onClick={onClose} />
      <div className="sym-panel">
        <div className="sym-head">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value.toUpperCase())}
            placeholder="Type symbol (BTC, ETH, SOL…)"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) {
                e.preventDefault()
                onPick(results[0])
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="sym-list">
          {results.map((s) => (
            <li key={s}>
              <button
                type="button"
                className={s === value ? 'active' : ''}
                onClick={() => onPick(s)}
              >
                <strong>{s}</strong>
                <span>BINANCE · USDT-M</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="sym-empty">No matches</li>}
        </ul>
      </div>
    </div>
  )
}

/** Browser WebSocket to public futures kline streams (Binance → Bybit). */

const TF_BINANCE = { '15m': '15m', '1h': '1h' }
const TF_BYBIT = { '15m': '15', '1h': '60' }

function parseBinanceKline(msg) {
  const k = msg?.k
  if (!k) return null
  return {
    time: Math.floor(Number(k.t) / 1000),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closed: Boolean(k.x),
    source: 'binance',
  }
}

function parseBybitKline(msg) {
  const row = msg?.data?.[0]
  if (!row || msg.topic?.indexOf('kline.') !== 0) return null
  return {
    time: Math.floor(Number(row.start) / 1000),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    closed: row.confirm === true,
    source: 'bybit',
  }
}

function connectBinance(symbol, timeframe, onCandle, onStatus) {
  const tf = TF_BINANCE[timeframe]
  if (!tf) throw new Error(`Unsupported TF ${timeframe}`)
  const stream = `${symbol.toLowerCase()}@kline_${tf}`
  const url = `wss://fstream.binance.com/ws/${stream}`
  const ws = new WebSocket(url)
  let alive = true

  ws.onopen = () => onStatus?.({ connected: true, source: 'binance' })
  ws.onmessage = (ev) => {
    try {
      const candle = parseBinanceKline(JSON.parse(ev.data))
      if (candle) onCandle(candle)
    } catch {
      /* ignore bad frames */
    }
  }
  ws.onerror = () => onStatus?.({ connected: false, source: 'binance', error: true })
  ws.onclose = () => {
    if (alive) onStatus?.({ connected: false, source: 'binance' })
  }

  return () => {
    alive = false
    try { ws.close() } catch { /* */ }
  }
}

function connectBybit(symbol, timeframe, onCandle, onStatus) {
  const tf = TF_BYBIT[timeframe]
  if (!tf) throw new Error(`Unsupported TF ${timeframe}`)
  const url = 'wss://stream.bybit.com/v5/public/linear'
  const ws = new WebSocket(url)
  let alive = true
  const topic = `kline.${tf}.${symbol.toUpperCase()}`

  ws.onopen = () => {
    ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }))
    onStatus?.({ connected: true, source: 'bybit' })
  }
  ws.onmessage = (ev) => {
    try {
      const candle = parseBybitKline(JSON.parse(ev.data))
      if (candle) onCandle(candle)
    } catch {
      /* ignore */
    }
  }
  ws.onerror = () => onStatus?.({ connected: false, source: 'bybit', error: true })
  ws.onclose = () => {
    if (alive) onStatus?.({ connected: false, source: 'bybit' })
  }

  return () => {
    alive = false
    try { ws.close() } catch { /* */ }
  }
}

/**
 * Prefer Binance; if it errors/closes quickly, fall back to Bybit.
 * Returns disconnect().
 */
export function subscribeLiveKlines(symbol, timeframe, onCandle, onStatus) {
  let disconnect = () => {}
  let switched = false
  let opened = false

  const failTimer = setTimeout(() => {
    if (!opened && !switched) {
      switched = true
      disconnect()
      disconnect = connectBybit(symbol, timeframe, onCandle, onStatus)
    }
  }, 4000)

  disconnect = connectBinance(symbol, timeframe, onCandle, (st) => {
    if (st.connected) {
      opened = true
      clearTimeout(failTimer)
    }
    if (!st.connected && opened && !switched) {
      switched = true
      clearTimeout(failTimer)
      disconnect()
      disconnect = connectBybit(symbol, timeframe, onCandle, onStatus)
      return
    }
    onStatus?.(st)
  })

  return () => {
    clearTimeout(failTimer)
    disconnect()
  }
}

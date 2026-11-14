/** Browser WebSocket: live kline + 1s mark/ticker price (Binance → Bybit, auto-reconnect). */

const TF_BINANCE = { '5m': '5m', '15m': '15m', '1h': '1h' }
const TF_BYBIT = { '5m': '5', '15m': '15', '1h': '60' }

/**
 * Normalized events:
 * - { type:'kline', time, open, high, low, close, volume, closed, source }
 * - { type:'tick', price, source }
 */

function connectBinance(symbol, timeframe, onEvent, onStatus) {
  const tf = TF_BINANCE[timeframe]
  if (!tf) throw new Error(`Unsupported TF ${timeframe}`)
  const sym = symbol.toLowerCase()
  // Combined: forming candle + mark price every 1s (TradingView-like motion)
  const url =
    `wss://fstream.binance.com/stream?streams=${sym}@kline_${tf}/${sym}@markPrice@1s`
  const ws = new WebSocket(url)
  let alive = true

  ws.onopen = () => onStatus?.({ connected: true, source: 'binance' })
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      const data = msg.data || msg
      if (data.e === 'kline' && data.k) {
        const k = data.k
        onEvent({
          type: 'kline',
          time: Math.floor(Number(k.t) / 1000),
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
          closed: Boolean(k.x),
          source: 'binance',
        })
        return
      }
      if (data.e === 'markPriceUpdate' && data.p != null) {
        onEvent({ type: 'tick', price: Number(data.p), source: 'binance' })
      }
    } catch {
      /* ignore */
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

function connectBybit(symbol, timeframe, onEvent, onStatus) {
  const tf = TF_BYBIT[timeframe]
  if (!tf) throw new Error(`Unsupported TF ${timeframe}`)
  const sym = symbol.toUpperCase()
  const url = 'wss://stream.bybit.com/v5/public/linear'
  const ws = new WebSocket(url)
  let alive = true
  const klineTopic = `kline.${tf}.${sym}`
  const tickTopic = `tickers.${sym}`

  ws.onopen = () => {
    ws.send(JSON.stringify({ op: 'subscribe', args: [klineTopic, tickTopic] }))
    onStatus?.({ connected: true, source: 'bybit' })
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.topic === klineTopic && msg.data?.[0]) {
        const row = msg.data[0]
        onEvent({
          type: 'kline',
          time: Math.floor(Number(row.start) / 1000),
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
          closed: row.confirm === true,
          source: 'bybit',
        })
        return
      }
      if (msg.topic === tickTopic) {
        const row = Array.isArray(msg.data) ? msg.data[0] : msg.data
        const price = Number(row?.lastPrice ?? row?.markPrice)
        if (Number.isFinite(price)) onEvent({ type: 'tick', price, source: 'bybit' })
      }
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
 * Binance first, Bybit fallback, then reconnect loop.
 * Returns disconnect().
 */
export function subscribeLiveStream(symbol, timeframe, onEvent, onStatus) {
  let stopped = false
  let disconnect = () => {}
  let attempt = 0
  let timer = null
  let opened = false
  let usingBybit = false

  function start(provider) {
    if (stopped) return
    opened = false
    const connect = provider === 'bybit' ? connectBybit : connectBinance
    disconnect = connect(symbol, timeframe, onEvent, (st) => {
      if (st.connected) {
        opened = true
        attempt = 0
        onStatus?.(st)
        return
      }
      onStatus?.(st)
      if (stopped) return
      // Fail over Binance → Bybit once, then reconnect with backoff
      if (!usingBybit && provider === 'binance') {
        usingBybit = true
        disconnect()
        start('bybit')
        return
      }
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4))
      attempt += 1
      timer = setTimeout(() => start(usingBybit ? 'bybit' : 'binance'), delay)
    })

    // If Binance never opens, switch to Bybit
    if (provider === 'binance') {
      timer = setTimeout(() => {
        if (stopped || opened || usingBybit) return
        usingBybit = true
        disconnect()
        start('bybit')
      }, 3500)
    }
  }

  start('binance')

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    disconnect()
  }
}

/** @deprecated use subscribeLiveStream */
export function subscribeLiveKlines(symbol, timeframe, onCandle, onStatus) {
  return subscribeLiveStream(
    symbol,
    timeframe,
    (ev) => {
      if (ev.type === 'kline') onCandle(ev)
    },
    onStatus,
  )
}

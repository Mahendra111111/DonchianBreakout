/** Telegram Bot API helpers. */

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
}

export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' }
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) {
    return { ok: false, status: res.status, body }
  }
  return { ok: true, message_id: body.result?.message_id }
}

function fmtWhen(ms) {
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

function px(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1000) return v.toFixed(2)
  if (Math.abs(v) >= 1) return v.toFixed(4)
  return v.toFixed(6)
}

/**
 * Trade card only: symbol, side, signal close time, entry, stop, target.
 */
export function formatSignalMessage(alert) {
  const side = alert.side === 'LONG' || alert.side === 1 ? 'LONG' : 'SHORT'
  const arrow = side === 'LONG' ? '🟢 LONG' : '🔴 SHORT'
  const entry = alert.entry ?? alert.close
  const stop = alert.stop
  const target = alert.target
  // Prefer candle close time (open + tf) so "2.30am open" is not read as trade end
  const signalCloseMs = alert.signalCloseTime ?? alert.barTime
  const entryMs = alert.entryTime ?? alert.barTime

  const lines = [
    `<b>${arrow}</b>  <b>${alert.symbol}</b>  ${alert.timeframe || '1h'}`,
    `Signal: ${fmtWhen(signalCloseMs)}`,
    `Entry: <code>${px(entry)}</code>  (${fmtWhen(entryMs)})`,
    `Stop: <code>${px(stop)}</code>`,
    `Target: <code>${px(target)}</code>`,
  ]
  if (alert.strategy) lines.push(`Setup: ${alert.strategy}`)
  return lines.join('\n')
}

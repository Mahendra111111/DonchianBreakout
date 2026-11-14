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

export function formatSignalMessage(alert) {
  const arrow = alert.side === 'LONG' ? '🟢 LONG' : '🔴 SHORT'
  const rr =
    alert.strategy === 'Hammer SMA VWAP' || alert.strategy === 'VWAP Rejection V1'
      ? '2.0R'
      : '1.5R'
  const kind = alert.kind === 'recent' ? 'Recent opportunity' : 'Live opportunity'
  const lines = [
    `<b>${kind} record</b>`,
    `${arrow} · <b>${alert.symbol}</b> · ${alert.timeframe || '1h'}`,
    `Strategy: <b>${alert.strategy}</b>`,
    `Side: <code>${alert.side}</code>`,
    `Close: <code>${Number(alert.close).toFixed(4)}</code>`,
    `Bar time: ${fmtWhen(alert.barTime)}`,
    alert.strategy === 'VWAP Rejection V1'
      ? `Stop: rejection extreme · Take profit: ${rr}`
      : `Stop: 1.5 ATR · Take profit: ${rr}`,
    `Note: research alert only — not an order`,
  ]
  if (alert.index != null) lines.push(`Bar index: <code>${alert.index}</code>`)
  return lines.join('\n')
}

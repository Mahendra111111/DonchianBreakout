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

export function formatSignalMessage({ symbol, timeframe, strategy, side, close, barTime }) {
  const when = new Date(barTime).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
  const arrow = side === 'LONG' ? '🟢 LONG' : '🔴 SHORT'
  return [
    `<b>Crypto signal</b>`,
    `${arrow} · <b>${symbol}</b> · ${timeframe}`,
    `Strategy: <b>${strategy}</b>`,
    `Close: <code>${close}</code>`,
    `Bar: ${when}`,
    `Stop: 1.5 ATR · TP: 1.5R (research defaults)`,
  ].join('\n')
}

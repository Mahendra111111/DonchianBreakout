/** Persistent dedupe for Telegram trade alerts. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dedupeFile = process.env.VERCEL
  ? path.join('/tmp', 'signal_sent.json')
  : path.join(root, 'exports', 'signal_sent.json')

export async function loadSent() {
  try {
    const raw = JSON.parse(await readFile(dedupeFile, 'utf8'))
    const cutoff = Date.now() - 48 * 60 * 60_000
    const map = {}
    for (const [k, ts] of Object.entries(raw || {})) {
      if (Number(ts) >= cutoff) map[k] = Number(ts)
    }
    return map
  } catch {
    return {}
  }
}

export async function saveSent(map) {
  try {
    await mkdir(path.dirname(dedupeFile), { recursive: true })
    await writeFile(dedupeFile, JSON.stringify(map), 'utf8')
  } catch {
    /* ignore */
  }
}

export function freshMinutesMs() {
  return Number(process.env.SIGNAL_FRESH_MINUTES || 18) * 60_000
}

/** True if timestamp is within the live alert lag window. */
export function isWithinFreshWindow(tsMs, nowMs = Date.now()) {
  const t = Number(tsMs)
  if (!Number.isFinite(t)) return false
  const age = nowMs - t
  return age >= 0 && age <= freshMinutesMs()
}

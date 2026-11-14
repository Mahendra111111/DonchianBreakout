/** Short-lived backtest result cache (memory + optional disk). */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TTL_MS = 60 * 60_000
const mem = new Map()
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const diskDir = path.join(root, 'exports', 'backtest_cache')

function keyOf(parts) {
  return parts.join('|')
}

export function cacheKey({ strategy, symbol, timeframe, period, from, to }) {
  return keyOf([
    strategy,
    symbol,
    timeframe,
    period || '',
    from != null ? String(from) : '',
    to != null ? String(to) : '',
  ])
}

function diskPath(key) {
  const safe = key.replace(/[^a-zA-Z0-9._|-]+/g, '_')
  return path.join(diskDir, `${safe}.json`)
}

export async function cacheGet(key) {
  const hit = mem.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  try {
    const raw = await readFile(diskPath(key), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Date.now() - parsed.at < TTL_MS) {
      mem.set(key, parsed)
      return parsed.value
    }
  } catch {
    /* miss */
  }
  return null
}

export async function cacheSet(key, value) {
  const entry = { at: Date.now(), value }
  mem.set(key, entry)
  try {
    await mkdir(diskDir, { recursive: true })
    await writeFile(diskPath(key), JSON.stringify(entry), 'utf8')
  } catch {
    /* disk optional on serverless */
  }
}

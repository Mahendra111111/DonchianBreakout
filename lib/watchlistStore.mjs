/** Server watchlist for Telegram scans (memory + optional disk). */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYMBOLS } from './strategies.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const filePath = process.env.VERCEL
  ? path.join('/tmp', 'watchlist.json')
  : path.join(root, 'exports', 'watchlist.json')

const g = globalThis

function normalize(list) {
  const out = []
  const seen = new Set()
  for (const raw of list || []) {
    let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!s) continue
    if (!s.endsWith('USDT')) s = `${s}USDT`
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out.slice(0, 40)
}

export async function readWatchlist() {
  if (Array.isArray(g.__deskWatchlist) && g.__deskWatchlist.length) {
    return [...g.__deskWatchlist]
  }
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    const list = normalize(raw.symbols || raw)
    if (list.length) {
      g.__deskWatchlist = list
      return list
    }
  } catch {
    /* */
  }
  return [...SYMBOLS]
}

export async function writeWatchlist(symbols) {
  const list = normalize(symbols)
  if (!list.length) throw new Error('watchlist empty')
  g.__deskWatchlist = list
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify({ symbols: list, updated: new Date().toISOString() }), 'utf8')
  } catch {
    /* /tmp or disk may fail — memory still holds list for this instance */
  }
  return list
}

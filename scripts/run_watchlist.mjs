import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWatchlist, writeWatchlist } from '../lib/watchlistStore.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] == null) process.env[key] = val
  }
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=')
    return i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a, '1']
  }),
)

try {
  if (args.set) {
    const symbols = String(args.set).split(',').map((s) => s.trim()).filter(Boolean)
    const list = await writeWatchlist(symbols)
    process.stdout.write(JSON.stringify({ ok: true, symbols: list }))
  } else {
    const symbols = await readWatchlist()
    process.stdout.write(JSON.stringify({ symbols }))
  }
} catch (e) {
  console.error(String(e.message || e))
  process.exit(1)
}

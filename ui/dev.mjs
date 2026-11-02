import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const uiDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(uiDir, '..')

const children = []

function start(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  })
  children.push(child)
  child.on('exit', (code, signal) => {
    if (signal) return
    // If either process dies, stop the other.
    stop(code ?? 1)
  })
  return child
}

function stop(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exit(code)
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

console.log('Starting Python live backtest API (Supabase market data)…')
start('python', ['-u', 'api_server.py'], rootDir)

console.log('Starting Vite UI…')
start('npx', ['vite', '--host', '127.0.0.1', '--port', '5173'], uiDir)

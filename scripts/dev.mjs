#!/usr/bin/env node
/**
 * Spustí API i web najednou a přeposílá jejich výstup s prefixem.
 *   npm run dev
 * Ctrl+C ukončí oba procesy.
 */
import { spawn } from 'node:child_process'

const targets = [
  { name: 'api', color: '\x1b[36m', cmd: 'npm', args: ['run', 'dev', '--workspace', '@ceo/api'] },
  { name: 'web', color: '\x1b[35m', cmd: 'npm', args: ['run', 'dev', '--workspace', '@ceo/web'] },
]
const RESET = '\x1b[0m'
const kids = []

for (const t of targets) {
  const p = spawn(t.cmd, t.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const tag = (chunk) => String(chunk)
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => `${t.color}[${t.name}]${RESET} ${l}\n`)
    .join('')
  p.stdout.on('data', (c) => process.stdout.write(tag(c)))
  p.stderr.on('data', (c) => process.stderr.write(tag(c)))
  p.on('exit', (code) => {
    console.log(`${t.color}[${t.name}]${RESET} skončil s kódem ${code}`)
    shutdown(code ?? 0)
  })
  kids.push(p)
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const k of kids) if (!k.killed) k.kill('SIGTERM')
  setTimeout(() => process.exit(code), 300)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

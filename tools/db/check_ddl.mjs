import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

// Stavový automat: line/block comment, 'string' s '' escapem, $tag$ dollar-quote.
function split(sql) {
  const out = []; let buf = ''; let i = 0; const n = sql.length
  let dollar = null
  while (i < n) {
    const c = sql[i], c2 = sql.slice(i, i + 2)
    if (dollar) {                       // uvnitř $$ bloku
      if (sql.startsWith(dollar, i)) { buf += dollar; i += dollar.length; dollar = null }
      else { buf += c; i++ }
      continue
    }
    if (c2 === '--') {                  // line comment
      const j = sql.indexOf('\n', i); const e = j === -1 ? n : j + 1
      buf += sql.slice(i, e); i = e; continue
    }
    if (c2 === '/*') {                  // block comment
      const j = sql.indexOf('*/', i + 2); const e = j === -1 ? n : j + 2
      buf += sql.slice(i, e); i = e; continue
    }
    if (c === "'") {                    // string literal
      let j = i + 1
      while (j < n) { if (sql[j] === "'") { if (sql[j+1] === "'") j += 2; else { j++; break } } else j++ }
      buf += sql.slice(i, j); i = j; continue
    }
    if (c === '$') {                    // dollar-quote start
      const m = /^\$([A-Za-z_][\w$]*)?\$/.exec(sql.slice(i))
      if (m) { dollar = m[0]; buf += m[0]; i += m[0].length; continue }
    }
    if (c === ';') { if (buf.trim()) out.push(buf.trim()); buf = ''; i++; continue }
    buf += c; i++
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

const sql = readFileSync('db/migrations/0001_init.sql', 'utf8')
const stmts = split(sql)
console.log(`rozděleno na ${stmts.length} statementů`)
const db = await PGlite.create()
let ok = 0; const errs = []
for (const [k, s] of stmts.entries()) {
  const flat = s.replace(/\s+/g, ' ')
  if (/^\s*--/.test(s) && !/[^-\s]/.test(s.replace(/--[^\n]*/g, ''))) { ok++; continue } // jen komentář
  try { await db.query(s); ok++ }
  catch (e) { errs.push({ n: k + 1, code: e.code, msg: e.message, sql: flat.slice(0, 160) }) }
}
for (const e of errs) console.log(`\n❌ #${e.n} [${e.code}] ${e.msg}\n   ${e.sql}`)
console.log(`\n=== OK ${ok} / SELHALO ${errs.length} ===`)

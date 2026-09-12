/**
 * Připojení k databázi.
 *
 * DEV:  PGlite — skutečný PostgreSQL 18 zkompilovaný do WASM, běží v procesu.
 *       Žádný Docker, žádný externí server. Spolkne celé DDL včetně enumů,
 *       plpgsql triggerů a DEFERRABLE CONSTRAINT TRIGGERů.
 * PROD: přes `DATABASE_URL` na skutečný Postgres (viz TODO v server.ts).
 *
 * Důvod, proč PGlite a ne SQLite: schéma používá postgres-only konstrukce,
 * na kterých stojí správnost hry — CHECK constrainty, deferred trigger
 * vynucující Σ legs = 0, partial indexy, NULLS NOT DISTINCT. Na SQLite bychom
 * testovali něco jiného, než co poběží v produkci.
 */
import { PGlite, type PGlite as PGliteType, type Transaction } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MIGRATION_PATH = resolve(HERE, '../../../db/migrations/0001_init.sql')

/** Settable pro rychlý zápis dotazů. */
export type Db = PGliteType | Transaction

let db: PGliteType | null = null

export async function getDb(): Promise<PGliteType> {
  if (db) return db

  // PGDATA set → persistentní adresář (data přežijí restart).
  // Výchozí je in-memory: každý start je čistý svět, migrace + seed trvají < 1 s.
  const dataDir = process.env.PGDATA
  db = dataDir ? new PGlite(dataDir) : new PGlite()

  const migrated = await isMigrated(db)
  if (!migrated) {
    const sql = await readFile(MIGRATION_PATH, 'utf8')
    // exec() spustí celý skript (včetně BEGIN/COMMIT) jako dávku
    await db.exec(sql)
    console.log(`  ✅ migrace 0001_init.sql aplikována (${countStatements(sql)} statementů)`)
  } else {
    console.log('  ℹ️  schéma už existuje, migrace přeskočena')
    // Persistentní PGDATA z dřívějška může znát jen starší schéma — nové
    // tabule doplňujeme idempotentně při každém startu.
    await db.exec(await readFile(resolve(HERE, '../../../db/migrations/0002_ensure.sql'), 'utf8'))
  }
  return db
}

async function isMigrated(d: PGliteType): Promise<boolean> {
  const r = await d.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'journal_entries'`,
  )
  return (r.rows[0]?.c ?? 0) > 0
}

function countStatements(sql: string): number {
  return sql.split(';').filter((s) => s.trim().length > 0 && !/^\s*--/.test(s)).length
}

/** Jedna SQL transakce. Deferred constraint triggery vyhodnotí až při COMMIT. */
export async function tx<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
  const d = await getDb()
  return d.transaction<T>((t) => fn(t) as Promise<T>)
}

/** Jednořádkový dotaz. */
export async function one<T>(d: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await d.query<T>(sql, params)
  return r.rows[0] ?? null
}

export async function many<T>(d: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await d.query<T>(sql, params)
  return r.rows
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close()
    db = null
  }
}

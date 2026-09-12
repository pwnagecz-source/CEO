/**
 * Fáze F+ — FEED UDÁLOSTÍ SVĚTA.
 *
 * Živý svět běží na serveru (NPC expanze, dokončené výzkumy, level-upy,
 * splněné zakázky), ale hráč z toho v UI neviděl nic — jen čísla, která se
 * hýbou. `world_events` je append-only páska toho, co se ve světě stalo:
 * UI ji polluje a vykresluje jako „Svět se hýbe“.
 *
 * Žádná ekonomika, žádná konzistence navíc — kdyby tabulka rostla příliš,
 * maže se po tisíci řádcích (keepRecent). Texty se skládají CZ na serveru,
 * aby klient nemusel znát jména firem ani výzkumů.
 */
import type { Db } from './db.ts'
import { many, one } from './db.ts'

export type WorldEvent = {
  id: number; kind: string; text: string; simHour: number; at: string
}

/** Zapíše jednu událost; `keepRecent` drží tabulku malou. */
export async function logEvent(
  d: Db, worldId: number, kind: string, text: string, simHour = 0,
): Promise<void> {
  await d.query(
    `INSERT INTO world_events (world_id, sim_hour, kind, text) VALUES ($1,$2,$3,$4)`,
    [worldId, simHour, kind, text],
  )
  await d.query(
    `DELETE FROM world_events
      WHERE world_id=$1 AND id < (
        SELECT id FROM world_events WHERE world_id=$1 ORDER BY id DESC
         OFFSET 400 LIMIT 1)`,
    [worldId],
  )
}

export async function listEvents(d: Db, worldId: number, limit = 25): Promise<WorldEvent[]> {
  const rows = await many<{ id: number; kind: string; text: string; sim_hour: number; created_at: string }>(
    d,
    `SELECT id::int, kind, text, sim_hour::int, created_at
       FROM world_events WHERE world_id=$1
      ORDER BY id DESC LIMIT $2`,
    [worldId, limit],
  )
  return rows.map((r) => ({
    id: r.id, kind: r.kind, text: r.text, simHour: r.sim_hour, at: r.created_at,
  }))
}

/** Jméno firmy pro text události (fallback #id). */
export async function companyName(d: Db, companyId: number): Promise<string> {
  const r = await one<{ name: string }>(d, `SELECT name FROM companies WHERE id=$1`, [companyId])
  return r?.name ?? `firma #${companyId}`
}

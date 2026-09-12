/**
 * Fáze F — PROGRESE: zkušenosti, úrovně firmy a výzkumný strom.
 *
 * Designové pravidlo ze zadání: hloubka se odemyká postupně, hráč se učí
 * za chodu. Úroveň firmy je brána ke všemu:
 *
 *   • upgrade budovy na úroveň N vyžaduje úroveň firmy ≥ N,
 *   • výzkum 2. tieru od úrovně 3, 3. tier od úrovně 5,
 *   • strop půjčky roste s úrovní (5 000 Kč × úroveň).
 *
 * XP přitékají za skutečnou činnost (výroba, zakázky, dokončený výzkum),
 * nikdy za čekání — „idle“ progress tady není, hra odměňuje rozhodnutí.
 *
 * Křivka: xpForLevel(n) = 250·(n−1)·n  →  L2 = 500, L3 = 1500, L5 = 5000,
 * L10 = 22 500. Prvních pár úrovní padne rychle (motivace), pak se to táhne.
 *
 * Ekonomická kázeň: výzkum se platí z cash do sink_research — peníze mizí,
 * žádný faucet. Hodnotu hráči vrací efektivnější výroba, ne ražba peněz.
 */
import type { Db } from './db.ts'
import { many, one } from './db.ts'
import { post, round6 } from './ledger.ts'
import { MarketError } from './market.ts'
import { companyName, logEvent } from './events.ts'

export const MAX_LEVEL = 10

/** Kumulativní XP potřebné na dosažení úrovně n (1 → 0). */
export function xpForLevel(n: number): number {
  return 250 * (n - 1) * n
}

/** Úroveň pro dané množství XP (kapovaná na MAX_LEVEL). */
export function levelForXp(xp: number): number {
  let n = 1
  while (n < MAX_LEVEL && xp >= xpForLevel(n + 1)) n++
  return n
}

export type ResearchDef = {
  code: string
  name: string
  desc: string
  tier: 1 | 2 | 3
  cost: number        // Kč, okamžitě z cash → sink_research
  hours: number       // herní hodiny do dokončení
  requires: string | null
  minLevel: number
}

/**
 * Deset uzlů ve třech tierech. Efekty jsou aditivní v kódu (viz companyEffects),
 * v UI je popisek lidsky. Řetězce: dřevo→agri, těžba→hutě, dispečink→návěsy,
 * údržbáři→výlohy→prediktivka, automatizace navazuje na návěsy.
 */
export const RESEARCH: ResearchDef[] = [
  { code: 'eff_timber', name: 'Ostřejší pily', desc: 'Výroba v odvětví Dřevo +10 %',
    tier: 1, cost: 400, hours: 2, requires: null, minLevel: 1 },
  { code: 'eff_mining', name: 'Vrtání do hloubky', desc: 'Výroba v odvětví Těžba +10 %',
    tier: 1, cost: 400, hours: 2, requires: null, minLevel: 1 },
  { code: 'logi1', name: 'Centrální dispečink', desc: 'Kapacita dopravy +25 %',
    tier: 1, cost: 600, hours: 3, requires: null, minLevel: 1 },
  { code: 'upkeep1', name: 'Údržbářské čety', desc: 'Údržba budov −10 %',
    tier: 1, cost: 500, hours: 3, requires: null, minLevel: 1 },

  { code: 'eff_agri', name: 'Osevní postupy', desc: 'Výroba v odvětví Zemědělství +10 %',
    tier: 2, cost: 1200, hours: 4, requires: 'eff_timber', minLevel: 3 },
  { code: 'eff_metal', name: 'Předehřívání vsázky', desc: 'Výroba v odvětví Hutnictví +10 %',
    tier: 2, cost: 1200, hours: 4, requires: 'eff_mining', minLevel: 3 },
  { code: 'logi2', name: 'Výměnné návěsy', desc: 'Kapacita dopravy +50 %',
    tier: 2, cost: 1500, hours: 5, requires: 'logi1', minLevel: 3 },
  { code: 'retail1', name: 'Výlohy a merchandising', desc: 'Retailní tržby +8 %',
    tier: 2, cost: 1000, hours: 4, requires: 'upkeep1', minLevel: 3 },

  { code: 'automation', name: 'Automatizace linek', desc: 'Veškerá výroba +15 %',
    tier: 3, cost: 4000, hours: 8, requires: 'logi2', minLevel: 5 },
  { code: 'upkeep2', name: 'Prediktivní údržba', desc: 'Údržba budov −20 %',
    tier: 3, cost: 3500, hours: 8, requires: 'retail1', minLevel: 5 },
]

const BY_CODE = new Map(RESEARCH.map((r) => [r.code, r]))

// ---------------------------------------------------------------------------
//  XP a úrovně
// ---------------------------------------------------------------------------

export type Progress = {
  xp: number; level: number; nextLevelXp: number | null; progressPct: number
}

/** Přičte XP a vrátí stav; `leveledUp` když právě přeskočila úroveň. */
export async function grantXp(
  d: Db, companyId: number, amount: number,
): Promise<{ xp: number; level: number; leveledUp: boolean }> {
  const before = await one<{ xp: number }>(
    d, `SELECT xp::float8 AS xp FROM companies WHERE id=$1`, [companyId])
  const after = await one<{ xp: number }>(
    d,
    `UPDATE companies SET xp = xp + $2 WHERE id=$1 RETURNING xp::float8 AS xp`,
    [companyId, Math.max(0, Math.round(amount))],
  )
  const lvlBefore = levelForXp(before?.xp ?? 0)
  const lvlAfter = levelForXp(after?.xp ?? 0)
  return { xp: after?.xp ?? 0, level: lvlAfter, leveledUp: lvlAfter > lvlBefore }
}

export async function companyProgress(d: Db, companyId: number): Promise<Progress> {
  const r = await one<{ xp: number }>(
    d, `SELECT xp::float8 AS xp FROM companies WHERE id=$1`, [companyId])
  const xp = r?.xp ?? 0
  const level = levelForXp(xp)
  const next = level < MAX_LEVEL ? xpForLevel(level + 1) : null
  const prev = xpForLevel(level)
  const progressPct = next === null
    ? 100
    : Math.round(((xp - prev) / (next - prev)) * 100)
  return { xp, level, nextLevelXp: next, progressPct }
}

// ---------------------------------------------------------------------------
//  Výzkum
// ---------------------------------------------------------------------------

export type ResearchRow = ResearchDef & {
  state: 'locked' | 'available' | 'running' | 'done'
  lockReason: string | null
  progressPct: number
  doneHours: number | null
}

export async function researchList(
  d: Db, worldId: number, companyId: number,
): Promise<{ progress: Progress; items: ResearchRow[] }> {
  const progress = await companyProgress(d, companyId)
  const rows = await many<{ code: string; done_hours: number; completed: boolean }>(
    d,
    `SELECT code, done_hours::int AS done_hours, (completed_at IS NOT NULL) AS completed
       FROM company_research WHERE company_id=$1`,
    [companyId],
  )
  const mine = new Map(rows.map((r) => [r.code, r]))
  const world = await one<{ hours: number }>(
    d, `SELECT sim_hours::int AS hours FROM worlds WHERE id=$1`, [worldId])
  const now = world?.hours ?? 0

  const items: ResearchRow[] = RESEARCH.map((def) => {
    const row = mine.get(def.code)
    if (row?.completed) {
      return { ...def, state: 'done', lockReason: null, progressPct: 100, doneHours: null }
    }
    if (row) {
      const started = row.done_hours - def.hours
      const pct = Math.max(0, Math.min(100,
        Math.round(((now - started) / Math.max(1, def.hours)) * 100)))
      return { ...def, state: 'running', lockReason: null, progressPct: pct,
               doneHours: row.done_hours }
    }
    let lockReason: string | null = null
    if (progress.level < def.minLevel) {
      lockReason = `vyžaduje úroveň firmy ${def.minLevel}`
    } else if (def.requires && !mine.get(def.requires)?.completed) {
      lockReason = `navazuje na výzkum „${BY_CODE.get(def.requires)?.name ?? def.requires}“`
    }
    return { ...def, state: lockReason ? 'locked' : 'available', lockReason,
             progressPct: 0, doneHours: null }
  })
  return { progress, items }
}

/** Odstartuje výzkum: okamžitá platba z cash → sink_research. */
export async function startResearch(
  d: Db, worldId: number, companyId: number, code: string,
): Promise<{ code: string; cost: number; doneHours: number }> {
  const def = BY_CODE.get(code)
  if (!def) throw new MarketError(`neznámý výzkum '${code}'`, 'not_found')

  const { items, progress } = await researchList(d, worldId, companyId)
  const row = items.find((i) => i.code === code)
  if (!row || row.state === 'done') {
    throw new MarketError('tenhle výzkum už máš hotový', 'already_done')
  }
  if (row.state === 'running') {
    throw new MarketError('výzkum už běží', 'already_running')
  }
  if (row.state === 'locked') {
    throw new MarketError(row.lockReason ?? 'výzkum není dostupný', 'locked')
  }

  const cash = await one<{ c: number }>(
    d,
    `SELECT COALESCE(SUM(balance),0)::float8 AS c FROM accounts
      WHERE owner_type='company' AND owner_id=$1 AND kind='cash'`,
    [companyId],
  )
  if ((cash?.c ?? 0) < def.cost) {
    throw new MarketError(
      `na výzkum potřebuješ ${def.cost} Kč, na účtu máš ${round6(cash?.c ?? 0)} Kč`,
      'insufficient_funds')
  }

  await post(d, worldId, [
    { party: { type: 'company', id: companyId }, kind: 'cash', amount: -def.cost,
      moneyFlow: 'sink', refType: 'company', refId: companyId },
    { party: { type: 'system' }, kind: 'sink_research', amount: def.cost,
      moneyFlow: 'sink', refType: 'company', refId: companyId },
  ], { kind: 'research' })

  const world = await one<{ hours: number }>(
    d, `SELECT sim_hours::int AS hours FROM worlds WHERE id=$1`, [worldId])
  const doneHours = (world?.hours ?? 0) + def.hours
  await d.query(
    `INSERT INTO company_research (company_id, code, done_hours) VALUES ($1,$2,$3)
     ON CONFLICT (company_id, code) DO NOTHING`,
    [companyId, code, doneHours],
  )
  return { code, cost: def.cost, doneHours }
}

/**
 * Tick fáze: dokončí výzkumy, kterým vypršela herní doba, a dá za ně XP.
 * Vrací počet dokončených (pro log).
 */
export async function researchTick(
  d: Db, worldId: number, simHours: number,
): Promise<number> {
  void worldId   // company_research nemá world_id — filtr stačí přes done_hours
  const done = await many<{ company_id: number; code: string }>(
    d,
    `UPDATE company_research SET completed_at = now()
      WHERE completed_at IS NULL AND done_hours <= $1
      RETURNING company_id::int, code`,
    [simHours],
  )
  for (const r of done) {
    await grantXp(d, r.company_id, 25)
    const name = BY_CODE.get(r.code)?.name ?? r.code
    await logEvent(d, worldId, 'research',
      `🔬 Výzkum „${name}“ dokončen — ${await companyName(d, r.company_id)}`, simHours)
  }
  return done.length
}

// ---------------------------------------------------------------------------
//  Efekty (výzkum + manažeři) — vstup do ticku a dopravy
// ---------------------------------------------------------------------------

export type CompanyEffects = {
  /** multiplikátor výstupu podle kódu odvětví (timber, mining, …) */
  outputByIndustry: Record<string, number>
  /** multiplikátor veškerého výstupu (automatizace, výkonný ředitel výroby) */
  outputAll: number
  upkeep: number
  retail: number
  transport: number
}

const IDENTITY: CompanyEffects = {
  outputByIndustry: {}, outputAll: 1, upkeep: 1, retail: 1, transport: 1,
}

/**
 * Sečte dokončené výzkumy a manažery firmy do multiplikátorů.
 * Čte se to 2× za tick (výroba, doprava), proto jednoduché dotazy bez joinů.
 */
export async function companyEffects(d: Db, companyId: number): Promise<CompanyEffects> {
  const res = await many<{ code: string }>(
    d,
    `SELECT code FROM company_research WHERE company_id=$1 AND completed_at IS NOT NULL`,
    [companyId],
  )
  const execs = await many<{ role: string; bonus: number }>(
    d,
    `SELECT role, bonus_pct::float8 AS bonus FROM executives WHERE company_id=$1`,
    [companyId],
  )
  if (res.length === 0 && execs.length === 0) return IDENTITY

  const e: CompanyEffects = {
    outputByIndustry: {}, outputAll: 1, upkeep: 1, retail: 1, transport: 1,
  }
  const ind = (code: string, mult: number) => {
    e.outputByIndustry[code] = (e.outputByIndustry[code] ?? 1) * mult
  }
  for (const r of res) {
    switch (r.code) {
      case 'eff_timber': ind('timber', 1.10); break
      case 'eff_mining': ind('mining', 1.10); break
      case 'eff_agri': ind('agriculture', 1.10); break
      case 'eff_metal': ind('metallurgy', 1.10); break
      case 'automation': e.outputAll *= 1.15; break
      case 'upkeep1': e.upkeep *= 0.90; break
      case 'upkeep2': e.upkeep *= 0.80; break
      case 'retail1': e.retail *= 1.08; break
      case 'logi1': e.transport *= 1.25; break
      case 'logi2': e.transport *= 1.50; break
    }
  }
  for (const x of execs) {
    if (x.role === 'production') e.outputAll *= 1 + x.bonus / 100
    if (x.role === 'logistics') e.transport *= 1 + x.bonus / 100
  }
  return e
}

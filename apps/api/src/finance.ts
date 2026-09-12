/**
 * Fáze F — FINANCE: půjčky, manažeři (executives), denní výsledovka a historie cen.
 *
 * Peněžní toky drží makro identitu:
 *   • půjčka   = faucet_state (státní/bankovní emise) → cash firmy,
 *   • splátka  = cash → faucet_state (peníze zanikají),
 *   • úrok     = cash → sink_loan_interest (sink, každý tick z nesplacené jistiny),
 *   • mzdy     = cash → sink_wages (nájem manažera i hodinové mzdy),
 *   • odměna při demolici = faucet_state → cash (stát odkoupí materiál),
 *     účtuje ji game.ts jako 'demolition'.
 *
 * Strop úvěrování roste s úrovní firmy (5 000 Kč × úroveň) — začátečník se
 * nemůže zadlužit do nesmyslu, ale „rychlejší start za cenu úroků“ je možný.
 *
 * Historie cen: jednou za herní hodinu (v ticku) se zapíše mid/last každé
 * položky — data pro sparkline v Terminálu. Upsert podle (world,item,hour).
 */
import type { Db } from './db.ts'
import { many, one } from './db.ts'
import { post, round6 } from './ledger.ts'
import { MarketError } from './market.ts'
import { companyProgress } from './progression.ts'

export const LOAN_RATE_HOUR = 0.0002   // 0,02 %/h ≈ 0,48 %/herní den
export const LOAN_MIN = 500
export const LOAN_PER_LEVEL = 5000

export type LoanRow = {
  id: number; principal: number; outstanding: number; rateHour: number
  takenAt: string; closed: boolean
}

export async function listLoans(d: Db, companyId: number): Promise<{
  loans: LoanRow[]; outstanding: number; capacity: number; level: number
}> {
  const rows = await many<{
    id: number; principal: number; outstanding: number; rate: number
    taken_at: string; closed: boolean
  }>(
    d,
    `SELECT id::int, principal::float8 AS principal, outstanding::float8 AS outstanding,
            rate_hour::float8 AS rate, taken_at, (closed_at IS NOT NULL) AS closed
       FROM loans WHERE company_id=$1 ORDER BY id DESC`,
    [companyId],
  )
  const progress = await companyProgress(d, companyId)
  const outstanding = round6(rows.filter((r) => !r.closed)
    .reduce((s, r) => s + r.outstanding, 0))
  return {
    loans: rows.map((r) => ({
      id: r.id, principal: r.principal, outstanding: r.outstanding,
      rateHour: r.rate, takenAt: r.taken_at, closed: r.closed,
    })),
    outstanding,
    capacity: Math.max(0, progress.level * LOAN_PER_LEVEL - outstanding),
    level: progress.level,
  }
}

export async function takeLoan(
  d: Db, worldId: number, companyId: number, principal: number,
): Promise<{ id: number; principal: number; rateHour: number }> {
  const amount = Math.round(principal)
  if (!Number.isFinite(amount) || amount < LOAN_MIN) {
    throw new MarketError(`minimální půjčka je ${LOAN_MIN} Kč`, 'invalid_amount')
  }
  const { outstanding, capacity } = await listLoans(d, companyId)
  if (amount > capacity) {
    throw new MarketError(
      `strop úvěrování je ${round6(outstanding + capacity)} Kč (úroveň × ${LOAN_PER_LEVEL}),` +
      ` zbývá ${round6(capacity)} Kč`, 'loan_limit')
  }
  const r = await one<{ id: string }>(
    d,
    `INSERT INTO loans (world_id, company_id, principal, outstanding, rate_hour)
     VALUES ($1,$2,$3,$3,$4) RETURNING id::text`,
    [worldId, companyId, amount, LOAN_RATE_HOUR],
  )
  const loanId = Number(r!.id)
  await post(d, worldId, [
    { party: { type: 'system' }, kind: 'faucet_state', amount: -amount,
      moneyFlow: 'faucet', refType: 'loan', refId: loanId },
    { party: { type: 'company', id: companyId }, kind: 'cash', amount,
      moneyFlow: 'faucet', refType: 'loan', refId: loanId },
  ], { kind: 'adjustment' })
  return { id: loanId, principal: amount, rateHour: LOAN_RATE_HOUR }
}

/** Splatí celou zbývající jistinu (peníze zanikají zpět ve faucet_state). */
export async function repayLoan(
  d: Db, worldId: number, companyId: number, loanId: number,
): Promise<{ id: number; repaid: number }> {
  const loan = await one<{ outstanding: number }>(
    d,
    `SELECT outstanding::float8 AS outstanding FROM loans
      WHERE id=$1 AND company_id=$2 AND closed_at IS NULL`,
    [loanId, companyId],
  )
  if (!loan) throw new MarketError('půjčka nenalezena nebo už splacená', 'not_found')
  const cash = await one<{ c: number }>(
    d,
    `SELECT COALESCE(SUM(balance),0)::float8 AS c FROM accounts
      WHERE owner_type='company' AND owner_id=$1 AND kind='cash'`,
    [companyId],
  )
  if ((cash?.c ?? 0) + 1e-9 < loan.outstanding) {
    throw new MarketError(
      `na splacení potřebuješ ${round6(loan.outstanding)} Kč`, 'insufficient_funds')
  }
  await post(d, worldId, [
    { party: { type: 'company', id: companyId }, kind: 'cash', amount: -loan.outstanding,
      moneyFlow: 'faucet', refType: 'loan', refId: loanId },
    { party: { type: 'system' }, kind: 'faucet_state', amount: loan.outstanding,
      moneyFlow: 'faucet', refType: 'loan', refId: loanId },
  ], { kind: 'adjustment' })
  await d.query(
    `UPDATE loans SET outstanding=0, closed_at=now() WHERE id=$1`, [loanId])
  return { id: loanId, repaid: round6(loan.outstanding) }
}

/** Tick fáze: úroky z nesplacených jistin → sink_loan_interest. */
export async function loansTick(d: Db, worldId: number, cycles: number): Promise<number> {
  const rows = await many<{ id: number; company_id: number; outstanding: number; rate: number }>(
    d,
    `SELECT id::int, company_id::int, outstanding::float8 AS outstanding,
            rate_hour::float8 AS rate
       FROM loans WHERE world_id=$1 AND closed_at IS NULL AND outstanding > 0`,
    [worldId],
  )
  let paid = 0
  for (const l of rows) {
    const interest = round6(l.outstanding * l.rate * cycles)
    if (interest <= 0) continue
    const cash = await one<{ c: number }>(
      d,
      `SELECT COALESCE(SUM(balance),0)::float8 AS c FROM accounts
        WHERE owner_type='company' AND owner_id=$1 AND kind='cash'`,
      [l.company_id],
    )
    if ((cash?.c ?? 0) < interest) continue   // nemá na úrok → roste mu reputační dluh (neřešíme)
    await post(d, worldId, [
      { party: { type: 'company', id: l.company_id }, kind: 'cash', amount: -interest,
        moneyFlow: 'sink', refType: 'loan', refId: l.id },
      { party: { type: 'system' }, kind: 'sink_loan_interest', amount: interest,
        moneyFlow: 'sink', refType: 'loan', refId: l.id },
    ], { kind: 'loan_interest' })
    paid++
  }
  return paid
}

// ---------------------------------------------------------------------------
//  Manažeři (executives)
// ---------------------------------------------------------------------------

export type ExecDef = {
  role: 'production' | 'logistics' | 'trade'
  label: string
  effect: string
  bonusPct: number
  salaryHour: number
  signingFee: number
}

export const EXEC_DEFS: ExecDef[] = [
  { role: 'production', label: 'Ředitel výroby', effect: '+10 % veškerá výroba',
    bonusPct: 10, salaryHour: 3, signingFee: 200 },
  { role: 'logistics', label: 'Ředitel logistiky', effect: '+15 % kapacita dopravy',
    bonusPct: 15, salaryHour: 2, signingFee: 150 },
  { role: 'trade', label: 'Obchodní ředitel', effect: '−8 % burzovní poplatky',
    bonusPct: 8, salaryHour: 4, signingFee: 300 },
]

const NAMES = [
  'Ing. Marta Dvořáková', 'JUDr. Petr Vaněk', 'Ing. Klára Šimková',
  'Marek Hrubý', 'Ing. Jana Bartošová', 'Tomáš Rezek', 'Ing. Eva Králová',
  'Pavel Sedláček', 'Ing. Lucie Malá', 'David Němec',
]

export async function listExecutives(d: Db, companyId: number) {
  const hired = await many<{
    role: string; name: string; salary: number; bonus: number; hired_at: string
  }>(
    d,
    `SELECT role, name, salary_hour::float8 AS salary, bonus_pct::float8 AS bonus, hired_at
       FROM executives WHERE company_id=$1 ORDER BY role`,
    [companyId],
  )
  const byRole = new Map(hired.map((h) => [h.role, h]))
  return EXEC_DEFS.map((def) => {
    const h = byRole.get(def.role)
    return { ...def, hired: h !== undefined, name: h?.name ?? null,
             salaryHour: h?.salary ?? def.salaryHour }
  })
}

export async function hireExecutive(
  d: Db, worldId: number, companyId: number, role: string,
): Promise<{ role: string; name: string; signingFee: number }> {
  const def = EXEC_DEFS.find((x) => x.role === role)
  if (!def) throw new MarketError(`neznámá role '${role}'`, 'not_found')
  const cash = await one<{ c: number }>(
    d,
    `SELECT COALESCE(SUM(balance),0)::float8 AS c FROM accounts
      WHERE owner_type='company' AND owner_id=$1 AND kind='cash'`,
    [companyId],
  )
  if ((cash?.c ?? 0) < def.signingFee) {
    throw new MarketError(
      `nájem stojí ${def.signingFee} Kč, na účtu máš ${round6(cash?.c ?? 0)} Kč`,
      'insufficient_funds')
  }
  const taken = await many<{ name: string }>(
    d, `SELECT name FROM executives WHERE company_id=$1`, [companyId])
  const pool = NAMES.filter((n) => !taken.some((t) => t.name === n))
  const name = pool.length > 0
    ? pool[Math.floor(Math.random() * pool.length)]!
    : NAMES[Math.floor(Math.random() * NAMES.length)]!

  try {
    await d.query(
      `INSERT INTO executives (world_id, company_id, name, role, salary_hour, bonus_pct)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [worldId, companyId, name, def.role, def.salaryHour, def.bonusPct],
    )
  } catch {
    throw new MarketError('tohle místo je už obsazené', 'already_hired')
  }
  await post(d, worldId, [
    { party: { type: 'company', id: companyId }, kind: 'cash', amount: -def.signingFee,
      moneyFlow: 'sink', refType: 'company', refId: companyId },
    { party: { type: 'system' }, kind: 'sink_wages', amount: def.signingFee,
      moneyFlow: 'sink', refType: 'company', refId: companyId },
  ], { kind: 'wages' })
  return { role: def.role, name, signingFee: def.signingFee }
}

export async function fireExecutive(
  d: Db, worldId: number, companyId: number, role: string,
): Promise<{ role: string; fired: boolean }> {
  const r = await d.query(
    `DELETE FROM executives WHERE company_id=$1 AND role=$2`, [companyId, role])
  if ((r.affectedRows ?? 0) === 0) {
    throw new MarketError('takového manažera nemáš', 'not_found')
  }
  void worldId
  return { role, fired: true }
}

/** Tick fáze: hodinové mzdy všech manažerů → sink_wages. */
export async function execsTick(d: Db, worldId: number, cycles: number): Promise<number> {
  const rows = await many<{ company_id: number; wage: number }>(
    d,
    `SELECT company_id::int, SUM(salary_hour)::float8 * $2::float8 AS wage
       FROM executives WHERE world_id=$1
      GROUP BY company_id`,
    [worldId, cycles],
  )
  let paid = 0
  for (const r of rows) {
    const wage = round6(r.wage)
    if (wage <= 0) continue
    const cash = await one<{ c: number }>(
      d,
      `SELECT COALESCE(SUM(balance),0)::float8 AS c FROM accounts
        WHERE owner_type='company' AND owner_id=$1 AND kind='cash'`,
      [r.company_id],
    )
    if ((cash?.c ?? 0) < wage) continue   // nezaplatí mzdy → manažer zatím zůstává
    await post(d, worldId, [
      { party: { type: 'company', id: r.company_id }, kind: 'cash', amount: -wage,
        moneyFlow: 'sink', refType: 'company', refId: r.company_id },
      { party: { type: 'system' }, kind: 'sink_wages', amount: wage,
        moneyFlow: 'sink', refType: 'company', refId: r.company_id },
    ], { kind: 'wages' })
    paid++
  }
  return paid
}

// ---------------------------------------------------------------------------
//  Denní výsledovka (P&L) — seskupená z cash noh journalu od půlnoci UTC
// ---------------------------------------------------------------------------

export const PNL_LABELS: Record<string, string> = {
  retail_sale: 'Retailní tržby',
  state_purchase: 'Státní zakázky',
  market_trade: 'Obchody na burze',
  starting_grant: 'Startovní kapitál',
  adjustment: 'Půjčky a úpravy',
  demolition: 'Demolice (odkup)',
  upkeep: 'Údržba budov',
  utilities_purchase: 'Elektřina',
  transport: 'Doprava',
  wages: 'Mzdy',
  loan_interest: 'Úroky z půjček',
  research: 'Výzkum',
  building_capex: 'Nové stavby',
  upgrade_capex: 'Upgrade budov',
  land_purchase: 'Výkup pozemků',
  escrow_lock: 'Blokování peněz (escrow)',
  escrow_release: 'Uvolnění peněz (escrow)',
}

export async function pnlToday(d: Db, worldId: number, companyId: number) {
  const rows = await many<{ kind: string; total: number; n: number }>(
    d,
    `SELECT je.kind, SUM(je.amount)::float8 AS total, COUNT(*)::int AS n
       FROM journal_entries je
       JOIN accounts a ON a.id = je.account_id
      WHERE a.owner_type='company' AND a.owner_id=$1 AND a.kind='cash'
        AND je.world_id=$2
        AND je.created_at >= date_trunc('day', now())
      GROUP BY je.kind
      ORDER BY SUM(je.amount) DESC`,
    [companyId, worldId],
  )
  const escrowKinds = new Set(['escrow_lock', 'escrow_release'])
  const items = rows
    .filter((r) => !escrowKinds.has(r.kind))
    .map((r) => ({ kind: r.kind, label: PNL_LABELS[r.kind] ?? r.kind,
                   total: round6(r.total), count: r.n }))
  const revenue = round6(items.filter((i) => i.total > 0).reduce((s, i) => s + i.total, 0))
  const costs = round6(items.filter((i) => i.total < 0).reduce((s, i) => s + i.total, 0))
  return { items, revenue, costs, net: round6(revenue + costs) }
}

// ---------------------------------------------------------------------------
//  Historie cen
// ---------------------------------------------------------------------------

/**
 * Zapíše mid/last všech položek za aktuální herní hodinu (upsert).
 * Volá se z ticku PŘED navýšením sim_hours — zaznamenává končící hodinu.
 */
export async function recordPriceHistory(
  d: Db, worldId: number, simHour: number,
): Promise<void> {
  const rows = await many<{
    item_id: number; bid: number | null; ask: number | null; last: number | null
  }>(
    d,
    `SELECT i.id::int AS item_id,
            (SELECT MAX(o.price_limit)::float8 FROM market_orders o
              WHERE o.world_id=$1 AND o.item_id=i.id AND o.side='buy'
                AND o.status IN ('open','partial') AND o.order_type='limit'
                AND o.is_npc=false) AS bid,
            (SELECT MIN(o.price_limit)::float8 FROM market_orders o
              WHERE o.world_id=$1 AND o.item_id=i.id AND o.side='sell'
                AND o.status IN ('open','partial') AND o.order_type='limit'
                AND o.is_npc=false) AS ask,
            (SELECT t.price::float8 FROM trades t
              WHERE t.world_id=$1 AND t.item_id=i.id
              ORDER BY t.executed_at DESC, t.id DESC LIMIT 1) AS last
       FROM items i`,
    [worldId],
  )
  for (const r of rows) {
    const mid = r.bid !== null && r.ask !== null
      ? round6((r.bid + r.ask) / 2)
      : (r.last ?? r.bid ?? r.ask)
    if (mid === null && r.last === null) continue
    await d.query(
      `INSERT INTO price_history (world_id, item_id, sim_hour, mid, last)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (world_id, item_id, sim_hour)
       DO UPDATE SET mid = COALESCE(EXCLUDED.mid, price_history.mid),
                     last = COALESCE(EXCLUDED.last, price_history.last)`,
      [worldId, r.item_id, simHour, mid, r.last],
    )
  }
}

export async function priceHistory(
  d: Db, worldId: number, itemCode: string, hours = 96,
) {
  const rows = await many<{ sim_hour: number; mid: number | null; last: number | null }>(
    d,
    `SELECT h.sim_hour::int, h.mid::float8, h.last::float8
       FROM price_history h JOIN items i ON i.id = h.item_id
      WHERE h.world_id=$1 AND i.code=$2
      ORDER BY h.sim_hour DESC LIMIT $3`,
    [worldId, itemCode, hours],
  )
  return rows.reverse().map((r) => ({
    hour: r.sim_hour, mid: r.mid, last: r.last,
  }))
}

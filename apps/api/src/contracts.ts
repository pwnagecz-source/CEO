/**
 * Fáze F — ZAKÁZKY (státní kontrakty): řízený odbytový kanál vedle burzy.
 *
 * Proč: na začátku hry je book mělký a hráč nemá komu prodat. Zakázka je
 * garantovaný odběr za prémiovou cenu (1,15–1,40× mid) s termínem — učí
 * plánovat výrobu a dává cíl, aniž by podváděla ekonomiku: zboží se opravdu
 * spálí (mizí ze skladů) a peníze přitečou z faucet_state (státní rozpočet),
 * přesně jako retail. Audit tím pádem drží: Σ journal = 0, peníze vznikají
 * jen ve faucets.
 *
 * Cyklus: svět drží ~4 otevřené zakázky, generují se v ticku, expirují podle
 * herních hodin (deadline_hours vs worlds.sim_hours). Splnění = okamžitý
 * prodej ze všech skladů firmy + XP.
 */
import type { Db } from './db.ts'
import { many, one } from './db.ts'
import { post, round6 } from './ledger.ts'
import { MarketError } from './market.ts'
import { grantXp } from './progression.ts'

export type ContractRow = {
  id: number
  item: string
  itemName: string
  qty: number
  unitPrice: number
  total: number
  deadlineHours: number
  hoursLeft: number
  xpReward: number
  status: 'open' | 'taken' | 'done' | 'expired'
  companyId: number | null
  isMine: boolean
}

/** Referenční cena položky: mid z booku → poslední obchod → base_price. */
export async function refPrices(
  d: Db, worldId: number,
): Promise<Map<number, { code: string; price: number; minLot: number; tick: number; name: string }>> {
  const rows = await many<{
    id: number; code: string; name: string; base: number; lot: number; tick: number
    bid: number | null; ask: number | null; last: number | null
  }>(
    d,
    `SELECT i.id::int, i.code, i.name, i.base_price::float8 AS base,
            i.min_lot::float8 AS lot, i.tick_size::float8 AS tick,
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
       FROM items i
      WHERE i.code <> 'power'`,
    [worldId],
  )
  const m = new Map<number, { code: string; price: number; minLot: number; tick: number; name: string }>()
  for (const r of rows) {
    const mid = r.bid !== null && r.ask !== null ? (r.bid + r.ask) / 2 : null
    const price = mid ?? r.last ?? r.bid ?? r.ask ?? r.base
    m.set(r.id, { code: r.code, price, minLot: r.lot, tick: r.tick, name: r.name })
  }
  return m
}

function roundToTick(price: number, tick: number): number {
  return round6(Math.max(tick, Math.round(price / tick) * tick))
}

/**
 * Vygeneruje `count` nových zakázek. Cena = prémie 1,15–1,40× nad referencí,
 * množství 100–800 ks (zaokrouhlené na min_lot), termín 48–168 herních hodin.
 */
export async function generateContracts(
  d: Db, worldId: number, simHours: number, count: number,
): Promise<number> {
  const refs = await refPrices(d, worldId)
  const pool = [...refs.entries()]
  let made = 0
  for (let i = 0; i < count && pool.length > 0; i++) {
    const [itemId, ref] = pool[Math.floor(Math.random() * pool.length)]!
    const rawQty = 100 + Math.floor(Math.random() * 700)
    const qty = Math.max(ref.minLot, Math.floor(rawQty / ref.minLot) * ref.minLot)
    const premium = 1.15 + Math.random() * 0.25
    const unitPrice = roundToTick(ref.price * premium, ref.tick)
    const deadline = simHours + 48 + Math.floor(Math.random() * 120)
    const xp = Math.round(15 + (qty * unitPrice) / 800)
    await d.query(
      `INSERT INTO contracts (world_id, item_id, qty, unit_price, deadline_hours, xp_reward)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [worldId, itemId, qty, unitPrice, deadline, xp],
    )
    made++
  }
  return made
}

export async function listContracts(
  d: Db, worldId: number, companyId: number | null,
): Promise<ContractRow[]> {
  const rows = await many<{
    id: number; item: string; item_name: string; qty: number; unit_price: number
    deadline_hours: number; hours_left: number; xp_reward: number
    status: string; company_id: number | null
  }>(
    d,
    `SELECT c.id::int, i.code AS item, i.name AS item_name, c.qty::float8 AS qty,
            c.unit_price::float8 AS unit_price, c.deadline_hours::int AS deadline_hours,
            (c.deadline_hours - w.sim_hours)::int AS hours_left,
            c.xp_reward::int AS xp_reward, c.status, c.company_id::int
       FROM contracts c
       JOIN items i ON i.id = c.item_id
       JOIN worlds w ON w.id = c.world_id
      WHERE c.world_id=$1 AND c.status IN ('open','taken')
      ORDER BY c.status, c.deadline_hours, c.id`,
    [worldId],
  )
  return rows.map((r) => ({
    id: r.id, item: r.item, itemName: r.item_name, qty: r.qty,
    unitPrice: r.unit_price, total: round6(r.qty * r.unit_price),
    deadlineHours: r.deadline_hours, hoursLeft: r.hours_left,
    xpReward: r.xp_reward,
    status: r.status as ContractRow['status'],
    companyId: r.company_id,
    isMine: companyId !== null && r.company_id === companyId,
  }))
}

export async function takeContract(
  d: Db, worldId: number, companyId: number, contractId: number,
): Promise<{ id: number; status: string }> {
  const r = await one<{ id: string }>(
    d,
    `UPDATE contracts SET status='taken', company_id=$3, taken_at=now()
      WHERE id=$1 AND world_id=$2 AND status='open'
      RETURNING id::text`,
    [contractId, worldId, companyId],
  )
  if (!r) throw new MarketError('zakázka už není k dispozici (nebo neexistuje)', 'not_available')
  return { id: contractId, status: 'taken' }
}

/**
 * Splnění zakázky: zboží se odepíše napříč sklady firmy (volné, nerezervované)
 * a stát zaplatí z faucet_state (journal 'state_purchase' — stejný druh jako
 * státní odkupy v designu). Žádná rezervace předem: kontrola i odběr v jednom
 * kroku, ať mezi nimi nic neodvezou.
 */
export async function deliverContract(
  d: Db, worldId: number, companyId: number, contractId: number,
): Promise<{ id: number; paid: number; xp: number; level: number }> {
  const c = await one<{
    id: string; item_id: number; code: string; qty: number; unit_price: number; xp: number
  }>(
    d,
    `SELECT c.id::text, c.item_id::int, i.code, c.qty::float8 AS qty,
            c.unit_price::float8 AS unit_price, c.xp_reward::int AS xp
       FROM contracts c JOIN items i ON i.id = c.item_id
      WHERE c.id=$1 AND c.world_id=$2 AND c.status='taken' AND c.company_id=$3`,
    [contractId, worldId, companyId],
  )
  if (!c) throw new MarketError('zakázku nemáš přijatou (nebo neexistuje)', 'not_found')

  const rows = await many<{ id: number; avail: number }>(
    d,
    `SELECT ii.id::int, (ii.quantity - ii.reserved_qty)::float8 AS avail
       FROM inventory_items ii JOIN inventories v ON v.id = ii.inventory_id
      WHERE v.company_id=$1 AND ii.item_id=$2 AND ii.quantity - ii.reserved_qty > 0
      ORDER BY ii.id`,
    [companyId, c.item_id],
  )
  const have = round6(rows.reduce((s, r) => s + r.avail, 0))
  if (have + 1e-9 < c.qty) {
    throw new MarketError(
      `na splnění potřebuješ ${c.qty} ks ${c.code}, volných máš ${have}`,
      'insufficient_goods')
  }
  let left = c.qty
  for (const r of rows) {
    if (left <= 1e-9) break
    const take = round6(Math.min(left, r.avail))
    if (take <= 0) continue
    await d.query(
      `UPDATE inventory_items SET quantity = quantity - $2, updated_at = now() WHERE id=$1`,
      [r.id, take],
    )
    left = round6(left - take)
  }

  const total = round6(c.qty * c.unit_price)
  await post(d, worldId, [
    { party: { type: 'system' }, kind: 'faucet_state', amount: -total,
      moneyFlow: 'faucet', refType: 'contract', refId: contractId },
    { party: { type: 'company', id: companyId }, kind: 'cash', amount: total,
      moneyFlow: 'faucet', refType: 'contract', refId: contractId },
  ], { kind: 'state_purchase' })

  await d.query(
    `UPDATE contracts SET status='done', done_at=now() WHERE id=$1`, [contractId])
  const p = await grantXp(d, companyId, c.xp)
  return { id: contractId, paid: total, xp: c.xp, level: p.level }
}

/** Udrží svět živý: expiruje prošlé zakázky a doplní stav na ~4 otevřené. */
export async function contractsTick(
  d: Db, worldId: number, simHours: number,
): Promise<{ expired: number; generated: number }> {
  const exp = await d.query(
    `UPDATE contracts SET status='expired'
      WHERE world_id=$1 AND status IN ('open','taken') AND deadline_hours <= $2`,
    [worldId, simHours],
  )
  const open = await one<{ n: number }>(
    d,
    `SELECT COUNT(*)::int AS n FROM contracts WHERE world_id=$1 AND status='open'`,
    [worldId],
  )
  const missing = Math.max(0, 4 - (open?.n ?? 0))
  const generated = missing > 0 ? await generateContracts(d, worldId, simHours, missing) : 0
  return { expired: exp.affectedRows ?? 0, generated }
}

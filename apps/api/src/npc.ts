/**
 * Fáze F — NPC MOZEK: soupeři, kteří ve světě opravdu podnikají.
 *
 * Každý tick každá NPC firma (všechny kromě `worlds.player_company_id`):
 *
 *   1. PRODÁVÁ přebytky — limit sell mírně pod referenční cenou (×0,985).
 *      Přebytek = volné zásoby > 400 ks; prodává max 35 % najednou.
 *   2. NAKUPOUÁ vstupy — když zásoba receptového vstupu klesne pod 6 herních
 *      hodin potřeby, přikoupí na 12 hodin dopředu, limitně mírně NAD referencí
 *      (×1,02). Utrácí max 15 % hotovosti. Elektřinu neřeší — tu kryje tarif.
 *   3. EXPANDUJE (s pravděpodobností 5 % × cycles při hotovosti > 9 000 Kč):
 *      upgrade vlastní budovy → nový pozemek + budova → nejlevnější dostupný
 *      výzkum. V tomto pořadí, první úspěšná akce vyhrává.
 *
 * Všechny příkazy procházejí STEJNÝM placeOrder jako hráčovy — žádné
 * privilegované zkratky, escrow, poplatky i anti-wash platí i pro ně.
 * Proto jsou jejich objednávky vidět v booku: trh je „živý“ doopravdy.
 *
 * Ochrana před zahlcením booku: firma s ≥ 6 otevřenými příkazy další nedává.
 * Každá chyba (MarketError i jiná) se spolkne — NPC svět nikdy nesmí
 * shodit tick.
 */
import type { Db } from './db.ts'
import { many, one } from './db.ts'
import { balance, round6 } from './ledger.ts'
import { MarketError, placeOrder } from './market.ts'
import { buyPlot, buildBuilding, upgradeBuilding, upgradeCost } from './game.ts'
import { refPrices } from './contracts.ts'
import { researchList, startResearch } from './progression.ts'

const MAX_OPEN_ORDERS = 6
const SELL_SURPLUS = 400        // ks, od kterých se přebytek prodává
const SELL_FRACTION = 0.35      // jak velkou část přebytku dát na trh
const BUY_HOURS_LOW = 6         // pod kolik hodin zásoby nakupovat
const BUY_HOURS_TARGET = 12     // na kolik hodin doplnit
const EXPAND_CASH = 9000
const EXPAND_P = 0.05           // × cycles

function roundToTick(price: number, tick: number): number {
  return round6(Math.max(tick, Math.round(price / tick) * tick))
}

type NpcCompany = { id: number; name: string; cash: number }

async function npcCompanies(d: Db, worldId: number): Promise<NpcCompany[]> {
  const w = await one<{ player: number | null }>(
    d, `SELECT player_company_id::int AS player FROM worlds WHERE id=$1`, [worldId])
  const cos = await many<{ id: number }>(
    d, `SELECT id::int FROM companies WHERE world_id=$1 ORDER BY id`, [worldId])
  const out: NpcCompany[] = []
  for (const c of cos) {
    if (w?.player !== null && w?.player !== undefined && c.id === w.player) continue
    const cash = await balance(d, worldId, { type: 'company', id: c.id }, 'cash')
    out.push({ id: c.id, name: `#${c.id}`, cash })
  }
  return out
}

async function openOrderCount(d: Db, companyId: number): Promise<number> {
  const r = await one<{ n: number }>(
    d,
    `SELECT COUNT(*)::int AS n FROM market_orders
      WHERE company_id=$1 AND status IN ('open','partial')`,
    [companyId],
  )
  return r?.n ?? 0
}

/** Volné zásoby firmy po položkách (napříč sklady). */
async function freeStock(d: Db, companyId: number) {
  return many<{ item_id: number; code: string; avail: number }>(
    d,
    `SELECT ii.item_id::int, i.code, SUM(ii.quantity - ii.reserved_qty)::float8 AS avail
       FROM inventory_items ii
       JOIN inventories v ON v.id = ii.inventory_id
       JOIN items i ON i.id = ii.item_id
      WHERE v.company_id=$1 AND ii.quantity - ii.reserved_qty > 0
      GROUP BY ii.item_id, i.code`,
    [companyId],
  )
}

/** Hodinová potřeba receptových vstupů (bez elektřiny) napříč budovami. */
async function inputNeeds(d: Db, companyId: number) {
  return many<{ item_id: number; code: string; need_h: number }>(
    d,
    `SELECT ri.item_id::int, i.code, SUM(ri.qty)::float8 AS need_h
       FROM buildings b
       JOIN building_types bt ON bt.id = b.type_id
       JOIN recipes r ON r.building_type_id = bt.id AND r.is_active
       JOIN recipe_inputs ri ON ri.recipe_id = r.id
       JOIN items i ON i.id = ri.item_id
      WHERE b.company_id=$1 AND b.status <> 'construction' AND i.code <> 'power'
      GROUP BY ri.item_id, i.code`,
    [companyId],
  )
}

async function npcSell(d: Db, worldId: number, npc: NpcCompany) {
  const refs = await refPrices(d, worldId)
  const stock = await freeStock(d, npc.id)
  let placed = 0
  for (const s of stock) {
    if (placed >= 2) break
    if (s.code === 'power') continue
    const ref = refs.get(s.item_id)
    if (!ref) continue
    if (s.avail <= Math.max(SELL_SURPLUS, ref.minLot * 2)) continue
    const qty = Math.floor(Math.min(s.avail * SELL_FRACTION, 2000) / ref.minLot) * ref.minLot
    if (qty < ref.minLot) continue
    const price = roundToTick(ref.price * 0.985, ref.tick)
    try {
      const r = await placeOrder(d, {
        worldId, companyId: npc.id, itemCode: s.code, qualityTier: 1,
        side: 'sell', qty, priceLimit: price, orderType: 'limit',
      })
      if (r.status === 'filled' || r.status === 'open' || r.status === 'partial') placed++
    } catch (e) {
      if (!(e instanceof MarketError)) throw e
    }
  }
  return placed
}

async function npcBuy(d: Db, worldId: number, npc: NpcCompany) {
  const refs = await refPrices(d, worldId)
  const needs = await inputNeeds(d, npc.id)
  if (needs.length === 0) return 0
  const stock = new Map((await freeStock(d, npc.id)).map((s) => [s.item_id, s.avail]))
  let placed = 0
  for (const n of needs) {
    if (placed >= 2) break
    const ref = refs.get(n.item_id)
    if (!ref) continue
    const have = stock.get(n.item_id) ?? 0
    if (have >= n.need_h * BUY_HOURS_LOW) continue
    const want = n.need_h * BUY_HOURS_TARGET - have
    const price = roundToTick(ref.price * 1.02, ref.tick)
    const affordable = Math.floor((npc.cash * 0.15) / price / ref.minLot) * ref.minLot
    const qty = Math.min(
      Math.floor(want / ref.minLot) * ref.minLot, affordable)
    if (qty < ref.minLot) continue
    try {
      const r = await placeOrder(d, {
        worldId, companyId: npc.id, itemCode: n.code, qualityTier: 1,
        side: 'buy', qty, priceLimit: price, orderType: 'limit',
      })
      if (r.status === 'filled' || r.status === 'open' || r.status === 'partial') placed++
    } catch (e) {
      if (!(e instanceof MarketError)) throw e
    }
  }
  return placed
}

/** Upgrade → nová stavba → výzkum; první úspěch končí. */
async function npcExpand(d: Db, worldId: number, npc: NpcCompany): Promise<string | null> {
  // 1) upgrade vlastní budovy
  const upgradable = await many<{ id: number; level: number; capex: number }>(
    d,
    `SELECT b.id::int, b.level::int, bt.base_capex::float8 AS capex
       FROM buildings b JOIN building_types bt ON bt.id = b.type_id
      WHERE b.company_id=$1 AND b.level < bt.max_level AND b.status <> 'construction'
      ORDER BY random() LIMIT 3`,
    [npc.id],
  )
  for (const u of upgradable) {
    const cost = upgradeCost(u.capex, u.level)
    if (npc.cash < cost * 2.5) continue
    try {
      await upgradeBuilding(d, worldId, npc.id, u.id)
      return `upgrade #${u.id} → L${u.level + 1}`
    } catch (e) {
      if (!(e instanceof MarketError)) throw e
    }
  }

  // 2) expanze: volný pozemek u silnice + budova podle biomu
  if (npc.cash > EXPAND_CASH * 1.5) {
    const plots = await many<{ id: number; type: string; value: number }>(
      d,
      `SELECT p.id::int, p.plot_type::text AS type, p.assessed_value::float8 AS value
         FROM plots p
        WHERE p.world_id=$1 AND p.status='unowned' AND p.plot_type <> 'road'
          AND EXISTS (SELECT 1 FROM plots r
                       WHERE r.world_id=p.world_id AND r.plot_type='road'
                         AND abs(r.x - p.x) + abs(r.y - p.y) = 1)
        ORDER BY random() LIMIT 6`,
      [worldId],
    )
    for (const p of plots) {
      const bts = await many<{ code: string; capex: number }>(
        d,
        `SELECT bt.code, bt.base_capex::float8 AS capex FROM building_types bt
          WHERE bt.required_plot_type = $1 AND bt.base_capex < $2
          ORDER BY random() LIMIT 2`,
        [p.type, npc.cash * 0.4],
      )
      const bt = bts.find((x) => p.value + x.capex < npc.cash * 0.6)
      if (!bt) continue
      try {
        await buyPlot(d, worldId, npc.id, p.id)
        await buildBuilding(d, worldId, npc.id, p.id, bt.code)
        return `${bt.code} na pozemku ${p.id}`
      } catch (e) {
        if (!(e instanceof MarketError)) throw e
      }
    }
  }

  // 3) výzkum, na který má
  const { items } = await researchList(d, worldId, npc.id)
  const affordable = items
    .filter((i) => i.state === 'available' && i.cost < npc.cash * 0.3)
    .sort((a, b) => a.cost - b.cost)
  if (affordable.length > 0) {
    try {
      await startResearch(d, worldId, npc.id, affordable[0]!.code)
      return `výzkum ${affordable[0]!.code}`
    } catch (e) {
      if (!(e instanceof MarketError)) throw e
    }
  }
  return null
}

export type NpcTickSummary = {
  npcs: number; sells: number; buys: number; expansions: string[]
}

/** Jedno kolo rozhodování všech NPC firem. Volá runTick ve své transakci. */
export async function npcTick(
  d: Db, worldId: number, cycles: number,
): Promise<NpcTickSummary> {
  const npcs = await npcCompanies(d, worldId)
  const sum: NpcTickSummary = { npcs: npcs.length, sells: 0, buys: 0, expansions: [] }

  for (const npc of npcs) {
    try {
      if (npc.cash < 100) continue
      const open = await openOrderCount(d, npc.id)
      if (open < MAX_OPEN_ORDERS) {
        sum.sells += await npcSell(d, worldId, npc)
        sum.buys += await npcBuy(d, worldId, npc)
      }
      if (npc.cash > EXPAND_CASH && Math.random() < EXPAND_P * cycles) {
        const act = await npcExpand(d, worldId, npc)
        if (act) sum.expansions.push(`${npc.name}: ${act}`)
      }
    } catch (e) {
      // NPC svět nesmí shodit tick — logujeme a jedeme dál
      console.error(`  ⚠️  NPC ${npc.id} selhalo:`, e instanceof Error ? e.message : e)
    }
  }
  return sum
}

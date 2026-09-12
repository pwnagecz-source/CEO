/**
 * Logistika Fáze D: silniční síť, napojení produkce, najatí stavebníci.
 *
 * Model je záměrně „deskovkový“:
 *   - **státní síť** = pozemky typu `road` (osy + okruh kolem města ze seedu),
 *   - **hráčské silnice** = budova `road` na vlastním pozemku (libovolný terén),
 *   - produkční budova běží jen když SOMEDEDNÍ dlaždice jejího pozemku leží
 *     v souvislé síti se státním tahem (BFS přes silniční dlaždice).
 *
 * Bez napojení je budova `disconnected` — a hráč má dvě cesty:
 *   1. DIY: koupí pozemky a postaví na ně `road` sám,
 *   2. najme stavební firmu (`hireRoadBuilders`), která spočítá nejkratší
 *      schůdnou trasu, vykoupí pozemky a postaví silnici za poplatek.
 *
 * Peníze: výkup půdy → `sink_land_purchase`, poplatek → `sink_capex`.
 * Oboje mizí z ekonomiky, takže makro identita M2 ≡ ΔM drží.
 */
import { MarketError } from './market.ts'
import { post, round6 } from './ledger.ts'
import type { Db } from './db.ts'
import { many, one } from './db.ts'

/** Poplatek stavební firmě za dlaždici silnice (kromě výkupu půdy). */
export const ROAD_FEE = 250

/**
 * Výkupní cena půdy pod veřejnou silnicí: 30 % odhadní ceny.
 * Plná cena by z napojení dělala nedostupný luxus; třicet procent pořád bolí
 * dost na to, aby hráč plánoval, KDE postaví — a zároveň drží peníze
 * mimo oběh (sink), takže inflace z ničeho nevzniká.
 */
export const LAND_BUYOUT = 0.30

type RoadTile = { id: number; x: number; y: number; is_road: boolean; main: boolean }

/** Načte dlaždice silnic: státní (`plot_type='road'`) i hráčské (budova road). */
async function roadTiles(d: Db, worldId: number): Promise<RoadTile[]> {
  return many<RoadTile>(
    d,
    `SELECT p.id::int AS id, p.x::int AS x, p.y::int AS y,
            (p.plot_type = 'road' OR p.plot_type = 'water') AS main,
            (p.plot_type = 'road' OR p.plot_type = 'water' OR bt.code = 'road') AS is_road
       FROM plots p
       LEFT JOIN buildings b ON b.plot_id = p.id
       LEFT JOIN building_types bt ON bt.id = b.type_id
       WHERE p.world_id = $1`,
    [worldId],
  )
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

/**
 * BFS ze všech státních tahů A řek přes souvislé dopravní dlaždice.
 * Řeka je přírodní dálnice: pozemek s vodou sousedící je napojený zdarma
 * (nábřeží = prémiová logistická parcela, jako ve skutečném světě).
 * Vrací dlaždice, které jsou „napojené“ — a tedy i pozemky, jejichž
 * produkce má kudy odvážet.
 */
export async function roadNetwork(d: Db, worldId: number) {
  const tiles = await roadTiles(d, worldId)
  const byPos = new Map<string, RoadTile>()
  for (const t of tiles) byPos.set(`${t.x},${t.y}`, t)

  const connected = new Set<number>()
  const queue: RoadTile[] = tiles.filter((t) => t.main)
  for (const t of queue) connected.add(t.id)
  while (queue.length > 0) {
    const t = queue.pop()!
    for (const [dx, dy] of N4) {
      const n = byPos.get(`${t.x + dx},${t.y + dy}`)
      if (n && n.is_road && !connected.has(n.id)) {
        connected.add(n.id)
        queue.push(n)
      }
    }
  }
  return { tiles, connected, byPos }
}

/** Je pozemek napojený? (sousední dlaždice leží v souvislé silniční síti) */
export function isPlotConnected(
  net: { connected: Set<number>; byPos: Map<string, RoadTile> },
  x: number, y: number,
): boolean {
  for (const [dx, dy] of N4) {
    const n = net.byPos.get(`${x + dx},${y + dy}`)
    if (n && net.connected.has(n.id)) return true
  }
  return false
}

type Passable = { id: number; x: number; y: number; value: number; owned: boolean }

/**
 * Nejkratší schůdná trasa pro silnici od pozemku budovy k napojené síti.
 * Schůdné = volný pozemek (ne silnice, bez budovy) nebo vlastní prázdný pozemek.
 * Vrací seznam pozemků OD SOUSEDA budovy AŽ po dlaždici, která se dotkne sítě
 * (poslední prvek už je silniční dlaždice a nepřestavuje se).
 */
export async function shortestRoadPath(
  d: Db, worldId: number, plotId: number, companyId: number,
): Promise<{ path: Passable[]; cost: number } | null> {
  const start = await one<{ x: number; y: number }>(
    d, `SELECT x::int AS x, y::int AS y FROM plots WHERE id=$1`, [plotId])
  if (!start) return null

  const rows = await many<{
    id: number; x: number; y: number; value: number
    mine: boolean; owned: boolean; road: boolean; built: boolean
  }>(
    d,
    `SELECT p.id::int AS id, p.x::int AS x, p.y::int AS y,
            p.assessed_value::float8 AS value,
            (p.owner_company_id = $2) AS mine,
            (p.owner_company_id IS NOT NULL) AS owned,
            (p.plot_type = 'road' OR bt.code = 'road') AS road,
            (b.id IS NOT NULL) AS built
       FROM plots p
       LEFT JOIN buildings b ON b.plot_id = p.id
       LEFT JOIN building_types bt ON bt.id = b.type_id
      WHERE p.world_id=$1 AND p.id <> $3`,
    [worldId, companyId, plotId],
  )
  const byPos = new Map<string, typeof rows[number]>()
  for (const r of rows) byPos.set(`${r.x},${r.y}`, r)

  // BFS s frontou; rodiče pro rekonstrukci trasy
  const parent = new Map<string, string | null>()
  const startKey = `${start.x},${start.y}`
  parent.set(startKey, null)
  const queue: [number, number][] = [[start.x, start.y]]
  let hit: string | null = null

  while (queue.length > 0 && !hit) {
    const [cx, cy] = queue.shift()!
    const here = byPos.get(`${cx},${cy}`)
    // kdybychom vkročili na silniční dlaždici, jsme napojení (konec trasy)
    if (here?.road && `${cx},${cy}` !== startKey) { hit = `${cx},${cy}`; break }
    for (const [dx, dy] of N4) {
      const k = `${cx + dx},${cy + dy}`
      if (parent.has(k)) continue
      const n = byPos.get(k)
      if (!n) continue
      // schůdné: silniční dlaždice (cíl), volný pozemek bez budovy,
      // nebo vlastní pozemek bez budovy. Cizí vlastněné = neprůchozí.
      const walkable = n.road || (!n.built && (n.mine || !n.owned))
      if (!walkable) continue
      parent.set(k, `${cx},${cy}`)
      queue.push([cx + dx, cy + dy])
    }
  }
  if (!hit) return null

  const path: Passable[] = []
  let cur: string | null = hit
  while (cur && cur !== startKey) {
    const parts = cur.split(',')
    const x = Number(parts[0]); const y = Number(parts[1])
    const r = byPos.get(cur)!
    if (!r.road) path.unshift({ id: r.id, x, y, value: r.value, owned: r.mine })
    cur = parent.get(cur) ?? null
  }
  const cost = round6(path.reduce((s, p) => s + (p.owned ? 0 : p.value * LAND_BUYOUT), 0) +
    path.length * ROAD_FEE)
  return { path, cost }
}

/**
 * Najmutí stavební firmy: vykoupí trasu, přestaví ji na státní silnici
 * a vrátí cenu. Vše v jedné transakci (volá se přes tx()).
 */
export async function hireRoadBuilders(
  d: Db, worldId: number, companyId: number, plotId: number,
): Promise<{ tiles: number; cost: number }> {
  const found = await shortestRoadPath(d, worldId, plotId, companyId)
  if (!found || found.path.length === 0) {
    throw new MarketError('není kudy napojit — kolem jsou jen cizí pozemky nebo chráněný terén',
      'no_route')
  }
  const cashRow = await one<{ b: string }>(
    d,
    `SELECT COALESCE(SUM(balance),0)::text AS b FROM accounts
      WHERE world_id=$1 AND owner_type='company' AND owner_id=$2 AND kind='cash'`,
    [worldId, companyId],
  )
  const cash = Number(cashRow?.b ?? 0)
  if (cash < found.cost) {
    throw new MarketError(
      `stavební firma chce ${found.cost.toLocaleString('cs-CZ')} Kč, máš jen ` +
      `${Math.floor(cash).toLocaleString('cs-CZ')} Kč`, 'insufficient_funds')
  }

  const land = round6(
    found.path.reduce((s, p) => s + (p.owned ? 0 : p.value * LAND_BUYOUT), 0))
  const fee = round6(found.path.length * ROAD_FEE)
  if (land > 0) {
    await post(d, worldId, [
      { party: { type: 'company', id: companyId }, kind: 'cash', amount: -land,
        moneyFlow: 'sink', refType: 'plot', refId: plotId },
      { party: { type: 'system' }, kind: 'sink_land_purchase', amount: land,
        moneyFlow: 'sink', refType: 'plot', refId: plotId },
    ], { kind: 'land_purchase' })
  }
  if (fee > 0) {
    await post(d, worldId, [
      { party: { type: 'company', id: companyId }, kind: 'cash', amount: -fee,
        moneyFlow: 'sink', refType: 'plot', refId: plotId },
      { party: { type: 'system' }, kind: 'sink_capex', amount: fee,
        moneyFlow: 'sink', refType: 'plot', refId: plotId },
    ], { kind: 'building_capex' })
  }
  for (const p of found.path) {
    await d.query(
      `UPDATE plots SET plot_type='road', status='unowned', owner_company_id=NULL
        WHERE id=$1`,
      [p.id],
    )
  }
  return { tiles: found.path.length, cost: found.cost }
}

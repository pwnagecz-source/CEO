/**
 * Cargo simulace: hráč si zakládá dopravní trasy (odkud → kam), nic nejezdí
 * „samo od sebe“. Každá trasa má vozy/lokality, hodinovou kapacitu a sazbu;
 * tick po ní přesouvá ZBOŽÍ mezi sklady budov a účtuje přepravné.
 *
 * Pravidla sítě:
 *   - 🚚 truck: vede po silnicích (státní `plot_type='road'` + hráčské budovy
 *     `road`). Krajní body jsou budovy, které k síti sousedí (4-neighbor).
 *   - 🚢 ship: vede po vodě (`plot_type='water'`), krajní body musí sousedit
 *     se stejnou řekou.
 *
 * Ekonomika (vše přes podvojný ledger, peníze mizí → M2 identita drží):
 *   - setup vozového parku při založení → `sink_transport` (journal `transport`)
 *   - přepravné se účtuje ZA PŘEVEZENOU JEDNOTKU (nic se nevozí → nic
 *     nestojí; žádná skrytá daň za zapomenutou trasu)
 *
 * Proč je cargo potřeba i když procesory berou vstupy „napříč firmou“:
 * budova, která má plný vlastní sklad (`full`), přestane vyrábět. Trasa ji
 * vyprázdní do skladu/obchodu — to je skutečná logistická smyčka hry.
 */
import { MarketError } from './market.ts'
import { balance, post, round6 } from './ledger.ts'
import { companyEffects } from './progression.ts'
import type { Db } from './db.ts'
import { many, one } from './db.ts'

export type RouteMode = 'truck' | 'ship'

/** Jednorázová koupě vozu/lodi při založení trasy (Kč/ks). */
export const SETUP_PER_VEHICLE: Record<RouteMode, number> = { truck: 250, ship: 1500 }
/** Přepravné při plném vytížení (Kč/herní hodinu na vozidlo): základ + za dlaždici. */
const FEE_BASE: Record<RouteMode, number> = { truck: 1.2, ship: 2.0 }
const FEE_PER_TILE: Record<RouteMode, number> = { truck: 0.12, ship: 0.06 }
/** Kapacita jednoho vozidla (ks zboží za herní hodinu). */
export const CAPACITY_PER_VEHICLE: Record<RouteMode, number> = { truck: 150, ship: 600 }

export type PathTile = { x: number; y: number }

export type RouteQuote = {
  mode: RouteMode
  distance: number
  path: PathTile[]
  setupPerVehicle: number
  feePerHour: number
  capacityPerHour: number
}

type NetTile = { x: number; y: number; road: boolean; water: boolean }

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

async function netTiles(d: Db, worldId: number): Promise<Map<string, NetTile>> {
  const rows = await many<{ x: number; y: number; type: string; player_road: boolean }>(
    d,
    `SELECT p.x::int AS x, p.y::int AS y, p.plot_type::text AS type,
            (bt.code = 'road') AS player_road
       FROM plots p
       LEFT JOIN buildings b ON b.plot_id = p.id
       LEFT JOIN building_types bt ON bt.id = b.type_id
      WHERE p.world_id = $1`,
    [worldId],
  )
  const byPos = new Map<string, NetTile>()
  for (const r of rows) {
    byPos.set(`${r.x},${r.y}`, {
      x: r.x, y: r.y,
      road: r.type === 'road' || r.player_road,
      water: r.type === 'water',
    })
  }
  return byPos
}

/**
 * Nejkratší trasa mezi dvěma pozemky po síti daného druhu.
 * Krajní dlaždice (budovy) do sítě nepatří — BFS startuje z budovy, projde
 * průchozími dlaždicemi (road pro truck / water pro ship) a končí na budově.
 */
function findPath(
  byPos: Map<string, NetTile>,
  from: PathTile, to: PathTile, mode: RouteMode,
): PathTile[] | null {
  const passable = (t: NetTile) => (mode === 'truck' ? t.road : t.water)
  const startKey = `${from.x},${from.y}`
  const endKey = `${to.x},${to.y}`
  if (startKey === endKey) return null

  const parent = new Map<string, string | null>([[startKey, null]])
  const queue: string[] = [startKey]
  while (queue.length > 0) {
    const key = queue.shift()!
    if (key === endKey) break
    const kp = key.split(',')
    const cx = Number(kp[0]); const cy = Number(kp[1])
    for (const [dx, dy] of N4) {
      const k = `${cx + dx},${cy + dy}`
      if (parent.has(k)) continue
      const n = byPos.get(k)
      if (!n) continue
      // vstoupit smíme na průchozí dlaždici sítě, nebo rovnou na cílovou budovu
      if (!passable(n) && k !== endKey) continue
      parent.set(k, key)
      queue.push(k)
    }
  }
  if (!parent.has(endKey)) return null
  const path: PathTile[] = []
  let cur: string | null = endKey
  while (cur) {
    const cp = cur.split(',')
    path.unshift({ x: Number(cp[0]), y: Number(cp[1]) })
    cur = parent.get(cur) ?? null
  }
  return path
}

type Endpoint = { plotId: number; x: number; y: number; building: string | null }

async function loadEndpoint(
  d: Db, worldId: number, companyId: number, plotId: number, label: string,
): Promise<Endpoint> {
  const row = await one<{ id: number; x: number; y: number; owner: string | null; b: string | null }>(
    d,
    `SELECT p.id::int AS id, p.x::int AS x, p.y::int AS y,
            p.owner_company_id::text AS owner, bt.name AS b
       FROM plots p
       LEFT JOIN buildings bd ON bd.plot_id = p.id
       LEFT JOIN building_types bt ON bt.id = bd.type_id
      WHERE p.id = $1 AND p.world_id = $2`,
    [plotId, worldId],
  )
  if (!row) throw new MarketError(`${label}: pozemek nenalezen`, 'not_found')
  if (row.owner === null || Number(row.owner) !== companyId) {
    throw new MarketError(`${label}: trasa musí vést mezi tvými pozemky`, 'not_yours')
  }
  if (row.b === null) {
    throw new MarketError(`${label}: na pozemku nestojí budova — není co nakládat/vykládat`, 'no_building')
  }
  return { plotId: row.id, x: row.x, y: row.y, building: row.b }
}

/** Nabídka pro oba druhy dopravy; prázdné pole = není kudy vézt. */
export async function quoteRoute(
  d: Db, worldId: number, companyId: number,
  fromPlotId: number, toPlotId: number,
): Promise<{ from: Endpoint; to: Endpoint; modes: RouteQuote[] }> {
  if (fromPlotId === toPlotId) {
    throw new MarketError('trasa musí vést mezi dvěma různými pozemky', 'no_route')
  }
  const from = await loadEndpoint(d, worldId, companyId, fromPlotId, 'odkaz')
  const to = await loadEndpoint(d, worldId, companyId, toPlotId, 'cíl')
  const byPos = await netTiles(d, worldId)

  const modes: RouteQuote[] = []
  for (const mode of ['truck', 'ship'] as const) {
    const path = findPath(byPos, from, to, mode)
    if (!path) continue
    const distance = path.length
    modes.push({
      mode, distance, path,
      setupPerVehicle: SETUP_PER_VEHICLE[mode],
      feePerHour: round6(FEE_BASE[mode] + FEE_PER_TILE[mode] * distance),
      capacityPerHour: CAPACITY_PER_VEHICLE[mode],
    })
  }
  if (modes.length === 0) {
    throw new MarketError(
      'není kudy vézt: budovy nespojuje silnice ani řeka — postav silnice ' +
      '(nebo najmi stavební firmu) či využívej nábřeží', 'no_route')
  }
  return { from, to, modes }
}

export type TransportRoute = {
  id: string; from: Endpoint; to: Endpoint; mode: RouteMode
  vehicles: number; distance: number; path: PathTile[]
  feePerHour: number; capacityPerHour: number
  hauledTotal: number; status: string
}

/** Založení trasy: koupě vozového parku (sink) + zápis. Vše v jedné transakci. */
export async function createRoute(
  d: Db, worldId: number, companyId: number,
  fromPlotId: number, toPlotId: number, mode: RouteMode, vehiclesRaw: number,
): Promise<TransportRoute> {
  const vehicles = Math.max(1, Math.min(8, Math.floor(vehiclesRaw)))
  const q = await quoteRoute(d, worldId, companyId, fromPlotId, toPlotId)
  const offer = q.modes.find((m) => m.mode === mode)
  if (!offer) {
    throw new MarketError(
      mode === 'ship' ? 'po suchu loď nepojede — body nespojuje řeka'
                      : 'mezi budovami nevede silnice', 'no_route')
  }
  const dup = await one<{ id: string }>(
    d,
    `SELECT id::text FROM transport_routes
      WHERE from_plot_id=$1 AND to_plot_id=$2 AND mode=$3`,
    [fromPlotId, toPlotId, mode],
  )
  if (dup) throw new MarketError('taková trasa už existuje', 'duplicate')

  const setup = round6(offer.setupPerVehicle * vehicles)
  const cash = await balance(d, worldId, { type: 'company', id: companyId }, 'cash')
  if (cash < setup) {
    throw new MarketError(
      `vozový park stojí ${setup.toLocaleString('cs-CZ')} Kč, máš jen ` +
      `${Math.floor(cash).toLocaleString('cs-CZ')} Kč`, 'insufficient_funds')
  }
  await post(d, worldId, [
    { party: { type: 'company', id: companyId }, kind: 'cash', amount: -setup,
      moneyFlow: 'sink', refType: 'transport_route' },
    { party: { type: 'system' }, kind: 'sink_transport', amount: setup,
      moneyFlow: 'sink', refType: 'transport_route' },
  ], { kind: 'transport' })

  const feePerHour = round6(offer.feePerHour * vehicles)
  const capacityPerHour = round6(offer.capacityPerHour * vehicles)
  const row = await one<{ id: string }>(
    d,
    `INSERT INTO transport_routes
       (world_id, company_id, from_plot_id, to_plot_id, mode, vehicles,
        distance, path, fee_per_hour, capacity_per_hour)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     RETURNING id::text`,
    [worldId, companyId, fromPlotId, toPlotId, mode, vehicles, offer.distance,
     JSON.stringify(offer.path), feePerHour, capacityPerHour],
  )
  return {
    id: row!.id, from: q.from, to: q.to, mode, vehicles,
    distance: offer.distance, path: offer.path,
    feePerHour, capacityPerHour, hauledTotal: 0, status: 'active',
  }
}

export async function listRoutes(
  d: Db, worldId: number, companyId: number,
): Promise<TransportRoute[]> {
  const rows = await many<{
    id: string; mode: RouteMode; vehicles: number; distance: number
    path: PathTile[] | string; fee_per_hour: number; capacity_per_hour: number
    hauled_total: number; status: string
    fx: number; fy: number; fb: string | null
    tx: number; ty: number; tb: string | null
    from_plot_id: number; to_plot_id: number
  }>(
    d,
    `SELECT r.id::text, r.mode::text AS mode, r.vehicles::int, r.distance::int,
            r.path, r.fee_per_hour::float8, r.capacity_per_hour::float8,
            r.hauled_total::float8, r.status::text,
            pf.x::int AS fx, pf.y::int AS fy, btf.name AS fb,
            r.from_plot_id::int, r.to_plot_id::int,
            pt.x::int AS tx, pt.y::int AS ty, btt.name AS tb
       FROM transport_routes r
       JOIN plots pf ON pf.id = r.from_plot_id
       JOIN plots pt ON pt.id = r.to_plot_id
       LEFT JOIN buildings bf ON bf.plot_id = pf.id
       LEFT JOIN building_types btf ON btf.id = bf.type_id
       LEFT JOIN buildings bt ON bt.plot_id = pt.id
       LEFT JOIN building_types btt ON btt.id = bt.type_id
      WHERE r.world_id=$1 AND r.company_id=$2
      ORDER BY r.id`,
    [worldId, companyId],
  )
  return rows.map((r) => ({
    id: r.id,
    from: { plotId: r.from_plot_id, x: r.fx, y: r.fy, building: r.fb },
    to: { plotId: r.to_plot_id, x: r.tx, y: r.ty, building: r.tb },
    mode: r.mode, vehicles: r.vehicles, distance: r.distance,
    path: typeof r.path === 'string' ? JSON.parse(r.path) as PathTile[] : r.path,
    feePerHour: r.fee_per_hour, capacityPerHour: r.capacity_per_hour,
    hauledTotal: r.hauled_total, status: r.status,
  }))
}

export async function deleteRoute(
  d: Db, worldId: number, companyId: number, routeId: number,
): Promise<void> {
  const hit = await one<{ id: string }>(
    d,
    `DELETE FROM transport_routes
      WHERE id=$1 AND world_id=$2 AND company_id=$3 RETURNING id::text`,
    [routeId, worldId, companyId],
  )
  if (!hit) throw new MarketError('trasa nenalezena (nebo není tvoje)', 'not_found')
}

/* ── cargo v ticku ──────────────────────────────────────────────────────── */

/** Sklad firmy na pozemku; založí se, když chybí (stejně jako v ticku). */
async function plotInventory(
  d: Db, worldId: number, companyId: number, plotId: number,
): Promise<number> {
  const hit = await one<{ id: string }>(
    d, `SELECT id::text FROM inventories WHERE company_id=$1 AND plot_id=$2 LIMIT 1`,
    [companyId, plotId],
  )
  if (hit) return Number(hit.id)
  const inv = await one<{ id: string }>(
    d,
    `INSERT INTO inventories (world_id, company_id, plot_id, name)
     VALUES ($1,$2,$3,'provoz') RETURNING id::text`,
    [worldId, companyId, plotId],
  )
  return Number(inv!.id)
}

type ActiveRoute = {
  id: number; company_id: number; from_plot_id: number; to_plot_id: number
  mode: RouteMode; fee_per_hour: number; capacity_per_hour: number
}

/**
 * Přesune zboží po aktivních trasách: z provozního skladu „odkud“ do skladu
 * „kam“, maximálně `capacity_per_hour × cycles` ks, a naúčtuje přepravné
 * za skutečně svezené množství (fee_per_hour / capacity_per_hour × ks).
 */
export async function haulCargo(
  d: Db, worldId: number, cycles: number,
): Promise<{ routes: number; units: number; fees: number }> {
  const routes = await many<ActiveRoute>(
    d,
    `SELECT r.id::int, r.company_id::int, r.from_plot_id::int, r.to_plot_id::int,
            r.mode::text AS mode, r.fee_per_hour::float8, r.capacity_per_hour::float8
       FROM transport_routes r
      WHERE r.world_id=$1 AND r.status='active'
      ORDER BY r.id`,
    [worldId],
  )
  let units = 0
  let fees = 0
  let active = 0
  // Fáze F: výzkum (dispečink/návěsy) a ředitel logistiky zvyšují kapacitu tras
  const capMult = new Map<number, number>()
  for (const r of routes) {
    let mult = capMult.get(r.company_id)
    if (mult === undefined) {
      mult = (await companyEffects(d, r.company_id)).transport
      capMult.set(r.company_id, mult)
    }
    const fromInv = await one<{ id: string }>(
      d, `SELECT id::text FROM inventories WHERE company_id=$1 AND plot_id=$2 LIMIT 1`,
      [r.company_id, r.from_plot_id],
    )
    if (!fromInv) continue
    const capacity = r.capacity_per_hour * cycles * mult

    // kolik je v odkadišti volných zásob (nerezervovaných)
    const stock = await many<{ id: number; item_id: number; avail: number }>(
      d,
      `SELECT ii.id::int, ii.item_id::int,
              (ii.quantity - ii.reserved_qty)::float8 AS avail
         FROM inventory_items ii
        WHERE ii.inventory_id=$1 AND ii.quantity - ii.reserved_qty > 0
        ORDER BY ii.id`,
      [Number(fromInv.id)],
    )
    if (stock.length === 0) continue

    // volné místo v cílovém skladu (budova + bonus inventáře)
    const toInv = await plotInventory(d, worldId, r.company_id, r.to_plot_id)
    const dest = await one<{ storage: number; used: number; extra: number }>(
      d,
      `SELECT COALESCE(bt.base_storage, 0)::float8 AS storage,
              COALESCE((SELECT SUM(ii.quantity) FROM inventory_items ii
                         WHERE ii.inventory_id=$2), 0)::float8 AS used,
              COALESCE(v.extra_capacity, 0)::float8 AS extra
         FROM inventories v
         LEFT JOIN buildings b ON b.plot_id = v.plot_id
         LEFT JOIN building_types bt ON bt.id = b.type_id
        WHERE v.id=$1`,
      [toInv, toInv],
    )
    const free = Math.max(0, (dest?.storage ?? 0) + (dest?.extra ?? 0) - (dest?.used ?? 0))
    const room = Math.min(capacity, free)
    if (room <= 0.0001) continue

    let left = room
    let moved = 0
    for (const row of stock) {
      if (left <= 0.0001) break
      const take = round6(Math.min(left, row.avail))
      if (take <= 0) continue
      await d.query(
        `UPDATE inventory_items SET quantity = quantity - $2, updated_at = now()
          WHERE id = $1`,
        [row.id, take],
      )
      await d.query(
        `INSERT INTO inventory_items (inventory_id, item_id, quality_tier, quantity)
         VALUES ($1,$2,1,$3)
         ON CONFLICT (inventory_id, item_id, quality_tier)
         DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity,
                       updated_at = now()`,
        [toInv, row.item_id, take],
      )
      left -= take
      moved += take
    }
    if (moved <= 0.0001) continue

    // přepravné za svezené jednotky → sink_transport (peníze mizí)
    const unitFee = r.fee_per_hour / r.capacity_per_hour
    const fee = round6(moved * unitFee)
    if (fee > 0) {
      const cash = await balance(d, worldId, { type: 'company', id: r.company_id }, 'cash')
      if (cash < fee) continue   // není na dopravu → zboží zůstává ležet
      await post(d, worldId, [
        { party: { type: 'company', id: r.company_id }, kind: 'cash', amount: -fee,
          moneyFlow: 'sink', refType: 'transport_route', refId: r.id },
        { party: { type: 'system' }, kind: 'sink_transport', amount: fee,
          moneyFlow: 'sink', refType: 'transport_route', refId: r.id },
      ], { kind: 'transport' })
      fees += fee
    }
    await d.query(
      `UPDATE transport_routes
          SET hauled_total = hauled_total + $2, last_haul_at = now()
        WHERE id=$1`,
      [r.id, round6(moved)],
    )
    units += moved
    active++
  }
  return { routes: active, units: round6(units), fees: round6(fees) }
}

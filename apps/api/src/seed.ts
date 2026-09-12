/**
 * Seed světa ze `seed/balance-v0.2.json` (výstup `tools/balance/generate_v0.py`).
 *
 * Ceny se NEPÍŠOU ručně — jsou odvozené cost-plus zdola nahoru, takže žádný
 * řetězec není ztrátový. Viz docs/10-ekonomika-core-loop.md §3.
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './db.ts'
import { many, one } from './db.ts'
import { post, round6, type AccountKind } from './ledger.ts'
import { FEE_MIN, FEE_TAKER } from './market.ts'
import { createRoute } from './transport.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEED_PATH = resolve(HERE, '../../../seed/balance-v0.2.json')

type SeedBuilding = {
  code: string; name: string; plot_type: string; tier: number
  output_item: string; output_qty_per_hour: number
  inputs: Record<string, number>; storage_capacity: number
  capex: number; upkeep_per_hour: number; build_time_seconds: number
  workers: number; target_gross_margin: number; payback_hours: number
  unit_cost: number; exchange_mid_price: number
  retail_base_price: number | null; is_retail_product: boolean
}
type Seed = {
  version: string
  prices: Record<string, number>
  retail_base: Record<string, number>
  plot_rent: Record<string, number>
  plot_value: Record<string, number>
  plot_count: Record<string, number>
  buildings: SeedBuilding[]
}

/** Rozměr světa. Default výrazně větší než původních 24×12; přes env laditelné. */
const GRID_W = Number(process.env.WORLD_W ?? 64)
const GRID_H = Number(process.env.WORLD_H ?? 32)

const WORLD_CODE = process.env.WORLD_CODE ?? 'dev-s01'

const INDUSTRIES: Array<[string, string, number]> = [
  ['energy', 'Energetika', 5],
  ['timber', 'Dřevo', 8],
  ['mining', 'Těžba', 8],
  ['agriculture', 'Zemědělství', 8],
  ['metallurgy', 'Hutnictví', 6],
  ['construction', 'Stavebnictví', 6],
  ['textiles', 'Textil', 6],
  ['electronics', 'Elektronika', 4],
  ['food', 'Potraviny', 6],
  ['manufacturing', 'Strojírenství', 4],
  ['retail', 'Maloobchod', 10],
]

/** přiřazení budovy k odvětví */
function industryFor(code: string): string {
  if (code === 'solar_plant') return 'energy'
  if (code === 'logging_camp' || code === 'sawmill') return 'timber'
  if (['iron_mine', 'quarry', 'oil_rig'].includes(code)) return 'mining'
  if (['grain_farm', 'cotton_farm'].includes(code)) return 'agriculture'
  if (['smelter', 'steel_mill'].includes(code)) return 'metallurgy'
  if (['cement_kiln', 'glass_works'].includes(code)) return 'construction'
  if (['textile_mill', 'garment_factory'].includes(code)) return 'textiles'
  if (['electronics_lab', 'machine_shop'].includes(code)) return 'electronics'
  if (['flour_mill', 'bakery', 'deli'].includes(code)) return 'food'
  if (code === 'refinery') return 'manufacturing'
  return 'manufacturing'
}

function categoryFor(item: string, tier: number): string {
  if (item === 'power') return 'utility'
  return ['raw', 'processed', 'component', 'consumer'][Math.min(tier, 3)] ?? 'consumer'
}

/** krok ceny v order booku — odvozený od řádu ceny (doc 00 §3.5) */
function tickSizeFor(price: number): number {
  if (price < 0.1) return 0.0001
  if (price < 1) return 0.001
  if (price < 10) return 0.01
  if (price < 100) return 0.1
  if (price < 1000) return 1
  return 10
}

/**
 * Deterministické rozložení mřížky (výchozí 40×20). Deposity jsou shluknuté, aby adjacency
 * měla smysl (pila vedle lesního pozemku, huť vedle dolu) a aby spekulace s půdou
 * byla možná. Žádná náhoda → stejný svět při každém seedu.
 */
/**
 * Rozvržení biomů v libovolné velikosti mřížky.
 *
 * Původní verze měla pevné kvóty naladěné pro 24×12; při větší mapě by les
 * „nedosáhl“ na svou kvótu (levý sloupec má jen 3×h dlaždic) a zbytek by
 * zdegeneroval na průmysl. Proto pracujeme s POMĚRY plochy a šířky pásů
 * odvozujeme od rozměrů — svět si drží charakter v jakékoli velikosti.
 */
function layoutPlots(w: number, h: number) {
  const total = w * h
  const frac = (f: number) => Math.round(total * f)
  const cells: Array<{ x: number; y: number; type: string }> = []
  const used = new Set<string>()
  const take = (pred: (x: number, y: number) => boolean, type: string, n: number) => {
    let placed = 0
    for (let y = 0; y < h && placed < n; y++) {
      for (let x = 0; x < w && placed < n; x++) {
        const k = `${x},${y}`
        if (used.has(k) || !pred(x, y)) continue
        used.add(k)
        cells.push({ x, y, type })
        placed++
      }
    }
    return placed
  }

  const waterRows = Math.max(2, Math.round(h * 0.14))   // řeka dole
  const forestCols = Math.max(3, Math.round(w * 0.13))  // les vlevo
  const mineCols = Math.max(4, Math.round(w * 0.13))    // důl vpravo

  // Hlavní státní tahy dřív než biomy: silnice musí protnout i les a vodu
  // (mosty), jinak by deposits neměly kde se napojit. Osy protnou město
  // (bulváry), okruh kolem centra přidáváme až po komerci.
  const hy = Math.floor(h / 2), vx = Math.floor(w / 2)
  take((_x, y) => y === hy, 'road', total)
  take((x) => x === vx, 'road', total)

  take((_x, y) => y >= h - waterRows, 'water', frac(0.07))
  take((x) => x < forestCols, 'forest', frac(0.13))
  take((x, y) => x >= w - mineCols && y < h - waterRows, 'mine', frac(0.11))
  // Energetické koridory: dva svislé pásy po dvou dlaždicích, které lemují
  // město. (Původní tečkovaný vzor `(x+y)%7` vypadal na mapě jako chyba.)
  const u1 = Math.round(w * 0.24), u2 = Math.round(w * 0.73)
  take((x, y) =>
    (x === u1 || x === u1 + 1 || x === u2 || x === u2 + 1) && y < h - waterRows,
    'utility', total)

  // komerce = centrum města, civic = malé jádro, průmysl = všechno ostatní
  const cw = Math.round(w * 0.30), ch = Math.round(h * 0.34)
  take((x, y) => Math.abs(x - w / 2) <= cw / 2 && Math.abs(y - h / 2) <= ch / 2,
       'commercial', frac(0.15))
  // okruh kolem centra: město má páteř, na kterou se hráč napojuje
  const cx0 = Math.round(w / 2 - cw / 2) - 1, cx1 = Math.round(w / 2 + cw / 2) + 1
  const cy0 = Math.round(h / 2 - ch / 2) - 1, cy1 = Math.round(h / 2 + ch / 2) + 1
  take((x, y) =>
    ((x === cx0 || x === cx1) && y >= cy0 && y <= cy1) ||
    ((y === cy0 || y === cy1) && x >= cx0 && x <= cx1), 'road', total)

  take((x, y) => Math.abs(x - w / 2) <= 1 && Math.abs(y - h / 2) <= 1, 'civic', frac(0.02))
  take(() => true, 'industrial', total)

  return cells
}

export async function seedIfEmpty(d: Db): Promise<{ worldId: number; seeded: boolean }> {
  const existing = await one<{ id: string }>(d, `SELECT id FROM worlds WHERE code = $1`, [WORLD_CODE])
  if (existing) return { worldId: Number(existing.id), seeded: false }

  const raw = JSON.parse(await readFile(SEED_PATH, 'utf8')) as Seed
  const now = new Date()
  const ends = new Date(now.getTime() + 120 * 24 * 3600 * 1000)

  // ---- svět -----------------------------------------------------------------
  const world = await one<{ id: string }>(
    d,
    `INSERT INTO worlds (code, name, season_no, status, starts_at, ends_at,
                         plot_grid_w, plot_grid_h, starting_capital)
     VALUES ($1,$2,1,'active',$3,$4,$5,$6,25000)
     RETURNING id`,
    [WORLD_CODE, 'Vývojový svět S01', now, ends, GRID_W, GRID_H],
  )
  const worldId = Number(world!.id)

  // ---- odvětví --------------------------------------------------------------
  const industryId: Record<string, number> = {}
  for (const [code, name, bonus] of INDUSTRIES) {
    const r = await one<{ id: string }>(
      d, `INSERT INTO industries (code, name, bonus_pct) VALUES ($1,$2,$3) RETURNING id`,
      [code, name, bonus],
    )
    industryId[code] = Number(r!.id)
  }

  // ---- položky --------------------------------------------------------------
  const itemId: Record<string, number> = {}
  const buildingByOutput = new Map(raw.buildings.map((b) => [b.output_item, b]))
  const itemNames: Record<string, string> = {
    power: 'Elektřina', log: 'Kláda', iron_ore: 'Železná ruda', grain: 'Obilí',
    stone: 'Kámen', crude_oil: 'Ropa', cotton: 'Bavlna', planks: 'Prkna',
    flour: 'Mouka', cement: 'Cement', glass: 'Sklo', iron_ingot: 'Železný ingot',
    plastic: 'Plast', fabric: 'Textilie', nails: 'Hřebíky', wire: 'Drát',
    steel_sheet: 'Ocelový plech', circuit: 'Obvod', machine_part: 'Strojní díl',
    bread: 'Chléb', sandwich: 'Sendvič', furniture: 'Nábytek', tools: 'Nářadí',
    clothing: 'Oblečení', appliance: 'Spotřebič',
  }
  for (const [code, price] of Object.entries(raw.prices)) {
    const b = buildingByOutput.get(code)
    const tier = b?.tier ?? 0
    const retail = raw.retail_base[code] ?? null
    const r = await one<{ id: string }>(
      d,
      `INSERT INTO items (code, name, category, tier, base_price, retail_base, tick_size,
                          min_lot, max_order_qty, quality_tiers, is_tradeable, is_spoilable,
                          spoil_rate_per_day, stack_size, volume)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,5,true,$10,$11,1,1) RETURNING id`,
      [
        code, itemNames[code] ?? code, categoryFor(code, tier), tier,
        round6(price), retail === null ? null : round6(retail),
        tickSizeFor(price), 1, 1_000_000,
        ['bread', 'sandwich'].includes(code),
        ['bread', 'sandwich'].includes(code) ? 0.05 : 0,
      ],
    )
    itemId[code] = Number(r!.id)
  }

  // ---- typy budov -----------------------------------------------------------
  const buildingTypeId: Record<string, number> = {}
  for (const b of raw.buildings) {
    const r = await one<{ id: string }>(
      d,
      `INSERT INTO building_types
         (code, name, industry_id, required_plot_type, base_capex, base_upkeep_hour,
          base_throughput, base_storage, base_build_seconds, max_level,
          level_throughput_mult, level_upkeep_mult, level_storage_mult,
          upgrade_cost_mult, upgrade_cost_growth, base_workers, is_retail, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,5,0.30,0.22,0.35,0.75,1.85,$10,$11,$12)
       RETURNING id`,
      [
        b.code, b.name, industryId[industryFor(b.code)],
        b.plot_type === 'civic' ? null : b.plot_type,
        round6(b.capex), round6(b.upkeep_per_hour), b.output_qty_per_hour,
        b.storage_capacity, b.build_time_seconds, b.workers, b.is_retail_product,
        `Marže ${(b.target_gross_margin * 100).toFixed(0)} %, návratnost ` +
        `${b.payback_hours.toFixed(0)} h, jedn. náklad ${b.unit_cost.toFixed(4)} $`,
      ],
    )
    buildingTypeId[b.code] = Number(r!.id)
  }

  // ---- recepty + vstupy -----------------------------------------------------
  for (const b of raw.buildings) {
    const r = await one<{ id: string }>(
      d,
      `INSERT INTO recipes (code, building_type_id, output_item_id, output_qty,
                            quality_base, min_building_level)
       VALUES ($1,$2,$3,$4,35,1) RETURNING id`,
      [`r_${b.code}`, buildingTypeId[b.code], itemId[b.output_item], b.output_qty_per_hour],
    )
    const recipeId = Number(r!.id)
    for (const [item, qty] of Object.entries(b.inputs)) {
      if (!itemId[item]) throw new Error(`seed: recept ${b.code} má neznámý vstup '${item}'`)
      await d.query(
        `INSERT INTO recipe_inputs (recipe_id, item_id, qty) VALUES ($1,$2,$3)`,
        [recipeId, itemId[item], qty],
      )
    }
  }

  // ---- budovy Fáze D: silnice a sklad (nejsou v balance JSON) ---------------
  // Silnice = logistická páteř: produkce bez napojení na státní síť neběží.
  // Sklad = kapacita navíc pro celou firmu (tick ji přičítá ke skladům budov).
  for (const [code, name, plot, capex, upkeep, storage, seconds, desc] of [
    ['road', 'Silnice', null, 150, 0.4, 1, 5,
      'Napojení na státní síť. Bez cesty k hlavnímu tahu produkce stojí.'],
    ['warehouse', 'Sklad', 'industrial', 1200, 3, 2500, 60,
      'Přidává skladovou kapacitu všem provozům firmy.'],
    ['harbor', 'Přístav', null, 900, 2, 1000, 45,
      'Staví se u vody: napojí firmu na říční síť a přidá sklad. Lodě vozí zdarma.'],
  ] as Array<[string, string, string | null, number, number, number, number, string]>) {
    const r = await one<{ id: string }>(
      d,
      `INSERT INTO building_types
         (code, name, industry_id, required_plot_type, base_capex, base_upkeep_hour,
          base_throughput, base_storage, base_build_seconds, max_level,
          level_throughput_mult, level_upkeep_mult, level_storage_mult,
          upgrade_cost_mult, upgrade_cost_growth, base_workers, is_retail, description)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,3,0.30,0.22,0.35,0.75,1.85,0,false,$9)
       RETURNING id`,
      [code, name, industryId['construction'], plot, capex, upkeep, storage, seconds, desc],
    )
    buildingTypeId[code] = Number(r!.id)
  }

  // ---- pozemky --------------------------------------------------------------
  const cells = layoutPlots(GRID_W, GRID_H)
  for (const c of cells) {
    const rent = raw.plot_rent[c.type] ?? 0
    const value = raw.plot_value[c.type] ?? 0
    // bohatství depositu: deterministicky 0,85–1,25 podle pozice
    const richness = round6(0.85 + 0.4 * (((c.x * 7 + c.y * 13) % 100) / 100))
    await d.query(
      `INSERT INTO plots (world_id, x, y, plot_type, status, rent_per_hour,
                          assessed_value, deposit_richness)
       VALUES ($1,$2,$3,$4,'unowned',$5,$6,$7)`,
      [worldId, c.x, c.y, c.type, round6(rent), round6(value), richness],
    )
  }

  // ---- systémové účty (faucets + sinks) ------------------------------------
  const systemKinds: AccountKind[] = [
    'faucet_retail', 'faucet_state', 'faucet_starting_grant',
    'sink_exchange_fee', 'sink_plot_rent', 'sink_property_tax', 'sink_wages',
    'sink_upkeep', 'sink_hq_overhead', 'sink_capex', 'sink_demolition',
    'sink_research', 'sink_wealth_tax', 'sink_auction_burn', 'sink_transport',
    'sink_storage_rent', 'sink_contract_tax', 'sink_loan_interest',
    'sink_land_purchase', 'sink_utilities',
  ]
  for (const k of systemKinds) {
    await d.query(
      `INSERT INTO accounts (owner_type, owner_id, world_id, kind, currency, balance)
       VALUES ('system', NULL, $1, $2, 'USD', 0) ON CONFLICT DO NOTHING`,
      [worldId, k],
    )
  }

  await seedDemoCompanies(d, worldId, itemId, buildingTypeId)

  const counts = await one<{ i: string; b: string; r: string; p: string }>(
    d,
    `SELECT (SELECT count(*) FROM items)::text i,
            (SELECT count(*) FROM building_types)::text b,
            (SELECT count(*) FROM recipes)::text r,
            (SELECT count(*) FROM plots)::text p`,
  )
  console.log(
    `  ✅ seed ${raw.version}: ${counts!.i} položek, ${counts!.b} budov, ` +
    `${counts!.r} receptů, ${counts!.p} pozemků (svět #${worldId})`,
  )
  return { worldId, seeded: true }
}

// ---------------------------------------------------------------------------
// Demo firmy — aby order book nebyl prázdný a šlo okamžitě obchodovat
// ---------------------------------------------------------------------------

type DemoCo = {
  name: string; industry: string; cash: number
  buildings: Array<{ code: string; plotType: string; level: number }>
  inventory: Record<string, number>
}

/**
 * Domovské kotvy demo firem. Každá firma dostane budovy co nejblíž své kotvě,
 * takže svět vypadá jako čtyři malé osady, ne jako nahodile rozházené kostky
 * (a ne jako jedna linka podél okraje, což dělalo původní „ORDER BY id LIMIT 1“).
 * Kotvy jsou zvolené podle rozmístění biomů: les vlevo, důl vpravo, voda dole.
 */
const HOME_ANCHORS = [
  { x: Math.round(GRID_W * 0.16), y: Math.round(GRID_H * 0.28) },  // Tvá Firma — les
  { x: Math.round(GRID_W * 0.16), y: Math.round(GRID_H * 0.60) },  // Borealis — les
  { x: Math.round(GRID_W * 0.84), y: Math.round(GRID_H * 0.30) },  // Krupp — důl
  { x: Math.round(GRID_W * 0.50), y: GRID_H - 2 },                 // Panetteria — voda
]

const DEMO_COMPANIES: DemoCo[] = [
  {
    name: 'Tvá Firma', industry: 'timber', cash: 25_000,
    buildings: [
      { code: 'solar_plant', plotType: 'utility', level: 1 },
      { code: 'logging_camp', plotType: 'forest', level: 1 },
      { code: 'sawmill', plotType: 'industrial', level: 1 },
    ],
    inventory: { log: 1200, planks: 340, power: 9000 },
  },
  {
    name: 'Borealis Woods', industry: 'timber', cash: 40_000,
    buildings: [
      { code: 'logging_camp', plotType: 'forest', level: 2 },
      { code: 'sawmill', plotType: 'industrial', level: 1 },
    ],
    inventory: { log: 3000, planks: 900 },
  },
  {
    name: 'Krupp Metall', industry: 'metallurgy', cash: 60_000,
    buildings: [
      { code: 'iron_mine', plotType: 'mine', level: 2 },
      { code: 'smelter', plotType: 'industrial', level: 1 },
    ],
    inventory: { iron_ore: 800, iron_ingot: 260 },
  },
  {
    name: 'Panetteria Verde', industry: 'food', cash: 30_000,
    buildings: [
      { code: 'grain_farm', plotType: 'water', level: 1 },
      { code: 'flour_mill', plotType: 'industrial', level: 1 },
      { code: 'bakery', plotType: 'industrial', level: 1 },
    ],
    inventory: { grain: 2500, flour: 700, bread: 1800 },
  },
]

async function seedDemoCompanies(
  d: Db, worldId: number,
  itemId: Record<string, number>, buildingTypeId: Record<string, number>,
) {
  const companyIds: number[] = []

  for (const [idx, co] of DEMO_COMPANIES.entries()) {
    const user = await one<{ id: string }>(
      d,
      `INSERT INTO users (email, password_hash, display_name, email_verified_at)
       VALUES ($1,'argon2id$demo', $2, now()) RETURNING id`,
      [`demo${idx}@ceo.local`, co.name],
    )
    const company = await one<{ id: string }>(
      d,
      `INSERT INTO companies (user_id, world_id, name, industry_id, status,
                              prestige_level, legacy_points)
       VALUES ($1,$2,$3,(SELECT id FROM industries WHERE code=$4),'active',0,0)
       RETURNING id`,
      [Number(user!.id), worldId, co.name, co.industry],
    )
    const companyId = Number(company!.id)
    companyIds.push(companyId)

    // Startovní kapitál = faucet (tisk peněz) → musí jít přes ledger.
    // ZNAMÉNKA: firma peníze DOSTÁVÁ (+cash), faucet účet je ZDROJ a jde do mínusu.
    // accounts_no_overdraft to dovoluje jen proto, že faucet je owner_type='system'
    // — přesně tak je navržen: záporný zůstatek systémového účtu = množství peněz,
    // které bylo do ekonomiky vytvořeno.
    await post(d, worldId, [
      { party: { type: 'system' }, kind: 'faucet_starting_grant', amount: -round6(co.cash),
        moneyFlow: 'faucet', refType: 'company', refId: companyId },
      { party: { type: 'company', id: companyId }, kind: 'cash', amount: round6(co.cash),
        moneyFlow: 'faucet', refType: 'company', refId: companyId },
    ], { kind: 'starting_grant' })

    // budovy + pozemky
    let primaryPlotId: number | null = null
    for (const b of co.buildings) {
      // Nejbližší volný pozemek správného biomu k domovské kotvě firmy.
      const anchor = HOME_ANCHORS[idx % HOME_ANCHORS.length] ?? { x: 12, y: 6 }
      // Demo firmy staví u hlavního tahu: bez napojení by jejich produkce
      // stála a nový hráč by viděl mrtvý svět místo živé ekonomiky.
      const plot = await one<{ id: string }>(
        d,
        `SELECT p.id FROM plots p
          WHERE p.world_id = $1 AND p.plot_type = $2 AND p.status = 'unowned'
            AND EXISTS (SELECT 1 FROM plots n
                         WHERE n.world_id = $1 AND n.plot_type = 'road'
                           AND abs(n.x - p.x) + abs(n.y - p.y) = 1)
          ORDER BY (p.x - $3) * (p.x - $3) + (p.y - $4) * (p.y - $4)
          LIMIT 1`,
        [worldId, b.plotType, anchor.x, anchor.y],
      )
      if (!plot) throw new Error(`seed: došly pozemky typu ${b.plotType}`)
      const plotId = Number(plot.id)
      primaryPlotId ??= plotId
      await d.query(
        `UPDATE plots SET status='owned', owner_company_id=$1, acquired_at=now(),
                          acquired_for=0 WHERE id=$2`,
        [companyId, plotId],
      )
      const bt = await one<{ capex: string; storage: string; throughput: string }>(
        d,
        `SELECT base_capex::float8::text capex, base_storage::float8::text storage,
                base_throughput::float8::text throughput
           FROM building_types WHERE id = $1`,
        [buildingTypeId[b.code]],
      )
      await d.query(
        `INSERT INTO buildings (world_id, company_id, plot_id, type_id, level, status,
                                completed_at, last_settled_at)
         VALUES ($1,$2,$3,$4,$5,'idle',now(),now())`,
        [worldId, companyId, plotId, buildingTypeId[b.code], b.level],
      )
      void bt
    }

    // primární sklad
    const inv = await one<{ id: string }>(
      d,
      `INSERT INTO inventories (world_id, company_id, plot_id, name, is_primary)
       VALUES ($1,$2,$3,'HQ',true) RETURNING id`,
      [worldId, companyId, primaryPlotId!],
    )
    const inventoryId = Number(inv!.id)
    for (const [item, qty] of Object.entries(co.inventory)) {
      await d.query(
        `INSERT INTO inventory_items (inventory_id, item_id, quality_tier, quantity, reserved_qty)
         VALUES ($1,$2,1,$3,0)
         ON CONFLICT (inventory_id, item_id, quality_tier)
         DO UPDATE SET quantity = EXCLUDED.quantity`,
        [inventoryId, itemId[item], qty],
      )
    }
  }

  // retail obchody pro firmy, které mají bakery/deli (faucet cesta)
  await d.query(
    `INSERT INTO retail_stores (world_id, company_id, building_id, level, shelf_slots,
                                max_units_per_hour)
     SELECT b.world_id, b.company_id, b.id, 1, 3, 200
       FROM buildings b
       JOIN building_types bt ON bt.id = b.type_id
      WHERE bt.is_retail = true
     ON CONFLICT DO NOTHING`,
  )

  // počáteční likvidita v order booku, aby nový hráč mohl okamžitě obchodovat
  await placeSeedOrders(d, worldId, itemId, companyIds)

  // Ukázkový logistický okruh Tvé Firmy: sklad u tahu + dvě trasy do něj.
  // Bez skladu by se tábor i pila ucpaly v malých dvorcích (status `full`)
  // a nový hráč by místo jezdících náklaďáků viděl mrtvý svět.
  const demoCo = companyIds[0]
  if (demoCo !== undefined) {
    const anchor = HOME_ANCHORS[0] ?? { x: 10, y: 9 }
    const wp = await one<{ id: string }>(
      d,
      `SELECT p.id::text FROM plots p
        WHERE p.world_id = $1 AND p.plot_type = 'industrial' AND p.status = 'unowned'
          AND EXISTS (SELECT 1 FROM plots n
                       WHERE n.world_id = $1 AND n.plot_type = 'road'
                         AND abs(n.x - p.x) + abs(n.y - p.y) = 1)
        ORDER BY (p.x - $2) * (p.x - $2) + (p.y - $3) * (p.y - $3)
        LIMIT 1`,
      [worldId, anchor.x, anchor.y],
    )
    if (wp && buildingTypeId['warehouse'] !== undefined) {
      await d.query(
        `UPDATE plots SET status='owned', owner_company_id=$1, acquired_at=now(),
                          acquired_for=0 WHERE id=$2`,
        [demoCo, Number(wp.id)],
      )
      await d.query(
        `INSERT INTO buildings (world_id, company_id, plot_id, type_id, level, status,
                                completed_at, last_settled_at)
         VALUES ($1,$2,$3,$4,1,'idle',now(),now())`,
        [worldId, demoCo, Number(wp.id), buildingTypeId['warehouse']],
      )
    }
    const pick = async (code: string) => one<{ plot_id: string }>(
      d,
      `SELECT b.plot_id::text FROM buildings b
         JOIN building_types bt ON bt.id = b.type_id
        WHERE b.company_id=$1 AND bt.code=$2 LIMIT 1`,
      [demoCo, code],
    )
    const camp = await pick('logging_camp')
    const mill = await pick('sawmill')
    const wh = await pick('warehouse')
    let made = 0
    for (const pair of [[camp, wh, 2], [mill, wh, 1]] as const) {
      const [from, to, n] = pair
      if (!from || !to) continue
      try {
        await createRoute(d, worldId, demoCo, Number(from.plot_id),
                          Number(to.plot_id), 'truck', n)
        made++
      } catch (e) {
        console.log('  ⚠️  seed: ukázková trasa nevznikla:',
          e instanceof Error ? e.message : e)
      }
    }
    if (made > 0) console.log(`  🚚 seed: ukázkové cargo trasy (${made}) do skladu`)
  }

  return companyIds
}

/** Vloží úvodní limity do booku — přímo přes SQL (bez matchování, ať se nespárují). */
async function placeSeedOrders(
  d: Db, worldId: number, itemId: Record<string, number>, companyIds: number[],
) {
  type Q = { item: string; side: 'buy' | 'sell'; price: number; qty: number; co: number }
  const quotes: Q[] = [
    { item: 'log', side: 'sell', price: 0.1150, qty: 500, co: 1 },
    { item: 'log', side: 'sell', price: 0.1200, qty: 800, co: 1 },
    { item: 'log', side: 'buy', price: 0.1000, qty: 400, co: 0 },
    { item: 'planks', side: 'sell', price: 0.3100, qty: 300, co: 1 },
    { item: 'planks', side: 'sell', price: 0.3250, qty: 450, co: 1 },
    { item: 'planks', side: 'buy', price: 0.2900, qty: 250, co: 0 },
    { item: 'iron_ore', side: 'sell', price: 0.2500, qty: 400, co: 2 },
    { item: 'iron_ingot', side: 'sell', price: 1.5200, qty: 120, co: 2 },
    { item: 'iron_ingot', side: 'buy', price: 1.3800, qty: 80, co: 2 },
    { item: 'bread', side: 'sell', price: 0.0990, qty: 1500, co: 3 },
    { item: 'power', side: 'sell', price: 0.0520, qty: 5000, co: 0 },
    { item: 'power', side: 'buy', price: 0.0480, qty: 3000, co: 2 },
  ]
  for (const q of quotes) {
    const companyId = companyIds[q.co]
    if (companyId === undefined) continue

    // Escrow podle stejného pravidla jako v placeOrder():
    //   sell → rezervace ZBOŽÍ, buy → blokování HOTOVOSTI včetně rezervy na poplatek.
    // Rezerva je nutná, protože poplatek se při fillu platí z escrow; bez ní by
    // escrow_locked při plnění klesl pod nulu a CHECK by transakci odpálil.
    let escrowLocked = 0

    if (q.side === 'sell') {
      const r = await d.query(
        `UPDATE inventory_items ii
            SET reserved_qty = reserved_qty + $1, updated_at = now()
           FROM inventories inv
          WHERE inv.id = ii.inventory_id AND inv.company_id = $2
            AND ii.item_id = $3 AND ii.quality_tier = 1
            AND ii.quantity - ii.reserved_qty >= $1`,
        [q.qty, companyId, itemId[q.item]],
      )
      // Rezervace, která neprošla, znamená, že bychom do booku dali prodat zboží,
      // které nikdo nemá. Radši to hlásíme nahlas, než aby book lhal.
      if ((r.affectedRows ?? 0) === 0) {
        console.warn(`  ⚠️  seed: firma ${companyId} nemá ${q.qty}× ${q.item} ` +
                     `na prodejní quote — příkaz přeskočen`)
        continue
      }
    } else {
      escrowLocked = round6(q.price * q.qty * (1 + FEE_TAKER) + FEE_MIN)
      await post(d, worldId, [
        { party: { type: 'company', id: companyId }, kind: 'cash', amount: -escrowLocked,
          moneyFlow: 'internal', refType: 'market_order' },
        { party: { type: 'company', id: companyId }, kind: 'escrow_market',
          amount: escrowLocked,
          moneyFlow: 'internal', refType: 'market_order' },
      ], { kind: 'escrow_lock' })
    }

    await d.query(
      `INSERT INTO market_orders (world_id, company_id, item_id, quality_tier, side,
                                  order_type, price_limit, qty, qty_filled, status,
                                  escrow_locked, is_npc, created_at)
       VALUES ($1,$2,$3,1,$4,'limit',$5,$6,0,'open',$7,false,now())`,
      [worldId, companyId, itemId[q.item], q.side, round6(q.price), q.qty, escrowLocked],
    )
  }
  const n = await one<{ c: string }>(d, `SELECT count(*)::text c FROM market_orders`)
  console.log(`  ✅ order book: ${n!.c} úvodních limitních příkazů`)
}

/** Aktuální svět (pro API). */
export async function currentWorldId(d: Db): Promise<number> {
  const w = await one<{ id: string }>(
    d, `SELECT id FROM worlds ORDER BY id DESC LIMIT 1`,
  )
  if (!w) throw new Error('žádný svět — spusť seed')
  return Number(w.id)
}

export async function worldInfo(d: Db) {
  const rows = await many<{
    id: string; code: string; name: string; season_no: number; status: string
    starts_at: string; ends_at: string; companies: string; plots: string
  }>(
    d,
    `SELECT w.id::text, w.code, w.name, w.season_no, w.status::text,
            w.starts_at, w.ends_at,
            (SELECT count(*) FROM companies c WHERE c.world_id=w.id)::text AS companies,
            (SELECT count(*) FROM plots p WHERE p.world_id=w.id)::text AS plots
       FROM worlds w ORDER BY w.id DESC`,
  )
  return rows
}

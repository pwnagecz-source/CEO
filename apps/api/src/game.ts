/**
 * Sandbox vrstva: založení firmy, nákup pozemků, stavba budov.
 *
 * Všechno prochází podvojným ledgerem, takže ekonomika zůstává konzistentní
 * a audit invarianty drží i když hráč libovolně staví:
 *   nákup pozemku  → cash −cena,  sink_land_purchase +cena   (peníze mizí)
 *   stavba budovy  → cash −capex, sink_capex       +capex    (peníze mizí)
 *   startovní kapitál → faucet_starting_grant −, cash +      (peníze vznikají)
 *
 * Záměrně žádné „free“ zkratky: i v sandboxu musí každá koruna mít druhou stranu,
 * jinak by si hráč mohl nastartovat inflaci, kterou by pak viděl v makro číslech.
 */
import { MarketError } from './market.ts'
import { post, round6 } from './ledger.ts'
import type { Db } from './db.ts'
import { one, many } from './db.ts'

export type CatalogRow = {
  code: string; name: string; industry: string; plot_type: string
  capex: number; upkeep_hour: number; throughput: number; storage: number
  max_level: number; build_seconds: number; is_retail: boolean
  output_item: string | null; output_name: string | null; output_tier: number | null
}

/** Katalog budov pro menu „co mohu postavit“ a pro výběr odvětví při zakládání. */
export async function catalog(d: Db): Promise<CatalogRow[]> {
  return many<CatalogRow>(
    d,
    `SELECT bt.code, bt.name, ind.code AS industry,
            bt.required_plot_type::text AS plot_type,
            bt.base_capex::float8 AS capex,
            bt.base_upkeep_hour::float8 AS upkeep_hour,
            bt.base_throughput::float8 AS throughput,
            bt.base_storage::float8 AS storage,
            bt.max_level::int, bt.base_build_seconds::int AS build_seconds,
            bt.is_retail,
            oi.code AS output_item, oi.name AS output_name, oi.tier::int AS output_tier
       FROM building_types bt
       JOIN industries ind ON ind.id = bt.industry_id
       LEFT JOIN recipes r  ON r.building_type_id = bt.id
       LEFT JOIN items oi   ON oi.id = r.output_item_id
      ORDER BY oi.tier NULLS LAST, bt.code`,
  )
}

/** Zajistí firmě primární sklad (inventories.plot_id je NOT NULL → až po prvním pozemku). */
async function ensurePrimaryInventory(d: Db, worldId: number, companyId: number, plotId: number) {
  const existing = await one<{ id: string }>(
    d,
    `SELECT id FROM inventories WHERE company_id=$1 AND is_primary LIMIT 1`,
    [companyId],
  )
  if (existing) return Number(existing.id)
  const inv = await one<{ id: string }>(
    d,
    `INSERT INTO inventories (world_id, company_id, plot_id, name, is_primary)
     VALUES ($1,$2,$3,'HQ',true) RETURNING id`,
    [worldId, companyId, plotId],
  )
  return Number(inv!.id)
}

/**
 * Založí novou firmu: uživatel, firma, účty (trigger) a startovní kapitál přes ledger.
 * Jméno musí být volné (users.display_name má unikátní index přes lower()).
 */
export async function createCompany(
  d: Db, worldId: number, name: string, industryCode: string,
): Promise<{ companyId: number; startingCapital: number }> {
  const trimmed = name.trim()
  if (trimmed.length < 2) throw new MarketError('název firmy musí mít aspoň 2 znaky', 'bad_name')
  if (trimmed.length > 40) throw new MarketError('název firmy je moc dlouhý (max 40)', 'bad_name')

  const ind = await one<{ id: string }>(
    d, `SELECT id FROM industries WHERE code=$1`, [industryCode])
  if (!ind) throw new MarketError(`neznámé odvětví '${industryCode}'`, 'unknown_industry')

  const taken = await one<{ id: string }>(
    d, `SELECT id FROM users WHERE lower(display_name) = lower($1)`, [trimmed])
  if (taken) throw new MarketError(`název „${trimmed}“ už někdo používá`, 'name_taken')

  const user = await one<{ id: string }>(
    d,
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ($1,'argon2id$player',$2,now()) RETURNING id`,
    [`player${Date.now()}@ceo.local`, trimmed],
  )
  const company = await one<{ id: string }>(
    d,
    `INSERT INTO companies (user_id, world_id, name, industry_id, status,
                            prestige_level, legacy_points)
     VALUES ($1,$2,$3,$4,'active',0,0) RETURNING id`,
    [Number(user!.id), worldId, trimmed, Number(ind.id)],
  )
  const companyId = Number(company!.id)

  const w = await one<{ cap: string }>(
    d, `SELECT starting_capital::float8::text AS cap FROM worlds WHERE id=$1`, [worldId])
  const capital = round6(Number(w?.cap ?? 25000))

  // Startovní kapitál = faucet. Stejná pravidla jako v seedu: firma dostává (+),
  // faucet účet je zdroj a jde do mínusu (owner_type='system' to povoluje).
  await post(d, worldId, [
    { party: { type: 'system' }, kind: 'faucet_starting_grant', amount: -capital,
      moneyFlow: 'faucet', refType: 'company', refId: companyId },
    { party: { type: 'company', id: companyId }, kind: 'cash', amount: capital,
      moneyFlow: 'faucet', refType: 'company', refId: companyId },
  ], { kind: 'starting_grant' })

  return { companyId, startingCapital: capital }
}

/** Koupí volný pozemek. Cena = assessed_value (daňový odhad) → sink. */
export async function buyPlot(
  d: Db, worldId: number, companyId: number, plotId: number,
): Promise<{ plotId: number; price: number }> {
  const plot = await one<{ id: string; status: string; type: string; value: string }>(
    d,
    `SELECT id::text, status::text, plot_type::text AS type,
            assessed_value::float8::text AS value
       FROM plots WHERE id=$1 AND world_id=$2`,
    [plotId, worldId],
  )
  if (!plot) throw new MarketError('pozemek nenalezen', 'not_found')
  if (plot.status !== 'unowned') throw new MarketError('tenhle pozemek už někdo vlastní', 'not_unowned')

  const price = round6(Number(plot.value))
  if (price > 0) {
    await post(d, worldId, [
      { party: { type: 'company', id: companyId }, kind: 'cash', amount: -price,
        moneyFlow: 'sink', refType: 'plot', refId: plotId },
      { party: { type: 'system' }, kind: 'sink_land_purchase', amount: price,
        moneyFlow: 'sink', refType: 'plot', refId: plotId },
    ], { kind: 'land_purchase' })
  }

  await d.query(
    `UPDATE plots SET status='owned', owner_company_id=$1, acquired_at=now(),
                      acquired_for=$2 WHERE id=$3`,
    [companyId, price, plotId],
  )
  await ensurePrimaryInventory(d, worldId, companyId, plotId)
  return { plotId, price }
}

/** Postaví budovu na vlastním volném pozemku správného biomu. Capex → sink. */
export async function buildBuilding(
  d: Db, worldId: number, companyId: number, plotId: number, buildingCode: string,
): Promise<{ buildingId: number; capex: number }> {
  const plot = await one<{ id: string; status: string; type: string; owner: string | null }>(
    d,
    `SELECT id::text, status::text, plot_type::text AS type,
            owner_company_id::text AS owner
       FROM plots WHERE id=$1 AND world_id=$2`,
    [plotId, worldId],
  )
  if (!plot) throw new MarketError('pozemek nenalezen', 'not_found')
  if (plot.status !== 'owned' || Number(plot.owner) !== companyId) {
    throw new MarketError('na cizím pozemku stavět nemůžeš', 'not_yours')
  }
  const occupied = await one<{ id: string }>(
    d, `SELECT id FROM buildings WHERE plot_id=$1`, [plotId])
  if (occupied) throw new MarketError('na pozemku už budova stojí', 'occupied')

  const bt = await one<{ id: string; capex: string; req: string }>(
    d,
    `SELECT id::text, base_capex::float8::text AS capex,
            required_plot_type::text AS req
       FROM building_types WHERE code=$1`,
    [buildingCode],
  )
  if (!bt) throw new MarketError(`neznámá budova '${buildingCode}'`, 'unknown_building')
  if (bt.req !== plot.type) {
    throw new MarketError(
      `${buildingCode} potřebuje terén „${bt.req}“, tohle je „${plot.type}“`, 'wrong_terrain')
  }

  const capex = round6(Number(bt.capex))
  await post(d, worldId, [
    { party: { type: 'company', id: companyId }, kind: 'cash', amount: -capex,
      moneyFlow: 'sink', refType: 'building_type', refId: Number(bt.id) },
    { party: { type: 'system' }, kind: 'sink_capex', amount: capex,
      moneyFlow: 'sink', refType: 'building_type', refId: Number(bt.id) },
  ], { kind: 'building_capex' })

  const b = await one<{ id: string }>(
    d,
    `INSERT INTO buildings (world_id, company_id, type_id, plot_id, level, status)
     VALUES ($1,$2,$3,$4,1,'idle') RETURNING id`,
    [worldId, companyId, Number(bt.id), plotId],
  )
  await ensurePrimaryInventory(d, worldId, companyId, plotId)
  return { buildingId: Number(b!.id), capex }
}

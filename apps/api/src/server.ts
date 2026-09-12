/**
 * CEO — API server.
 *
 * Modulární monolit: api (tohle) / domain (market.ts, ledger.ts) / infra (db.ts).
 * Hranice jsou čisté, takže matching engine jde později vytáhnout do vlastního
 * procesu bez přepisování domény.
 */
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { closeDb, getDb, many, one, tx } from './db.ts'
import { audit, balance, macroSnapshot } from './ledger.ts'
import {
  FEE_MAKER, FEE_TAKER, MarketError, cancelOrder, openOrders, orderBook,
  placeOrder, recentTrades, type Side,
} from './market.ts'
import { seedIfEmpty, worldInfo } from './seed.ts'
import { buildBuilding, buyPlot, catalog, createCompany, quickSell } from './game.ts'
import {
  hireRoadBuilders, isPlotConnected, roadNetwork, shortestRoadPath,
} from './logistics.ts'
import { questState } from './quests.ts'
import { startTick, TICK_MS } from './tick.ts'

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'   // musí být 0.0.0.0 kvůli live preview

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * MarketError → HTTP kód.
 * „Neexistuje“ je 404; porušení obchodního pravidla (málo zásob, pod minimálním
 * lotem, nelze zrušit) je 422. Bez tohohle by klient dostával 422 i pro překlep
 * v názvu položky a 500 pro cokoliv, co DB odmítne.
 */
function statusForMarketError(e: MarketError): number {
  return e.code === 'unknown_item' || e.code === 'not_found' ? 404 : 422
}

async function boot() {
  console.log('\n  CEO · API')
  console.log('  ─────────────────────────────────────────')
  // `let`, ne `const`: /api/demo/reset mění instanci DB i svět za běhu a routy
  // je mají v closure. Closure v JS zachycuje PROMĚNNOU, ne její hodnotu,
  // takže přeřazení se propíše do všech handlerů.
  let db = await getDb()
  // Seed musí běžet v JEDNÉ transakci: zapisuje přes podvojný ledger a DEFERRED
  // trigger kontroluje Σ legs = 0 až při COMMIT. Bez transakce by vystřelil
  // po každé jednotlivé noze.
  const bootSeed = await tx((t) => seedIfEmpty(t))
  let worldId = bootSeed.worldId
  const seeded = bootSeed.seeded
  if (seeded) {
    const a = await audit(db)
    console.log(`  ${a.ok ? '✅' : '❌'} audit invariantů po seedu: ` +
      `${a.ok ? 'čistý' : JSON.stringify(a)}`)
  }

  // Produkční tick: svět žije i bez hráče (výroba, údržby, retail prodejny).
  startTick(() => worldId)
  console.log(`  ⚙️  produkční tick co ${TICK_MS / 1000} s`)

  const app = Fastify({ logger: false, bodyLimit: 1_048_576 })
  await app.register(cors, { origin: true })

  // ---------------------------------------------------------------- health ---
  app.get('/api/health', async () => {
    const v = await one<{ v: string }>(db, `SHOW server_version`)
    // Čte se živě z DB, ne z boot konstanty: /api/demo/reset mění svět za běhu.
    const w = await one<{ sc: number }>(
      db, `SELECT starting_capital::float8 AS sc FROM worlds WHERE id=$1`, [worldId])
    return {
      ok: true, worldId, engine: 'PostgreSQL', version: v?.v,
      startingCapital: w?.sc ?? 0,
    }
  })

  // ----------------------------------------------------------------- world ---
  app.get('/api/world', async () => ({ worlds: await worldInfo(db), current: worldId }))

  // ------------------------------------------------------------------- map ---
  /**
   * Celá mřížka světa pro izometrickou mapu (výchozí 40×20 = 800 pozemků)
   * s terénem,
   * vlastníkem a budovou (pokud na pozemku stojí).
   *
   * Na rozdíl od /api/companies/:id (které vrací jen POZEMKY FIRMY) tohle je
   * pohled „shora na svět“ — mapa potřebuje i cizí a volné dlaždice, jinak by
   * hráč neviděl, kde může stavět a kde už někdo je.
   */
  app.get('/api/map', async () => {
    const grid = await one<{ w: number; h: number }>(
      db,
      `SELECT plot_grid_w::int AS w, plot_grid_h::int AS h FROM worlds WHERE id=$1`,
      [worldId],
    )
    const plots = await many<{
      id: string; x: number; y: number; type: string; status: string
      owner_id: string | null; owner_name: string | null
      b_id: string | null; b_code: string | null; b_name: string | null
      b_level: number | null; b_status: string | null; b_retail: boolean | null
      b_output: string | null; b_industry: string | null; b_tier: number | null
      richness: number; assessed_value: number
    }>(
      db,
      `SELECT p.id::text, p.x::int, p.y::int, p.plot_type::text AS type, p.status::text,
              p.owner_company_id::text AS owner_id, c.name AS owner_name,
              b.id::text AS b_id, bt.code AS b_code, bt.name AS b_name,
              b.level::int AS b_level, b.status::text AS b_status,
              bt.is_retail AS b_retail, oi.code AS b_output,
              ind.code AS b_industry, oi.tier::int AS b_tier,
              p.deposit_richness::float8 AS richness,
              p.assessed_value::float8 AS assessed_value
         FROM plots p
         LEFT JOIN companies c        ON c.id = p.owner_company_id
         LEFT JOIN buildings b        ON b.plot_id = p.id
         LEFT JOIN building_types bt  ON bt.id = b.type_id
         LEFT JOIN industries ind     ON ind.id = bt.industry_id
         LEFT JOIN recipes r          ON r.building_type_id = bt.id
         LEFT JOIN items oi           ON oi.id = r.output_item_id
        WHERE p.world_id = $1
        ORDER BY p.y, p.x`,
      [worldId],
    )
    // napojení na silniční síť: UI podle toho kreslí auta a hlásí „bez cesty“
    const net = await roadNetwork(db, worldId)
    return {
      grid: { w: grid?.w ?? 64, h: grid?.h ?? 32 },
      plots: plots.map((p) => ({ ...p, connected: isPlotConnected(net, p.x, p.y) })),
    }
  })

  // ----------------------------------------------------------------- codex ---
  /**
   * „Kniha“: recepty (vstupy → výstupy) pro herní kodex.
   * Hráč se tak DOČTE produkční řetězce, aniž by musel číst balance JSON.
   */
  app.get('/api/codex', async () => {
    const recipes = await many<{
      code: string; building: string; building_name: string; output: string
      output_name: string; tier: number; qty: number; plot_type: string | null
      throughput: number
    }>(
      db,
      `SELECT r.code, bt.code AS building, bt.name AS building_name,
              oi.code AS output, oi.name AS output_name, oi.tier::int AS tier,
              r.output_qty::float8 AS qty,
              bt.required_plot_type::text AS plot_type,
              bt.base_throughput::float8 AS throughput
         FROM recipes r
         JOIN building_types bt ON bt.id = r.building_type_id
         JOIN items oi ON oi.id = r.output_item_id
        ORDER BY oi.tier, bt.code`,
    )
    const inputs = await many<{ recipe: string; item: string; item_name: string; qty: number }>(
      db,
      `SELECT r.code AS recipe, i.code AS item, i.name AS item_name,
              ri.qty::float8 AS qty
         FROM recipe_inputs ri
         JOIN recipes r ON r.id = ri.recipe_id
         JOIN items i ON i.id = ri.item_id
        ORDER BY r.code, i.tier`,
    )
    return { recipes, inputs }
  })

  // ----------------------------------------------------------------- clock ---
  /** Herní hodiny: viditelný čas + rychlost (0 = pauza, 1/2/4). */
  app.get('/api/clock', async () => {
    const w = await one<{ speed: number; hours: string }>(
      db,
      `SELECT sim_speed::int AS speed, sim_hours::text AS hours
         FROM worlds WHERE id=$1`,
      [worldId],
    )
    const hours = Number(w?.hours ?? 0)
    return {
      speed: w?.speed ?? 1, hours,
      day: Math.floor(hours / 24) + 1, hour: Math.floor(hours % 24),
    }
  })
  app.post<{ Body: { speed: number } }>('/api/clock', async (req, reply) => {
    const sp = Number(req.body?.speed)
    if (![0, 1, 2, 4].includes(sp)) {
      return reply.code(400).send({ error: 'speed musí být 0, 1, 2 nebo 4' })
    }
    await db.query(`UPDATE worlds SET sim_speed=$1 WHERE id=$2`, [sp, worldId])
    return { speed: sp }
  })

  app.get('/api/macro', async () => {
    const macro = await macroSnapshot(db, worldId)
    const counts = await one<{
      companies: string; buildings: string; plots_owned: string; open_orders: string
      trades: string; volume: string
    }>(
      db,
      `SELECT (SELECT count(*) FROM companies WHERE world_id=$1)::text companies,
              (SELECT count(*) FROM buildings WHERE world_id=$1)::text buildings,
              (SELECT count(*) FROM plots WHERE world_id=$1 AND status='owned')::text plots_owned,
              (SELECT count(*) FROM market_orders WHERE world_id=$1
                 AND status IN ('open','partial'))::text open_orders,
              (SELECT count(*) FROM trades WHERE world_id=$1)::text trades,
              (SELECT COALESCE(SUM(gross_value),0) FROM trades
                WHERE world_id=$1)::float8::text volume`,
      [worldId],
    )
    return { ...macro, counts: { ...counts!, volume: Number(counts!.volume) } }
  })

  app.get('/api/audit', async () => {
    const a = await audit(db)
    return { ...a, verdict: a.ok ? 'PASS' : 'FAIL' }
  })

  // ----------------------------------------------------------------- items ---
  app.get('/api/items', async () => {
    const items = await many<{
      id: string; code: string; name: string; category: string; tier: number
      base_price: number; retail_base: number | null; tick_size: number
      min_lot: number; is_retail_product: boolean; best_bid: number | null
      best_ask: number | null; last_price: number | null
    }>(
      db,
      `SELECT i.id::text, i.code, i.name, i.category, i.tier,
              i.base_price::float8, i.retail_base::float8,
              i.tick_size::float8, i.min_lot::float8,
              EXISTS(SELECT 1 FROM building_types bt JOIN recipes r ON r.building_type_id=bt.id
                      WHERE bt.is_retail AND r.output_item_id=i.id) AS is_retail_product,
              (SELECT MAX(price_limit)::float8 FROM market_orders o
                WHERE o.world_id=$1 AND o.item_id=i.id AND o.quality_tier=1 AND o.side='buy'
                  AND o.status IN ('open','partial') AND o.order_type='limit'
                  AND o.is_npc=false) AS best_bid,
              (SELECT MIN(price_limit)::float8 FROM market_orders o
                WHERE o.world_id=$1 AND o.item_id=i.id AND o.quality_tier=1 AND o.side='sell'
                  AND o.status IN ('open','partial') AND o.order_type='limit'
                  AND o.is_npc=false) AS best_ask,
              (SELECT price::float8 FROM trades t
                WHERE t.world_id=$1 AND t.item_id=i.id AND t.quality_tier=1
                ORDER BY t.executed_at DESC, t.id DESC LIMIT 1) AS last_price
         FROM items i
        ORDER BY i.tier, i.code`,
      [worldId],
    )
    return { items, fees: { maker: FEE_MAKER, taker: FEE_TAKER } }
  })

  // -------------------------------------------------------------- company ---
  app.get('/api/companies', async () => {
    const rows = await many<{ id: string; name: string; industry: string; status: string }>(
      db,
      `SELECT c.id::text, c.name, i.code AS industry, c.status::text
         FROM companies c LEFT JOIN industries i ON i.id = c.industry_id
        WHERE c.world_id = $1 ORDER BY c.id`,
      [worldId],
    )
    return { companies: rows }
  })

  app.get<{ Params: { id: string } }>('/api/companies/:id', async (req, reply) => {
    const companyId = Number(req.params.id)
    const co = await one<{
      id: string; name: string; industry: string; status: string; founded_at: string
      cash: number; escrow: number
    }>(
      db,
      `SELECT c.id::text, c.name, i.code AS industry, c.status::text, c.founded_at,
              COALESCE(SUM(a.balance) FILTER (WHERE a.kind='cash'),0)::float8 AS cash,
              COALESCE(SUM(a.balance) FILTER (WHERE a.kind='escrow_market'),0)::float8 AS escrow
         FROM companies c
         LEFT JOIN industries i ON i.id = c.industry_id
         LEFT JOIN accounts a ON a.owner_type='company' AND a.owner_id=c.id
        WHERE c.id=$1 AND c.world_id=$2
        GROUP BY c.id, c.name, i.code, c.status, c.founded_at`,
      [companyId, worldId],
    )
    if (!co) return reply.code(404).send({ error: 'firma nenalezena' })

    const buildings = await many<{
      id: string; name: string; code: string; level: number; status: string
      plot: string; x: number; y: number; upkeep: number; throughput: number
      output_item: string; storage: number
    }>(
      db,
      `SELECT b.id::text, bt.name, bt.code, b.level, b.status::text,
              p.plot_type::text AS plot, p.x, p.y,
              (bt.base_upkeep_hour * (1 + bt.level_upkeep_mult*(b.level-1)))::float8 AS upkeep,
              (bt.base_throughput * (1 + bt.level_throughput_mult*(b.level-1)))::float8 AS throughput,
              oi.code AS output_item,
              (bt.base_storage * (1 + bt.level_storage_mult*(b.level-1)))::float8 AS storage
         FROM buildings b
         JOIN building_types bt ON bt.id = b.type_id
         JOIN plots p ON p.id = b.plot_id
         LEFT JOIN recipes r ON r.building_type_id = bt.id
         LEFT JOIN items oi ON oi.id = r.output_item_id
        WHERE b.company_id=$1 AND b.world_id=$2
        ORDER BY oi.tier NULLS LAST, bt.code`,
      [companyId, worldId],
    )

    const inventory = await many<{
      item: string; name: string; tier: number; quality_tier: number
      quantity: number; reserved: number; available: number
      mid_price: number | null; value: number
    }>(
      db,
      `SELECT i.code AS item, i.name, i.tier, ii.quality_tier,
              ii.quantity::float8, ii.reserved_qty::float8 AS reserved,
              (ii.quantity - ii.reserved_qty)::float8 AS available,
              (SELECT (MAX(price_limit) FILTER (WHERE side='buy')
                       + MIN(price_limit) FILTER (WHERE side='sell'))/2
                 FROM market_orders o
                WHERE o.world_id=$2 AND o.item_id=i.id
                  AND o.quality_tier=ii.quality_tier
                  AND o.status IN ('open','partial') AND o.order_type='limit'
                  AND o.is_npc=false)::float8 AS mid_price,
              ((ii.quantity - ii.reserved_qty) * COALESCE(
                 (SELECT (MAX(price_limit) FILTER (WHERE side='buy')
                          + MIN(price_limit) FILTER (WHERE side='sell'))/2
                    FROM market_orders o
                   WHERE o.world_id=$2 AND o.item_id=i.id
                     AND o.quality_tier=ii.quality_tier
                     AND o.status IN ('open','partial') AND o.order_type='limit'
                     AND o.is_npc=false), i.base_price))::float8 AS value
         FROM inventory_items ii
         JOIN inventories inv ON inv.id = ii.inventory_id
         JOIN items i ON i.id = ii.item_id
        WHERE inv.company_id=$1 AND inv.world_id=$2 AND ii.quantity > 0
        ORDER BY i.tier, i.code`,
      [companyId, worldId],
    )

    const plots = await many<{ id: string; x: number; y: number; plot_type: string }>(
      db,
      `SELECT id::text, x, y, plot_type::text FROM plots
        WHERE world_id=$1 AND owner_company_id=$2 ORDER BY y, x`,
      [worldId, companyId],
    )

    return {
      ...co,
      // kontrola proti ledgeru (mělo by sedět přesně)
      ledgerCash: await balance(db, worldId, { type: 'company', id: companyId }, 'cash'),
      buildings, inventory, plots,
      inventoryValue: inventory.reduce((s, r) => s + (r.value ?? 0), 0),
    }
  })

  // ---------------------------------------------------------------- market ---
  app.get<{ Params: { code: string }; Querystring: { tier?: string } }>(
    '/api/market/:code', async (req, reply) => {
      const tier = Number(req.query.tier ?? 1)
      try {
        return await orderBook(db, worldId, req.params.code, tier)
      } catch (e) {
        if (e instanceof MarketError) return reply.code(404).send({ error: e.message })
        throw e
      }
    })

  app.get('/api/trades', async () => ({ trades: await recentTrades(db, worldId, 40) }))

  app.get<{ Querystring: { companyId: string } }>('/api/orders', async (req) => ({
    orders: await openOrders(db, worldId, Number(req.query.companyId)),
  }))

  // --------------------------------------------------------------- trading ---
  app.post<{ Body: {
    companyId: number; itemCode: string; side: Side; qty: number
    priceLimit?: number | null; orderType?: 'limit' | 'market'
    qualityTier?: number; idempotencyKey?: string
  } }>('/api/orders', async (req, reply) => {
    const b = req.body
    if (!b || typeof b.companyId !== 'number' || !b.itemCode || !b.side || !b.qty) {
      return reply.code(400).send({ error: 'companyId, itemCode, side a qty jsou povinné' })
    }
    if (b.side !== 'buy' && b.side !== 'sell') {
      return reply.code(400).send({ error: "side musí být 'buy' nebo 'sell'" })
    }
    // idempotency_key je v DB sloupec typu uuid. Bez téhle validace by špatný
    // klíč skončil jako 500 s hláškou přímo z Postgresu — to jednak prozrazuje
    // implementaci a jednak klientovi neřekne, co má opravit.
    if (b.idempotencyKey != null && !UUID_RE.test(String(b.idempotencyKey))) {
      return reply.code(400).send({
        error: 'idempotencyKey musí být UUID (v1–v5), např. z crypto.randomUUID()',
        code: 'bad_idempotency_key',
      })
    }
    try {
      // celá operace v JEDNÉ transakci: escrow, matching, ledger, trade
      return await tx((t) => placeOrder(t, {
        worldId,
        companyId: b.companyId,
        itemCode: b.itemCode,
        qualityTier: b.qualityTier ?? 1,
        side: b.side,
        qty: Number(b.qty),
        priceLimit: b.priceLimit ?? null,
        orderType: b.orderType ?? (b.priceLimit == null ? 'market' : 'limit'),
        idempotencyKey: b.idempotencyKey ?? null,
      }))
    } catch (e) {
      if (e instanceof MarketError) {
        return reply.code(statusForMarketError(e)).send({ error: e.message, code: e.code })
      }
      const msg = e instanceof Error ? e.message : String(e)
      // deferred ledger trigger odmítl commit — to je přesně ten případ, kdy chceme
      // vědět, že invariant drží
      return reply.code(500).send({
        error: msg,
        code: msg.includes('není vyrovnaný') ? 'ledger_unbalanced' : 'internal',
      })
    }
  })

  app.delete<{ Params: { id: string }; Querystring: { companyId: string } }>(
    '/api/orders/:id', async (req, reply) => {
      try {
        return await tx((t) => cancelOrder(t, worldId, Number(req.query.companyId),
                                            Number(req.params.id)))
      } catch (e) {
        if (e instanceof MarketError) {
          return reply.code(statusForMarketError(e)).send({ error: e.message, code: e.code })
        }
        throw e
      }
    })

  // --------------------------------------------------------------- sandbox ---
  /** Katalog budov: „co mohu postavit a na jakém terénu“. */
  app.get('/api/buildings/catalog', async () => ({ buildings: await catalog(db) }))

  /** Založení nové firmy (jméno + odvětví). Startovní kapitál přes ledger. */
  app.post<{ Body: { name: string; industryCode: string } }>(
    '/api/companies', async (req, reply) => {
      const b = req.body
      if (!b || typeof b.name !== 'string' || typeof b.industryCode !== 'string') {
        return reply.code(400).send({ error: 'name a industryCode jsou povinné' })
      }
      try {
        return await tx((t) => createCompany(t, worldId, b.name, b.industryCode))
      } catch (e) {
        if (e instanceof MarketError) {
          const code = e.code === 'name_taken' ? 409 : statusForMarketError(e)
          return reply.code(code).send({ error: e.message, code: e.code })
        }
        throw e
      }
    })

  /** Nákup volného pozemku (cena → sink_land_purchase). */
  app.post<{ Params: { id: string }; Body: { companyId: number } }>(
    '/api/plots/:id/buy', async (req, reply) => {
      try {
        return await tx((t) => buyPlot(t, worldId, Number(req.body?.companyId),
                                       Number(req.params.id)))
      } catch (e) {
        if (e instanceof MarketError) {
          return reply.code(statusForMarketError(e)).send({ error: e.message, code: e.code })
        }
        throw e
      }
    })

  /** Stavba budovy na vlastním pozemku správného biomu (capex → sink_capex). */
  app.post<{ Params: { id: string }; Body: { companyId: number; buildingCode: string } }>(
    '/api/plots/:id/build', async (req, reply) => {
      const b = req.body
      if (!b || typeof b.buildingCode !== 'string') {
        return reply.code(400).send({ error: 'buildingCode je povinné' })
      }
      try {
        return await tx((t) => buildBuilding(t, worldId, Number(b.companyId),
                                             Number(req.params.id), b.buildingCode))
      } catch (e) {
        if (e instanceof MarketError) {
          return reply.code(statusForMarketError(e)).send({ error: e.message, code: e.code })
        }
        throw e
      }
    })

  /** Questový řetěz firmy (odvozený ze stavu světa, viz quests.ts). */
  app.get<{ Params: { id: string } }>('/api/companies/:id/quests', async (req) =>
    questState(db, worldId, Number(req.params.id)))

  /** „Prodat vše“ jedním klikem — market sell order na volné množství položky. */
  app.post<{ Params: { id: string }; Body: { itemCode: string } }>(
    '/api/companies/:id/quicksell', async (req, reply) => {
      const code = req.body?.itemCode
      if (typeof code !== 'string' || !code) {
        return reply.code(400).send({ error: 'itemCode je povinné' })
      }
      try {
        return await tx((t) =>
          quickSell(t, worldId, Number(req.params.id), code))
      } catch (e) {
        if (e instanceof MarketError) {
          return reply.code(statusForMarketError(e)).send({ error: e.message, code: e.code })
        }
        throw e
      }
    })

  /** Cena napojení předem: kolik dlaždic a peněz stavební firma chce. */
  app.get<{ Params: { id: string }; Querystring: { companyId: string } }>(
    '/api/plots/:id/road-quote', async (req, reply) => {
      const found = await shortestRoadPath(
        db, worldId, Number(req.params.id), Number(req.query.companyId))
      if (!found) return reply.code(404).send({ error: 'není kudy napojit', code: 'no_route' })
      return { tiles: found.path.length, cost: found.cost,
               path: found.path.map((p) => ({ id: p.id, x: p.x, y: p.y })) }
    })

  /** Najmutí stavební firmy: vykoupí trasu a postaví silnici k státní síti. */
  app.post<{ Params: { id: string }; Body: { companyId: number } }>(
    '/api/plots/:id/hire-road', async (req, reply) => {
      try {
        return await tx((t) =>
          hireRoadBuilders(t, worldId, Number(req.body?.companyId), Number(req.params.id)))
      } catch (e) {
        if (e instanceof MarketError) {
          return reply.code(statusForMarketError(e)).send({ error: e.message, code: e.code })
        }
        throw e
      }
    })

  // ----------------------------------------------------------------- demo ---
  app.post('/api/demo/reset', async () => {
    await closeDb()
    db = await getDb()                      // přeřaď dřív, než na něj sáhne seed
    const r = await tx((t) => seedIfEmpty(t))
    worldId = r.worldId
    const a = await audit(db)
    return {
      ok: true, reseeded: r.seeded, worldId, audit: a.ok ? 'PASS' : 'FAIL',
      note: 'DB byla restartována (in-memory) a svět znovu naseedován',
    }
  })

  await app.listen({ port: PORT, host: HOST })
  console.log(`  ✅ API běží na http://${HOST}:${PORT}  (svět #${worldId})`)
  console.log(`     poplatky: maker ${(FEE_MAKER * 100).toFixed(1)} % / ` +
              `taker ${(FEE_TAKER * 100).toFixed(1)} %\n`)

  const shutdown = async () => { await app.close(); await closeDb(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

boot().catch((e) => { console.error('❌ boot selhal:', e); process.exit(1) })

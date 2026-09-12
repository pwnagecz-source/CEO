/**
 * Produkční tick — srdce, které dělá z mapy živý svět.
 *
 * Jednou za TICK_MS (výchozí 12 s = jedna „herní hodina“) projde všechny budovy
 * a udělá tři věci, vždycky přes podvojný ledger:
 *
 *   1. ÚDRŽBA   cash −upkeep  → sink_upkeep        (peníze zanikají)
 *   2. VÝROBA   vstupy ze skladu → výstup do skladu (zboží, ne peníze)
 *   3. RETAIL   sklad −zboží  → cash +tržba z faucet_retail (peníze vznikají)
 *
 * Proč tohle patří do Fáze B: onboardingové questy („rozběhni výrobu“,
 * „prodej první zboží“) potřebují, aby se ve světě něco opravdu hýbalo.
 * Bez ticku by budova po postavění jen stála a hráč by neměl co prodat.
 *
 * Stavové kódy budov jsou zároveň UI jazyk:
 *   producing = vyrábí · starved = chybí vstupy · full = sklad plný ·
 *   paused = není na údržbu · construction = staví se · idle = stojí
 *
 * Ekonomická kázeň: tick NESMÍ vytvořit ani zničit peníze jinde než přes
 * faucets/sinks (údržba, retail), jinak by se rozbila makro identita M2 ≡ ΔM,
 * kterou hlídá audit. Výroba samotná peníze nehýbe — jen přesouvá hodnotu
 * mezi skladovými položkami.
 */
import { balance, post, round6 } from './ledger.ts'
import { isPlotConnected, roadNetwork } from './logistics.ts'
import { haulCargo } from './transport.ts'
import { companyEffects, levelForXp, researchTick, type CompanyEffects } from './progression.ts'
import { contractsTick } from './contracts.ts'
import { execsTick, loansTick, recordPriceHistory } from './finance.ts'
import { npcTick } from './npc.ts'
import type { Db } from './db.ts'
import { many, one, tx } from './db.ts'

export const TICK_MS = Number(process.env.TICK_MS ?? 12_000)

type Building = {
  id: number; company_id: number; plot_id: number; level: number; status: string
  b_code: string; is_retail: boolean; industry: string | null
  storage: number; upkeep: number; throughput: number
  recipe_id: number | null; output_qty: number
  output_item_id: number | null; output_code: string | null; retail_base: number | null
}

type Input = { recipe_id: number; item_id: number; code: string; qty: number; base_price: number }

type InvRow = { id: number; inventory_id: number; item_id: number; code: string; avail: number }

/**
 * Sklad firmy na konkrétním pozemku; kdyby chyběl, založí se (budova už stojí).
 *
 * Cargo simulace stojí na tom, že KAŽDÁ budova má vlastní dvorec (inventář na
 * svém pozemku) — jinak by všechny provozy sdílely jeden sklad a nebylo co
 * převážet. Primární inventář (HQ ze seedu) drží počáteční zásoby a do výroby
 * vstupuje jen jako běžný sklad firmy (vstupy se berou napříč inventáři).
 */
async function plotInventory(
  d: Db, worldId: number, companyId: number, plotId: number,
): Promise<number> {
  const hit = await one<{ id: string }>(
    d,
    `SELECT id::text FROM inventories WHERE company_id=$1 AND plot_id=$2 LIMIT 1`,
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

/** Volné (nerezervované) zásoby firmy po všech skladech, seřazené pro odběr. */
async function companyStock(d: Db, companyId: number): Promise<InvRow[]> {
  return many<InvRow>(
    d,
    `SELECT ii.id::int, ii.inventory_id::int, ii.item_id::int, i.code,
            (ii.quantity - ii.reserved_qty)::float8 AS avail
       FROM inventory_items ii
       JOIN inventories v ON v.id = ii.inventory_id
       JOIN items i ON i.id = ii.item_id
      WHERE v.company_id = $1 AND ii.quantity - ii.reserved_qty > 0
      ORDER BY ii.id`,
    [companyId],
  )
}

async function addItems(d: Db, invId: number, itemId: number, qty: number) {
  await d.query(
    `INSERT INTO inventory_items (inventory_id, item_id, quality_tier, quantity)
     VALUES ($1,$2,1,$3)
     ON CONFLICT (inventory_id, item_id, quality_tier)
     DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity,
                   updated_at = now()`,
    [invId, itemId, round6(qty)],
  )
}

async function takeItems(d: Db, rowId: number, qty: number) {
  await d.query(
    `UPDATE inventory_items SET quantity = quantity - $2, updated_at = now()
      WHERE id = $1`,
    [rowId, round6(qty)],
  )
}

/**
 * Jeden produkční cyklus nad celým světem, v JEDNÉ transakci.
 * Vrací shrnutí pro log (kolik budov co dělalo).
 */
export async function runTick(d: Db, worldId: number) {
  // Herní hodiny: sim_speed 0 = pauza (tick nic nedělá), 1/2/4 = kolik
  // herních hodin tento tick představuje (výroba i údržby se škálují).
  const clock = await one<{ speed: number; hours: string }>(
    d,
    `SELECT sim_speed::int AS speed, sim_hours::text AS hours FROM worlds WHERE id=$1`,
    [worldId],
  )
  const cycles = clock?.speed ?? 1
  if (cycles === 0) return { produced: 0, sold: 0, upkeep: 0, paused: true }

  const net = await roadNetwork(d, worldId)
  const warehouses = await many<{ company_id: number; storage: number }>(
    d,
    `SELECT b.company_id::int AS company_id, bt.base_storage::float8 AS storage
       FROM buildings b JOIN building_types bt ON bt.id = b.type_id
      WHERE b.world_id=$1 AND bt.code IN ('warehouse','harbor')`,
    [worldId],
  )
  const whExtra = new Map<number, number>()
  for (const w of warehouses) {
    whExtra.set(w.company_id, (whExtra.get(w.company_id) ?? 0) + w.storage)
  }

  const buildings = await many<Building & { x: number; y: number; has_recipe: boolean }>(
    d,
    `SELECT b.id::int, b.company_id::int, b.plot_id::int, b.level::int, b.status::text,
            p.x::int AS x, p.y::int AS y, (r.id IS NOT NULL) AS has_recipe,
            bt.code AS b_code, bt.is_retail, ind.code AS industry,
            (bt.base_storage * (1 + bt.level_storage_mult*(b.level-1)))::float8 AS storage,
            (bt.base_upkeep_hour * (1 + bt.level_upkeep_mult*(b.level-1)))::float8 AS upkeep,
            (bt.base_throughput * (1 + bt.level_throughput_mult*(b.level-1)))::float8 AS throughput,
            r.id::int AS recipe_id, r.output_qty::float8 AS output_qty,
            oi.id::int AS output_item_id, oi.code AS output_code,
            oi.retail_base::float8 AS retail_base
       FROM buildings b
       JOIN building_types bt ON bt.id = b.type_id
       JOIN plots p ON p.id = b.plot_id
       LEFT JOIN industries ind ON ind.id = bt.industry_id
       LEFT JOIN recipes r  ON r.building_type_id = bt.id AND r.is_active
       LEFT JOIN items oi   ON oi.id = r.output_item_id
      WHERE b.world_id = $1
      ORDER BY b.id`,
    [worldId],
  )
  if (buildings.length === 0) return { produced: 0, sold: 0, upkeep: 0 }

  const inputs = await many<Input>(
    d,
    `SELECT ri.recipe_id::int, ri.item_id::int, i.code, ri.qty::float8 AS qty,
            i.base_price::float8 AS base_price
       FROM recipe_inputs ri JOIN items i ON i.id = ri.item_id`,
  )
  const inputsByRecipe = new Map<number, Input[]>()
  for (const i of inputs) {
    const arr = inputsByRecipe.get(i.recipe_id) ?? []
    arr.push(i)
    inputsByRecipe.set(i.recipe_id, arr)
  }

  let produced = 0
  let sold = 0
  let upkeepPaid = 0
  const stockCache = new Map<number, InvRow[]>()
  // Fáze F: výzkumné/manažerské efekty a XP z výroby (cache na jeden tick)
  const effCache = new Map<number, CompanyEffects>()
  const effOf = async (cid: number): Promise<CompanyEffects> => {
    let e = effCache.get(cid)
    if (!e) { e = await companyEffects(d, cid); effCache.set(cid, e) }
    return e
  }
  const xpGained = new Map<number, number>()

  for (const b of buildings) {
    // dostavěno?
    if (b.status === 'construction') {
      const done = await one<{ ok: boolean }>(
        d,
        `SELECT completed_at IS NOT NULL AND completed_at <= now() AS ok
           FROM buildings WHERE id=$1`,
        [b.id],
      )
      if (done?.ok) {
        await d.query(`UPDATE buildings SET status='idle', last_settled_at=now() WHERE id=$1`, [b.id])
      }
      continue
    }

    // Fáze D: bez silničního napojení produkce stojí (ani údržby neběží)
    if (b.has_recipe && !isPlotConnected(net, b.x, b.y)) {
      await d.query(`UPDATE buildings SET status='disconnected', last_settled_at=now() WHERE id=$1`, [b.id])
      continue
    }

    const cash = await balance(d, worldId, { type: 'company', id: b.company_id }, 'cash')
    const eff = await effOf(b.company_id)
    const upkeep = round6(b.upkeep * cycles * eff.upkeep)

    // 1) údržba: bez peněz se neprojede → paused
    if (upkeep > 0) {
      if (cash < upkeep) {
        await d.query(`UPDATE buildings SET status='paused', last_settled_at=now() WHERE id=$1`, [b.id])
        continue
      }
      await post(d, worldId, [
        { party: { type: 'company', id: b.company_id }, kind: 'cash', amount: -upkeep,
          moneyFlow: 'sink', refType: 'building', refId: b.id },
        { party: { type: 'system' }, kind: 'sink_upkeep', amount: upkeep,
          moneyFlow: 'sink', refType: 'building', refId: b.id },
      ], { kind: 'upkeep' })
      upkeepPaid++
    }

    const invId = await plotInventory(d, worldId, b.company_id, b.plot_id)

    // 2) výroba
    let status = 'idle'
    if (b.recipe_id !== null && b.output_item_id !== null) {
      const used = await one<{ q: number }>(
        d,
        `SELECT COALESCE(SUM(quantity),0)::float8 AS q FROM inventory_items WHERE inventory_id=$1`,
        [invId],
      )
      const capacity = b.storage + (whExtra.get(b.company_id) ?? 0)
      const free = Math.max(0, capacity - (used?.q ?? 0))
      const need = inputsByRecipe.get(b.recipe_id) ?? []

      if (free <= 0.0001) {
        status = 'full'
      } else if (need.length === 0) {
        // extraktor: bere z ložiska, ne ze skladu
        const outMult = (eff.outputByIndustry[b.industry ?? ''] ?? 1) * eff.outputAll
        const qty = Math.min(b.output_qty * cycles * outMult, free)
        await addItems(d, invId, b.output_item_id, qty)
        produced++
        xpGained.set(b.company_id, (xpGained.get(b.company_id) ?? 0) + 1)
        status = 'producing'
      } else {
        // processor: vstupy napříč sklady firmy (logistika zjednodušená)
        let stock = stockCache.get(b.company_id)
        if (!stock) {
          stock = await companyStock(d, b.company_id)
          stockCache.set(b.company_id, stock)
        }
        const haveOf = (code: string) =>
          stock!.filter((s) => s.code === code).reduce((s, r) => s + r.avail, 0)
        // vstupy i výstup se škálují počtem hodin tohoto ticku
        const scaled = need.map((n) => ({ ...n, qty: n.qty * cycles }))
        const powerNeed = scaled.find((n) => n.code === 'power')
        const powerDeficit = powerNeed ? Math.max(0, powerNeed.qty - haveOf('power')) : 0
        // Regulovaný tarif státní sítě: +15 % proti referenční ceně. Kdyby si hráč
        // postavil vlastní elektrárnu, prodá mu ji někdo levěji → motivace stavět.
        const tariff = powerNeed ? round6(powerDeficit * powerNeed.base_price * 1.15) : 0
        const materialsOk = scaled
          .filter((n) => n.code !== 'power')
          .every((n) => haveOf(n.code) >= n.qty - 1e-9)
        const cashLeft = cash - upkeep

        if (!materialsOk) {
          status = 'starved'          // chybí surovina, ne energie
        } else if (cashLeft < tariff) {
          status = 'paused'           // není na elektřinu ze sítě
        } else {
          for (const n of scaled) {
            let left = n.qty
            for (const row of stock!.filter((s) => s.code === n.code && s.avail > 0)) {
              if (left <= 0) break
              const take = Math.min(left, row.avail)
              await takeItems(d, row.id, take)
              row.avail -= take
              left -= take
            }
            if (left > 0.0001 && n.code === 'power') {
              // chybějící elektřina → státní síť: peníze se spálí, energie vznikne
              await post(d, worldId, [
                { party: { type: 'company', id: b.company_id }, kind: 'cash', amount: -tariff,
                  moneyFlow: 'sink', refType: 'building', refId: b.id },
                { party: { type: 'system' }, kind: 'sink_utilities', amount: tariff,
                  moneyFlow: 'sink', refType: 'building', refId: b.id },
              ], { kind: 'utilities_purchase' })
            }
          }
          const outMult = (eff.outputByIndustry[b.industry ?? ''] ?? 1) * eff.outputAll
          const qty = Math.min(b.output_qty * cycles * outMult, free)
          await addItems(d, invId, b.output_item_id, qty)
          produced++
          xpGained.set(b.company_id, (xpGained.get(b.company_id) ?? 0) + 1)
          status = 'producing'
        }
      }
    }

    // 3) retail: prodejna prodává NPC zákazníkům (faucet peněz do ekonomiky)
    if (b.is_retail && b.retail_base !== null && b.output_item_id !== null) {
      const row = await one<{ id: string; avail: number }>(
        d,
        `SELECT ii.id::text, (ii.quantity - ii.reserved_qty)::float8 AS avail
           FROM inventory_items ii
          WHERE ii.inventory_id=$1 AND ii.item_id=$2 AND ii.quantity - ii.reserved_qty > 0
          LIMIT 1`,
        [invId, b.output_item_id],
      )
      const sellQty = Math.min(row?.avail ?? 0, Math.max(b.throughput * 0.25, 1) * cycles)
      if (row && sellQty > 0) {
        const gross = round6(sellQty * b.retail_base * eff.retail)
        await takeItems(d, Number(row.id), sellQty)
        await post(d, worldId, [
          { party: { type: 'system' }, kind: 'faucet_retail', amount: -gross,
            moneyFlow: 'faucet', refType: 'building', refId: b.id },
          { party: { type: 'company', id: b.company_id }, kind: 'cash', amount: gross,
            moneyFlow: 'faucet', refType: 'building', refId: b.id },
        ], { kind: 'retail_sale' })
        sold++
        if (status === 'idle') status = 'producing'
      }
    }

    await d.query(
      `UPDATE buildings SET status=$2, last_settled_at=now() WHERE id=$1`,
      [b.id, status],
    )
  }

  // 4) cargo: hráčské dopravní trasy vozí zboží mezi sklady a účtují přepravné
  const haul = await haulCargo(d, worldId, cycles)

  // 5) Fáze F: XP z výroby → posun času → světové systémy → NPC mozky.
  // Čas se posouvá PŘED kontrakty/výzkumem, aby deadliny porovnávaly už
  // novou herní hodinu.
  for (const [cid, n] of xpGained) {
    await d.query(`UPDATE companies SET xp = xp + $2 WHERE id=$1`, [cid, n])
  }
  await d.query(
    `UPDATE worlds SET sim_hours = sim_hours + $2 WHERE id=$1`,
    [worldId, cycles],
  )
  const simHours = Number(clock!.hours) + cycles
  const researchDone = await researchTick(d, worldId, simHours)
  const contracts = await contractsTick(d, worldId, simHours)
  await loansTick(d, worldId, cycles)
  await execsTick(d, worldId, cycles)
  await recordPriceHistory(d, worldId, simHours)
  const npc = await npcTick(d, worldId, cycles)

  return { produced, sold, upkeep: upkeepPaid, paused: false, haul,
           researchDone, contracts, npc }
}

/**
 * Periodický spouštěč. `getWorldId` čte AKTUÁLNÍ worldId z closure serveru,
 * protože /api/demo/reset ho za běhu vymění; tx() si bere čerstvou instanci DB
 * z db.ts singletonu, který reset taky obnoví.
 */
export function startTick(getWorldId: () => number) {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    const worldId = getWorldId()
    void tx((t) => runTick(t, worldId))
      .then((s: { produced: number; sold: number; upkeep: number
                   haul?: { units: number; routes: number }
                   researchDone?: number
                   contracts?: { expired: number; generated: number }
                   npc?: { sells: number; buys: number; expansions: string[] } }) => {
        if (s.produced || s.sold || s.haul?.units || s.npc?.sells || s.npc?.buys) {
          const h = s.haul?.units ? `, cargo ${s.haul.units} ks (${s.haul.routes} tras)` : ''
          const n = s.npc && (s.npc.sells || s.npc.buys)
            ? `, NPC ${s.npc.sells} prodejů/${s.npc.buys} nákupů` : ''
          const r = s.researchDone ? `, výzkum hotový ×${s.researchDone}` : ''
          console.log(`  ⚙️  tick: výroba ${s.produced}, retail ${s.sold}, údržby ${s.upkeep}${h}${n}${r}`)
          for (const x of s.npc?.expansions ?? []) console.log(`  🏗️  expanze ${x}`)
        }
      })
      .catch((e) => console.error('  ⚠️  tick selhal:', e instanceof Error ? e.message : e))
      .finally(() => { running = false })
  }, TICK_MS)
  timer.unref?.()
  return timer
}

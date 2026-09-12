/**
 * CLOB matching engine.
 *
 * Price-time priority, deterministický, atomický: jedna DB transakce přesune
 * zboží + hotovost + zapíše trade + zaúčtuje obě strany do ledgeru. Buď všechno,
 * nebo nic.
 *
 * TŘI VĚCI, KTERÉ TOHLE DĚLÁ SPRÁVNĚ (a na kterých hra stojí nebo padá):
 *
 *  1. ESCROW PŘI ZALOŽENÍ, ne při vyplnění. Sell order okamžitě zarezervuje zboží
 *     (`reserved_qty`), buy order okamžitě zablokuje hotovost (cash → escrow_market).
 *     Bez toho lze přeprodat: hráč založí 10 sell orderů na stejných 100 prken a
 *     všechny se vyplní — zboží vznikne z ničeho. CHECK `reserved_qty <= quantity`
 *     to odmítne na úrovni DB.
 *
 *  2. TRADE PRICE = CENA ODPOČÍVAJÍCÍHO příkazu (maker). Příchozí order je taker.
 *     Proto `fee_maker` (0,5 %) ≠ `fee_taker` (2,5 %): subvencuje trpělivost a
 *     trestá netrpělivost, což systematicky prohlubuje booky.
 *
 *  3. WASH TRADING JE NEMOŽNÝ. Příkazy téže firmy se proti sobě nespárují
 *     (plus CHECK `buyer IS DISTINCT FROM seller` na `trades` jako záloha).
 */
import type { Db } from './db.ts'
import { many, one } from './db.ts'
import { post, round6 } from './ledger.ts'

export const FEE_MAKER = 0.005     // 0,5 % — odpočívající příkaz
export const FEE_TAKER = 0.025     // 2,5 % — příchozí příkaz
export const FEE_MIN = 0.01        // aby mikro-obchody nebyly zadarmo

export type Side = 'buy' | 'sell'

export type ItemRow = {
  id: string; code: string; name: string; category: string; tier: number
  base_price: string; retail_base: string | null; tick_size: string
  min_lot: string; max_order_qty: string; is_retail_product: boolean
}

export class MarketError extends Error {
  constructor(message: string, public readonly code: string) { super(message) }
}

async function loadItem(d: Db, code: string): Promise<ItemRow> {
  const it = await one<ItemRow>(
    d,
    `SELECT i.id, i.code, i.name, i.category, i.tier,
            i.base_price::float8::text AS base_price,
            i.retail_base::float8::text AS retail_base,
            i.tick_size::float8::text AS tick_size,
            i.min_lot::float8::text AS min_lot,
            i.max_order_qty::float8::text AS max_order_qty,
            EXISTS(SELECT 1 FROM building_types bt WHERE bt.is_retail
                    AND bt.id IN (SELECT r.building_type_id FROM recipes r
                                   WHERE r.output_item_id = i.id)) AS is_retail_product
       FROM items i WHERE i.code = $1`,
    [code],
  )
  if (!it) throw new MarketError(`neznámá položka '${code}'`, 'unknown_item')
  return it
}

async function primaryInventoryId(d: Db, companyId: number): Promise<number> {
  const r = await one<{ id: string }>(
    d,
    `SELECT id FROM inventories WHERE company_id = $1 AND is_primary LIMIT 1`,
    [companyId],
  )
  if (!r) throw new MarketError(`firma ${companyId} nemá primární sklad`, 'no_inventory')
  return Number(r.id)
}

/** Zarezervuje zboží sell příkazu napříč inventáři firmy (grepedy dle id). */
async function reserveGoods(
  d: Db, companyId: number, itemId: number, tier: number, qty: number, itemCode: string,
): Promise<number> {
  const rows = await many<{ id: number; avail: number }>(
    d,
    `SELECT ii.id::int, (ii.quantity - ii.reserved_qty)::float8 AS avail
       FROM inventory_items ii JOIN inventories v ON v.id = ii.inventory_id
      WHERE v.company_id=$1 AND ii.item_id=$2 AND ii.quality_tier=$3
        AND ii.quantity - ii.reserved_qty > 0
      ORDER BY ii.id`,
    [companyId, itemId, tier],
  )
  const total = round6(rows.reduce((acc, r) => acc + r.avail, 0))
  if (total + 1e-9 < qty) {
    throw new MarketError(
      `nedostatek ${itemCode} (tier ${tier}): k dispozici ${total}, požadováno ${qty}`,
      'insufficient_goods')
  }
  let left = qty
  for (const r of rows) {
    if (left <= 1e-9) break
    const take = round6(Math.min(left, r.avail))
    if (take <= 0) continue
    await d.query(
      `UPDATE inventory_items SET reserved_qty = reserved_qty + $2, updated_at = now()
        WHERE id=$1`,
      [r.id, take],
    )
    left = round6(left - take)
  }
  return round6(qty - left)
}

/** Spotřebuje zarezervované zboží při fillu (quantity i reserved dolů). */
async function consumeReservedGoods(
  d: Db, companyId: number, itemId: number, tier: number, qty: number,
): Promise<void> {
  const rows = await many<{ id: number; take_max: number }>(
    d,
    `SELECT ii.id::int, LEAST(ii.reserved_qty, ii.quantity)::float8 AS take_max
       FROM inventory_items ii JOIN inventories v ON v.id = ii.inventory_id
      WHERE v.company_id=$1 AND ii.item_id=$2 AND ii.quality_tier=$3
        AND ii.reserved_qty > 0
      ORDER BY ii.id`,
    [companyId, itemId, tier],
  )
  let left = round6(qty)
  for (const r of rows) {
    if (left <= 1e-9) break
    const take = round6(Math.min(left, r.take_max))
    if (take <= 0) continue
    await d.query(
      `UPDATE inventory_items
          SET quantity = quantity - $2, reserved_qty = reserved_qty - $2, updated_at = now()
        WHERE id=$1`,
      [r.id, take],
    )
    left = round6(left - take)
  }
}

export type PlaceOrderInput = {
  worldId: number
  companyId: number
  itemCode: string
  qualityTier?: number
  side: Side
  qty: number
  priceLimit?: number | null
  orderType?: 'limit' | 'market'
  idempotencyKey?: string | null
}

export type Fill = {
  tradeId: number; price: number; qty: number; gross: number
  feeBuyer: number; feeSeller: number
  counterparty: string; executedAt: string
}

export type PlaceOrderResult = {
  orderId: number
  status: string
  qty: number
  qtyFilled: number
  remaining: number
  priceLimit: number | null
  fills: Fill[]
  avgPrice: number | null
  totalGross: number
  totalFees: number
  escrowed: number
  /** Kolik se uvolnilo zpět na cash při vypořádání terminálního příkazu. */
  releasedEscrow: number
  /** Kolik zůstává zablokováno (nenulové jen u příkazu, který zůstává v booku). */
  stillLocked: number
  reserved: number
  idempotencyKey: string | null
  cached?: boolean
}

/**
 * Založí příkaz a okamžitě ho spáruje proti booku.
 * Celé v jedné transakci — deferred ledger trigger vyhodnotí invariant při COMMIT.
 */
export async function placeOrder(d0: Db, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const {
    worldId, companyId, itemCode, side,
    qualityTier = 1, orderType = 'limit', idempotencyKey = null,
  } = input

  const item = await loadItem(d0, itemCode)
  const minLot = Number(item.min_lot)
  const tick = Number(item.tick_size)
  const maxQty = Number(item.max_order_qty)

  if (!(input.qty > 0)) throw new MarketError('množství musí být > 0', 'bad_qty')
  if (input.qty < minLot) {
    throw new MarketError(`minimální lot pro ${itemCode} je ${minLot}`, 'below_min_lot')
  }
  if (input.qty > maxQty) {
    throw new MarketError(`maximální množství příkazu je ${maxQty}`, 'above_max_qty')
  }

  const isMarket = orderType === 'market'
  let priceLimit = input.priceLimit ?? null
  if (isMarket) {
    priceLimit = null
  } else {
    if (priceLimit === null || !(priceLimit > 0)) {
      throw new MarketError('limitní příkaz vyžaduje kladnou cenu', 'bad_price')
    }
    // cena musí být násobek tick_size — jinak by book měl nekonečně mnoho hladin
    const steps = priceLimit / tick
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      throw new MarketError(
        `cena ${priceLimit} není násobek tick_size ${tick} pro ${itemCode}`, 'bad_tick')
    }
    priceLimit = round6(priceLimit)
  }

  // ---- idempotence: klient generuje UUID, server ho drží -------------------
  if (idempotencyKey) {
    const dup = await one<{ response: string }>(
      d0,
      `SELECT response::text FROM idempotency_keys
        WHERE company_id=$1 AND scope='market_order' AND key=$2 AND expires_at > now()`,
      [companyId, idempotencyKey],
    )
    if (dup) return { ...JSON.parse(dup.response), cached: true } as PlaceOrderResult
  }

  const itemId = Number(item.id)
  const qty = round6(input.qty)

  // ---- ESCROW při založení --------------------------------------------------
  const inventoryId = await primaryInventoryId(d0, companyId)
  let reserved = 0
  let escrowed = 0

  if (side === 'sell') {
    // Rezervace napříč VŠEMI sklady firmy: od Fáze E má každá budova vlastní
    // dvorec a příkazu je jedno, ve kterém zboží leží.
    reserved = await reserveGoods(d0, companyId, itemId, qualityTier, qty, itemCode)
  } else if (side === 'buy') {
    // Kolik peněz MUSÍME zablokovat, aby příkaz nemohl utratit víc, než má?
    // Základ je nejhorší možná hrubá cena; k tomu rezerva na poplatek, protože
    // poplatek se platí Z escrow (viz fill níže).
    let worstGross: number
    if (!isMarket && priceLimit !== null) {
      // Limitní buy nikdy nenakoupí dráž než za svůj limit. Rezervu počítáme
      // podle TAKER sazby, ačkoli jako odpočívající příkaz zaplatí maker —
      // v okamžiku založení ještě nevíme, která strana bude taker.
      worstGross = round6(priceLimit * qty)
    } else {
      // Market buy (IOC) smetá book směrem nahoru, takže skutečný strop je součet
      // cen po jednotlivých hladinách — ne nejlepší ask. Původní „×1.001 rezerva“
      // byla špatně oběma směry: u tenkého booku moc malá (fill by šel do mínusu)
      // a u hlubokého booku zbytek navždy zůstal zablokovaný v escrow.
      const sweep = await worstCaseSweep(d0, worldId, itemId, qualityTier, companyId, qty)
      if (sweep.available <= 0) {
        throw new MarketError(`v booku není žádný ask na ${itemCode}`, 'no_liquidity')
      }
      worstGross = round6(sweep.cost)
    }
    escrowed = round6(worstGross * (1 + FEE_TAKER) + FEE_MIN)
  }

  if (escrowed > 0) {
    await post(d0, worldId, [
      { party: { type: 'company', id: companyId }, kind: 'cash', amount: -escrowed,
        moneyFlow: 'internal', refType: 'market_order' },
      { party: { type: 'company', id: companyId }, kind: 'escrow_market', amount: escrowed,
        moneyFlow: 'internal', refType: 'market_order' },
    ], { kind: 'escrow_lock' })
  }

  // ---- založení příkazu -----------------------------------------------------
  const ord = await one<{ id: string }>(
    d0,
    `INSERT INTO market_orders
       (world_id, company_id, item_id, quality_tier, side, order_type, price_limit,
        qty, qty_filled, status, escrow_locked, idempotency_key, is_npc,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'open',$9,$10,false,now(),now())
     RETURNING id`,
    [worldId, companyId, itemId, qualityTier, side, orderType, priceLimit, qty,
     escrowed, idempotencyKey],
  )
  const orderId = Number(ord!.id)

  // ---- MATCHING -------------------------------------------------------------
  const fills = await match(d0, {
    worldId, orderId, companyId, itemId, itemCode: item.code,
    qualityTier, side, qty, priceLimit, isMarket, inventoryId,
  })

  const qtyFilled = round6(fills.reduce((s, f) => s + f.qty, 0))
  const remaining = round6(qty - qtyFilled)

  // Market order se nikdy nenechává v booku (IOC).
  let status: string
  if (remaining <= 0) status = 'filled'
  else if (isMarket) status = 'cancelled'
  else status = qtyFilled > 0 ? 'partial' : 'open'

  // Vypořádání terminálního příkazu: nespotřebované zboží zpět mezi volné zásoby
  // a zbytek escrow zpět na cash.
  let releasedEscrow = 0
  if (status !== 'open' && status !== 'partial') {
    if (side === 'sell' && remaining > 0) {
      await unreserveGoods(d0, companyId, itemId, qualityTier, remaining)
    }
    releasedEscrow = await releaseLockedEscrow(d0, worldId, companyId, orderId)
  }
  await d0.query(
    `UPDATE market_orders SET status=$1::order_status, qty_filled=$2, updated_at=now(),
            cancelled_at = CASE WHEN $1::order_status = 'cancelled'
                                THEN now() ELSE cancelled_at END
      WHERE id=$3`,
    [status, qtyFilled, orderId],
  )

  const totalGross = round6(fills.reduce((s, f) => s + f.gross, 0))
  const totalFees = round6(fills.reduce((s, f) => s + f.feeBuyer + f.feeSeller, 0))
  // Kolik kupující skutečně vyčerpal ze svého zámku. U příchozího SELL příkazu
  // je kupující protistrana, takže náš zámek nespotřeboval žádný fill.
  const buyerSpent = side === 'buy'
    ? round6(fills.reduce((acc, f) => acc + f.gross + f.feeBuyer, 0))
    : 0
  // Zbytek zámku ČTEME z databáze, nedopočítáváme. Escrow se uvolňuje na dvou
  // místech (při doplnění příkazu v settleFill a při vypořádání terminálního
  // příkazu), takže aritmetika v aplikaci by snadno začala lhát. DB je zdroj pravdy
  // a fn_audit_escrow_mismatch() ji nezávisle kontroluje.
  const stillLocked = await lockedEscrowOf(d0, orderId)
  // Celkem uvolněno zpět na cash (mohlo se to stát ve dvou krocích — viz výše).
  const totalReleased = round6(escrowed - buyerSpent - stillLocked)
  void releasedEscrow

  const result: PlaceOrderResult = {
    orderId, status, qty, qtyFilled, remaining, priceLimit, fills,
    avgPrice: qtyFilled > 0 ? round6(totalGross / qtyFilled) : null,
    totalGross, totalFees, escrowed, releasedEscrow: totalReleased,
    stillLocked, reserved, idempotencyKey,
  }

  if (idempotencyKey) {
    await d0.query(
      `INSERT INTO idempotency_keys (key, company_id, scope, response, expires_at)
       VALUES ($1,$2,'market_order',$3, now() + interval '24 hours')
       ON CONFLICT DO NOTHING`,
      [idempotencyKey, companyId, JSON.stringify(result)],
    )
  }
  return result
}

/**
 * Zapíše jeden fill na jeden příkaz.
 *
 * `remainingBefore` je nespotřebované množství PŘED tímhle fillem. Pokud fill
 * příkaz doplní, uvolní se zbytek escrow (u SELL příkazu je escrow_locked 0,
 * takže je to no-op) a teprve pak se zvedne qty_filled a přepne status.
 */
async function settleFill(
  d: Db, worldId: number, orderId: number, companyId: number,
  fillQty: number, remainingBefore: number,
): Promise<void> {
  const completes = remainingBefore - fillQty <= 1e-9
  if (completes) await releaseLockedEscrow(d, worldId, companyId, orderId)

  await d.query(
    `UPDATE market_orders
        SET qty_filled = qty_filled + $1,
            status = (CASE WHEN qty_filled + $1 >= qty
                           THEN 'filled' ELSE 'partial' END)::order_status,
            updated_at = now()
      WHERE id = $2`,
    [fillQty, orderId],
  )
}

/**
 * Přesný nejhorší případ pro market buy: projde book po hladinách v pořadí
 * price-time priority a sečte cenu za množství, které by se skutečně zobchodovalo.
 *
 * `cum` je kumulativní množství od nejlepšího asku, `cum - rem` množství PŘED
 * touhle hladinou. Z hladiny tedy bereme LEAST(rem, zbývající poptávka).
 * Vrací i celkovou dostupnou likviditu (bez vlastních příkazů — anti wash).
 */
async function worstCaseSweep(
  d: Db, worldId: number, itemId: number, qualityTier: number,
  companyId: number, qty: number,
): Promise<{ cost: number; available: number }> {
  const r = await one<{ cost: string; available: string }>(
    d,
    `WITH book AS (
       SELECT (o.qty - o.qty_filled) AS rem, o.price_limit,
              SUM(o.qty - o.qty_filled)
                OVER (ORDER BY o.price_limit, o.created_at) AS cum
         FROM market_orders o
        WHERE o.world_id=$1 AND o.item_id=$2 AND o.quality_tier=$3 AND o.side='sell'
          AND o.status IN ('open','partial') AND o.order_type='limit' AND o.is_npc=false
          AND o.company_id <> $4
     )
     SELECT COALESCE(SUM(LEAST(rem, $5 - (cum - rem)) * price_limit), 0)::float8::text AS cost,
            COALESCE(SUM(rem), 0)::float8::text AS available
       FROM book
      WHERE cum - rem < $5`,
    [worldId, itemId, qualityTier, companyId, qty],
  )
  return { cost: Number(r?.cost ?? 0), available: Number(r?.available ?? 0) }
}

/** Vrátí nespotřebované zboží z rezervace zpět mezi volné zásoby (napříč sklady). */
async function unreserveGoods(
  d: Db, companyId: number, itemId: number, qualityTier: number, qty: number,
): Promise<void> {
  const rows = await many<{ id: number; res: number }>(
    d,
    `SELECT ii.id::int, ii.reserved_qty::float8 AS res
       FROM inventory_items ii JOIN inventories v ON v.id = ii.inventory_id
      WHERE v.company_id=$1 AND ii.item_id=$2 AND ii.quality_tier=$3
        AND ii.reserved_qty > 0
      ORDER BY ii.id`,
    [companyId, itemId, qualityTier],
  )
  let left = round6(qty)
  for (const r of rows) {
    if (left <= 1e-9) break
    const take = round6(Math.min(left, r.res))
    if (take <= 0) continue
    await d.query(
      `UPDATE inventory_items SET reserved_qty = reserved_qty - $2, updated_at = now()
        WHERE id=$1`,
      [r.id, take],
    )
    left = round6(left - take)
  }
}

/**
 * Uvolní VEŠKERÝ zbývající escrow příkazu zpět na cash.
 *
 * Částku ČTE z market_orders.escrow_locked místo dopočítávání z price_limit —
 * to je přesně ta vlastnost, kvůli které sloupec existuje. Dopočítávaná hodnota
 * nezná cenu, za kterou se skutečně plnilo, a zanechává drobné zbytky navždy
 * zablokované (únik peněz, který odhalí až makro čísla po týdnech).
 */
/** Kolik hotovosti je na tomhle příkazu právě zablokováno. */
async function lockedEscrowOf(d: Db, orderId: number): Promise<number> {
  const row = await one<{ locked: string }>(
    d, `SELECT escrow_locked::float8::text AS locked FROM market_orders WHERE id=$1`,
    [orderId],
  )
  return round6(Number(row?.locked ?? 0))
}

async function releaseLockedEscrow(
  d: Db, worldId: number, companyId: number, orderId: number,
): Promise<number> {
  const locked = await lockedEscrowOf(d, orderId)
  if (locked <= 0) return 0

  await post(d, worldId, [
    { party: { type: 'company', id: companyId }, kind: 'escrow_market', amount: -locked,
      moneyFlow: 'internal', refType: 'market_order', refId: orderId },
    { party: { type: 'company', id: companyId }, kind: 'cash', amount: locked,
      moneyFlow: 'internal', refType: 'market_order', refId: orderId },
  ], { kind: 'escrow_release' })

  await d.query(`UPDATE market_orders SET escrow_locked = 0, updated_at = now() WHERE id=$1`,
                [orderId])
  return locked
}

type MatchCtx = {
  worldId: number; orderId: number; companyId: number; itemId: number
  itemCode: string; qualityTier: number; side: Side; qty: number
  priceLimit: number | null; isMarket: boolean; inventoryId: number
}

/** Spáruje příchozí příkaz proti booku. Vrací fill-y. */
/** Multiplikátor poplatků firmy (obchodní manažeři). Cache v rámci jednoho matche. */
async function feeMultFor(d: Db, cache: Map<number, number>, companyId: number): Promise<number> {
  let m = cache.get(companyId)
  if (m === undefined) {
    const r = await one<{ b: number }>(
      d,
      `SELECT COALESCE(bonus_pct, 0)::float8 AS b FROM executives
        WHERE company_id=$1 AND role='trade'`,
      [companyId],
    )
    m = 1 - Math.min(50, r?.b ?? 0) / 100
    cache.set(companyId, m)
  }
  return m
}

async function match(d: Db, ctx: MatchCtx): Promise<Fill[]> {
  const fills: Fill[] = []
  const feeCache = new Map<number, number>()
  let remaining = ctx.qty

  while (remaining > 1e-9) {
    const opposite: Side = ctx.side === 'buy' ? 'sell' : 'buy'

    // Placeholdery číslujeme POSTUPNĚ. Ruční dosazování typu `$6` naprázdno nebo
    // přečíslování přes .replace() nutně ujede, jakmile je některý parametr
    // podmíněný (tady priceLimit — market order ho nemá). Tohle nemůže driftovat.
    const params: unknown[] = []
    const ph = (v: unknown) => { params.push(v); return `$${params.length}` }

    const pWorld = ph(ctx.worldId)
    const pItem = ph(ctx.itemId)
    const pTier = ph(ctx.qualityTier)
    const pSide = ph(opposite)
    const pCo = ph(ctx.companyId)

    // Market order (IOC) smetá celý book bez cenového stropu.
    // Limitní buy páruje jen asky NA NEBO POD svým limitem, sell jen bidy
    // NA NEBO NAD — jinak by se obchod uzavřel za cenu, kterou strana nezadala.
    const priceFilter = ctx.isMarket || ctx.priceLimit === null
      ? ''
      : `AND o.price_limit ${ctx.side === 'buy' ? '<=' : '>='} ${ph(ctx.priceLimit)}`

    const resting = await one<{
      id: string; company_id: string; price_limit: string; remaining: string; created_at: string
    }>(
      d,
      `SELECT o.id, o.company_id::text, o.price_limit::float8::text,
              (o.qty - o.qty_filled)::float8::text AS remaining, o.created_at
         FROM market_orders o
        WHERE o.world_id=${pWorld} AND o.item_id=${pItem} AND o.quality_tier=${pTier}
          AND o.side=${pSide} AND o.status IN ('open','partial')
          AND o.order_type='limit' AND o.is_npc=false
          AND o.company_id <> ${pCo}              -- anti wash-trading
          ${priceFilter}
        ORDER BY ${ctx.side === 'buy' ? 'o.price_limit ASC' : 'o.price_limit DESC'},
                 o.created_at ASC
        LIMIT 1`,
      params,
    )
    if (!resting) break

    const restingQty = Number(resting.remaining)
    const fillQty = round6(Math.min(remaining, restingQty))
    if (fillQty <= 0) break
    const price = Number(resting.price_limit)          // cena MAKERA
    const gross = round6(fillQty * price)
    const buyerId = ctx.side === 'buy' ? ctx.companyId : Number(resting.company_id)
    const sellerId = ctx.side === 'sell' ? ctx.companyId : Number(resting.company_id)
    // Obchodní manažeři snižují burzovní poplatky své firmě (relativně).
    const feeBuyer = Math.max(FEE_MIN, round6(
      gross * (ctx.side === 'buy' ? FEE_TAKER : FEE_MAKER) * await feeMultFor(d, feeCache, buyerId)))
    const feeSeller = Math.max(FEE_MIN, round6(
      gross * (ctx.side === 'sell' ? FEE_TAKER : FEE_MAKER) * await feeMultFor(d, feeCache, sellerId)))

    // ---- pohyb ZBOŽÍ --------------------------------------------------------
    // prodávající: zásoby i rezervace dolů napříč sklady (zboží bylo v escrow
    // od založení orderu)
    await consumeReservedGoods(d, sellerId, ctx.itemId, ctx.qualityTier, fillQty)
    // kupující: zásoby nahoru
    const buyerInv = await primaryInventoryId(d, buyerId)
    await d.query(
      `INSERT INTO inventory_items (inventory_id, item_id, quality_tier, quantity, reserved_qty)
       VALUES ($1,$2,$3,$4,0)
       ON CONFLICT (inventory_id, item_id, quality_tier)
       DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity,
                     updated_at = now()`,
      [buyerInv, ctx.itemId, ctx.qualityTier, fillQty],
    )

    // ---- pohyb PENĚZ (podvojně, Σ = 0) --------------------------------------
    // Kupující platí hrubou cenu I svůj poplatek Z ESCROW, prodávající dostává
    // cenu na cash mínus svůj poplatek, poplatky mizí do systémového sinku.
    //   Σ = -(gross+feeBuyer) + (gross-feeSeller) + (feeBuyer+feeSeller) = 0
    // Nic se nedopočítává z price_limit — proto tenhle money flow sedí na fill
    // přesně i u limitního příkazu, který se plnil levněji, než byl jeho limit.
    const buyerOrderId = ctx.side === 'buy' ? ctx.orderId : Number(resting.id)
    const buyerEscrowOut = round6(gross + feeBuyer)

    await post(d, ctx.worldId, [
      { party: { type: 'company', id: buyerId }, kind: 'escrow_market',
        amount: -buyerEscrowOut, moneyFlow: 'transfer', refType: 'trade' },
      { party: { type: 'company', id: sellerId }, kind: 'cash',
        amount: round6(gross - feeSeller), moneyFlow: 'transfer', refType: 'trade' },
      { party: { type: 'system' }, kind: 'sink_exchange_fee',
        amount: round6(feeBuyer + feeSeller), moneyFlow: 'sink', refType: 'trade' },
    ], { kind: 'market_trade' })

    // Zámek na kupujícího příkazu se o stejnou částku zmenší. Kdyby ne,
    // fn_audit_escrow_mismatch() by to okamžitě hlásil jako únik peněz.
    await d.query(
      `UPDATE market_orders SET escrow_locked = escrow_locked - $1, updated_at = now()
        WHERE id = $2`,
      [buyerEscrowOut, buyerOrderId],
    )

    // ---- trade (append-only) ------------------------------------------------
    const tr = await one<{ id: string; executed_at: string }>(
      d,
      `INSERT INTO trades (world_id, item_id, quality_tier, price, qty, gross_value,
                           buy_order_id, sell_order_id, buyer_company_id,
                           seller_company_id, fee_buyer, fee_seller, is_npc_involved,
                           executed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,now())
       RETURNING id, executed_at`,
      [ctx.worldId, ctx.itemId, ctx.qualityTier, round6(price), fillQty, gross,
       ctx.side === 'buy' ? ctx.orderId : Number(resting.id),
       ctx.side === 'sell' ? ctx.orderId : Number(resting.id),
       buyerId, sellerId, round6(feeBuyer), round6(feeSeller)],
    )

    // ---- aktualizace obou příkazů -------------------------------------------
    // ★ POŘADÍ JE ZÁSADNÍ. Příkaz, který se tímhle fillem DOPLNÍ, musí nejdřív
    // uvolnit zbytek svého escrow a teprve potom dostat status 'filled':
    //   • market_orders_terminal_no_escrow je obyčejný CHECK → vyhodnocuje se
    //     okamžitě, řádek nesmí být ani na okamžik 'filled' s nenulovým zámkem.
    //   • market_orders_filled_status_consistency naopak zakazuje zvednout
    //     qty_filled na plno, dokud status není 'filled'.
    // Obojí dohromady znamená: uvolnit escrow → pak atomicky množství i status.
    await settleFill(d, ctx.worldId, Number(resting.id), Number(resting.company_id),
                     fillQty, Number(resting.remaining))
    await settleFill(d, ctx.worldId, ctx.orderId, ctx.companyId, fillQty, remaining)

    fills.push({
      tradeId: Number(tr!.id), price, qty: fillQty, gross,
      feeBuyer: round6(feeBuyer), feeSeller: round6(feeSeller),
      counterparty: resting.company_id, executedAt: tr!.executed_at,
    })
    remaining = round6(remaining - fillQty)
  }
  return fills
}


/** Zrušení příkazu + uvolnění escrow/rezervace. */
export async function cancelOrder(d: Db, worldId: number, companyId: number, orderId: number) {
  const o = await one<{
    id: string; side: Side; status: string; item_id: string; quality_tier: number
    price_limit: string | null; qty: string; qty_filled: string; company_id: string
  }>(
    d,
    `SELECT id, side, status::text, item_id::text, quality_tier,
            price_limit::float8::text, qty::float8::text, qty_filled::float8::text,
            company_id::text
       FROM market_orders WHERE id=$1 AND world_id=$2`,
    [orderId, worldId],
  )
  if (!o) throw new MarketError(`příkaz ${orderId} neexistuje`, 'not_found')
  if (Number(o.company_id) !== companyId) {
    throw new MarketError('nemůžeš zrušit cizí příkaz', 'forbidden')
  }
  if (!['open', 'partial'].includes(o.status)) {
    throw new MarketError(`příkaz je už '${o.status}', nelze zrušit`, 'not_cancellable')
  }
  const remaining = round6(Number(o.qty) - Number(o.qty_filled))

  // Uvolnění MUSÍ proběhnout PŘED změnou statusu: CHECK
  // market_orders_terminal_no_escrow se vyhodnocuje okamžitě, takže řádek
  // nesmí být ani na okamžik 'cancelled' s nenulovým escrow_locked.
  if (o.side === 'sell' && remaining > 0) {
    await unreserveGoods(d, companyId, Number(o.item_id), o.quality_tier, remaining)
  }
  const releasedCash = await releaseLockedEscrow(d, worldId, companyId, orderId)

  await d.query(
    `UPDATE market_orders SET status='cancelled', cancelled_at=now(), updated_at=now()
      WHERE id=$1`, [orderId])
  return { orderId, cancelled: true, releasedQty: remaining, releasedCash }
}

// ---------------------------------------------------------------------------
// Čtení trhu
// ---------------------------------------------------------------------------

export type BookLevel = { price: number; qty: number; orders: number; total: number }

/** L2 agregovaná hloubka booku — tohle posíláme klientovi, ne L3. */
export async function orderBook(
  d: Db, worldId: number, itemCode: string, qualityTier = 1, depth = 15,
) {
  const item = await loadItem(d, itemCode)
  const itemId = Number(item.id)

  const [bids, asks] = await Promise.all([
    many<{ price: string; qty: string; orders: string }>(
      d,
      `SELECT price_limit::float8::text price,
              SUM(qty - qty_filled)::float8::text qty, count(*)::text orders
         FROM market_orders
        WHERE world_id=$1 AND item_id=$2 AND quality_tier=$3 AND side='buy'
          AND status IN ('open','partial') AND order_type='limit' AND is_npc=false
        GROUP BY price_limit ORDER BY price_limit DESC LIMIT $4`,
      [worldId, itemId, qualityTier, depth],
    ),
    many<{ price: string; qty: string; orders: string }>(
      d,
      `SELECT price_limit::float8::text price,
              SUM(qty - qty_filled)::float8::text qty, count(*)::text orders
         FROM market_orders
        WHERE world_id=$1 AND item_id=$2 AND quality_tier=$3 AND side='sell'
          AND status IN ('open','partial') AND order_type='limit' AND is_npc=false
        GROUP BY price_limit ORDER BY price_limit ASC LIMIT $4`,
      [worldId, itemId, qualityTier, depth],
    ),
  ])

  const mk = (rows: typeof bids): BookLevel[] => {
    let acc = 0
    return rows.map((r) => {
      acc += Number(r.qty)
      return { price: Number(r.price), qty: round6(Number(r.qty)),
               orders: Number(r.orders), total: round6(acc) }
    })
  }

  const b = mk(bids), a = mk(asks)
  const bestBid = b[0]?.price ?? null
  const bestAsk = a[0]?.price ?? null
  const spread = bestBid !== null && bestAsk !== null
    ? round6(bestAsk - bestBid) : null

  const twap = await one<{ twap: string | null; volume: string; trades: string }>(
    d,
    `SELECT (SUM(gross_value)/NULLIF(SUM(qty),0))::float8::text AS twap,
            COALESCE(SUM(qty),0)::float8::text AS volume, count(*)::text AS trades
       FROM trades
      WHERE world_id=$1 AND item_id=$2 AND quality_tier=$3
        AND executed_at > now() - interval '30 days'`,
    [worldId, itemId, qualityTier],
  )
  const last = await one<{ price: string; executed_at: string }>(
    d,
    `SELECT price::float8::text price, executed_at FROM trades
      WHERE world_id=$1 AND item_id=$2 AND quality_tier=$3
      ORDER BY executed_at DESC, id DESC LIMIT 1`,
    [worldId, itemId, qualityTier],
  )

  return {
    item: { code: item.code, name: item.name, tier: item.tier,
            category: item.category, basePrice: Number(item.base_price),
            retailBase: item.retail_base === null ? null : Number(item.retail_base),
            tickSize: Number(item.tick_size), minLot: Number(item.min_lot) },
    qualityTier,
    bids: b, asks: a,
    bestBid, bestAsk, spread,
    mid: bestBid !== null && bestAsk !== null ? round6((bestBid + bestAsk) / 2) : null,
    lastPrice: last ? Number(last.price) : null,
    lastAt: last?.executed_at ?? null,
    twap30d: twap?.twap === null || twap?.twap === undefined ? null : Number(twap.twap),
    volume30d: Number(twap?.volume ?? 0),
    trades30d: Number(twap?.trades ?? 0),
  }
}

export async function recentTrades(d: Db, worldId: number, limit = 25) {
  return many<{
    id: string; item: string; quality_tier: number; price: number; qty: number
    gross: number; buyer: string; seller: string; executed_at: string
  }>(
    d,
    `SELECT t.id::text, i.code AS item, t.quality_tier,
            t.price::float8 AS price, t.qty::float8 AS qty,
            t.gross_value::float8 AS gross,
            bc.name AS buyer, sc.name AS seller, t.executed_at
       FROM trades t
       JOIN items i ON i.id = t.item_id
       LEFT JOIN companies bc ON bc.id = t.buyer_company_id
       LEFT JOIN companies sc ON sc.id = t.seller_company_id
      WHERE t.world_id = $1
      ORDER BY t.executed_at DESC, t.id DESC
      LIMIT $2`,
    [worldId, limit],
  )
}

export async function openOrders(d: Db, worldId: number, companyId: number) {
  return many<{
    id: string; item: string; side: Side; price_limit: number | null
    qty: number; qty_filled: number; status: string; created_at: string
  }>(
    d,
    `SELECT o.id::text, i.code AS item, o.side, o.price_limit::float8,
            o.qty::float8, o.qty_filled::float8, o.status::text, o.created_at
       FROM market_orders o JOIN items i ON i.id = o.item_id
      WHERE o.world_id=$1 AND o.company_id=$2 AND o.status IN ('open','partial')
      ORDER BY o.created_at DESC`,
    [worldId, companyId],
  )
}

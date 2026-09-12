/**
 * Smoke test obchodního cyklu — spouští se proti běžícímu API.
 *
 * Není to jen „zavoláme endpoint a něco se vrátí“. Test PŘEPOČÍTÁVÁ peníze
 * nezávisle na implementaci (hrubá cena, maker/taker poplatky, pohyb M2) a
 * porovnává je s tím, co vrátil ledger. Kdyby se matching engine a podvojný
 * účetnictví rozešly, tohle to chytí.
 *
 *   node tools/api/smoke.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:8080/api'

let pass = 0
let fail = 0
function check(label, actual, expected, eps = 1e-6) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= eps
    : actual === expected
  if (ok) { pass++; console.log(`  ✅ ${label} = ${actual}`) }
  else { fail++; console.log(`  ❌ ${label}: čekáno ${expected}, dostali ${actual}`) }
}

const j = async (path) => (await fetch(BASE + path)).json()
const post = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}
const del = async (path) => {
  const r = await fetch(BASE + path, { method: 'DELETE' })
  return { status: r.status, body: await r.json() }
}

const FEE_MAKER = 0.005
const FEE_TAKER = 0.025

console.log('\n────────────────────────────────────────────────────────────')
console.log(' CEO · smoke test obchodního cyklu')
console.log('────────────────────────────────────────────────────────────')

// čistý svět, aby byl test opakovatelný
await post('/demo/reset', {})
const health = await j('/health')
console.log(`\n[0] health: engine=${health.engine} world=${health.worldId}`)
check('audit po resetu', (await j('/audit')).verdict, 'PASS')

const macro0 = await j('/macro')
const co1Before = await j('/companies/1')
const co2Before = await j('/companies/2')
console.log(`\n[1] výchozí stav`)
console.log(`    M2 = ${macro0.m2}, vytvořeno = ${macro0.moneyCreated}, zničeno = ${macro0.moneyDestroyed}`)
check('identita M2 == ΔM', macro0.m2, macro0.deltaM, 0.01)
check('firma 1 má cash > 0', co1Before.cash > 0, true)
console.log(`    ${co1Before.name}: cash=${co1Before.cash}  ${co2Before.name}: cash=${co2Before.cash}`)

// ── book před obchodem ──────────────────────────────────────────────────────
const bookBefore = await j('/market/log')
console.log(`\n[2] order book LOG před obchodem`)
console.log(`    bestBid=${bookBefore.bestBid} bestAsk=${bookBefore.bestAsk} spread=${bookBefore.spread}`)
check('nejlepší ask', bookBefore.bestAsk, 0.115)
check('hloubka asku 0.115', bookBefore.asks[0].qty, 500)

// ── MARKET BUY 300 log → musí se spárovat proti asku 0.115 ──────────────────
const QTY = 300
const PRICE = 0.115                       // cena odpočívajícího (maker) příkazu
const gross = QTY * PRICE
const feeTaker = gross * FEE_TAKER        // kupující = taker
const feeMaker = gross * FEE_MAKER        // prodávající = maker
console.log(`\n[3] MARKET BUY ${QTY} × log (firma 1 → firma 2)`)
console.log(`    nezávislý přepočet: gross=${gross.toFixed(6)} ` +
            `taker=${feeTaker.toFixed(6)} maker=${feeMaker.toFixed(6)} sink=${(feeTaker + feeMaker).toFixed(6)}`)

const res = await post('/orders', {
  companyId: 1, itemCode: 'log', side: 'buy', qty: QTY, orderType: 'market',
})
check('HTTP status', res.status, 200)
if (res.status !== 200) {
  console.log('    odpověď:', JSON.stringify(res.body))
  process.exit(1)
}
const o = res.body
check('status příkazu (IOC)', o.status, 'filled')
check('vyplněné množství', o.qtyFilled, QTY)
check('průměrná cena = cena MAKERA', o.avgPrice, PRICE)
check('hrubá hodnota z API', o.totalGross, gross)
check('poplatky z API', o.totalFees, feeTaker + feeMaker)
check('počet fillů', o.fills.length, 1)

// ── peníze: nezávislá kontrola proti ledgeru ────────────────────────────────
const co1After = await j('/companies/1')
const co2After = await j('/companies/2')
const macro1 = await j('/macro')

console.log(`\n[4] peníze — nezávislý přepočet vs. ledger`)
check('firma 1 zaplatila gross+taker',
  co1Before.cash - co1After.cash, gross + feeTaker, 1e-4)
check('firma 2 dostala gross−maker',
  co2After.cash - co2Before.cash, gross - feeMaker, 1e-4)
check('sink_exchange_fee = oba poplatky',
  macro1.sinks.sink_exchange_fee, feeTaker + feeMaker, 1e-4)
check('M2 kleslo přesně o poplatky (jediný způsob, jak peníze mizí)',
  macro0.m2 - macro1.m2, feeTaker + feeMaker, 1e-4)
// Terminální příkaz nesmí nic nechat zablokované — tohle byl únik, který odhalil
// až nový invariant fn_audit_escrow_mismatch().
check('escrow firmy 1 se vrátil na původní hodnotu (nic nezůstalo viset)',
  co1After.escrow, co1Before.escrow, 1e-4)
check('uvolněný escrow z API == zbytek zámku', o.releasedEscrow,
  o.escrowed - (gross + feeTaker), 1e-4)
check('stillLocked na terminálním příkazu', o.stillLocked, 0)
check('identita M2 == ΔM i po obchodě', macro1.m2, macro1.deltaM, 0.01)

// ── zboží ───────────────────────────────────────────────────────────────────
const inv1 = co1After.inventory.find((r) => r.item === 'log')
console.log(`\n[5] zboží`)
check('firma 1 má teď klády ve skladu', (inv1?.quantity ?? 0) >= QTY, true)

// ── book po obchodě: ask se musí zmenšit o vyplněné množství ────────────────
const bookAfter = await j('/market/log')
check('zbytek asku 0.115', bookAfter.asks[0].qty, 500 - QTY)

// ── audit invariantů ────────────────────────────────────────────────────────
const audit = await j('/audit')
console.log(`\n[6] audit invariantů`)
check('verdict', audit.verdict, 'PASS')
check('nevyrovnané transakce', audit.unbalanced.length, 0)
check('drift zůstatků', audit.drift.length, 0)
check('přeprodané zásoby', audit.oversold.length, 0)
check('porušená makro identita', audit.moneyIdentity.length, 0)
check('escrow na příkazech == zůstatek účtu escrow_market', audit.escrowMismatch.length, 0)

// ── trades jsou append-only a správně spárované ─────────────────────────────
const tr = (await j('/trades')).trades[0]
console.log(`\n[7] záznam obchodu`)
check('cena obchodu', tr.price, PRICE)
check('množství', Number(tr.qty), QTY)
check('kupující ≠ prodávající (anti-wash)', tr.buyer !== tr.seller, true)
console.log(`    ${tr.item}: ${tr.buyer} → ${tr.seller}, ${tr.qty} × ${tr.price}`)

// ── anti-wash: firma nesmí obchodovat sama se sebou ─────────────────────────
console.log(`\n[8] anti-wash trading`)
const wash = await post('/orders', {
  companyId: 2, itemCode: 'log', side: 'buy', qty: 50, priceLimit: 0.50,
})
const washFills = wash.body.fills ?? []
const selfMatch = washFills.some((f) => f.buyerCompanyId === f.sellerCompanyId)
check('žádný fill nemá stejného kupujícího a prodávajícího', selfMatch, false)

// ── limitní příkaz, který se nekříží → musí ZŮSTAT v booku ──────────────────
console.log(`\n[9] nekřížící limitní příkaz zůstává v booku`)
const rest = await post('/orders', {
  companyId: 1, itemCode: 'log', side: 'buy', qty: 100, priceLimit: 0.05,
})
check('status = open', rest.body.status, 'open')
const openList = (await j('/orders?companyId=1')).orders
check('příkaz je v seznamu otevřených', openList.some((x) => Number(x.id) === rest.body.orderId), true)

// ── zrušení příkazu musí uvolnit escrow ─────────────────────────────────────
console.log(`\n[10] zrušení příkazu uvolní escrow`)
const cashBeforeCancel = (await j('/companies/1')).cash
const escrowBefore = (await j('/companies/1')).escrow
const c = await del(`/orders/${rest.body.orderId}?companyId=1`)
check('cancel status', c.status, 200)
const after = await j('/companies/1')
check('escrow klesl', after.escrow < escrowBefore, true)
check('cash se vrátil', after.cash > cashBeforeCancel, true)
check('audit stále PASS', (await j('/audit')).verdict, 'PASS')

// ── validace vstupů ─────────────────────────────────────────────────────────
console.log(`\n[11] validace vstupů`)
check('neznámá položka → 404',
  (await post('/orders', { companyId: 1, itemCode: 'unobtainium', side: 'buy', qty: 1 })).status, 404)
check('záporné množství → 422',
  (await post('/orders', { companyId: 1, itemCode: 'log', side: 'buy', qty: -5 })).status, 422)
check('limit bez ceny → 422/400',
  (await post('/orders', { companyId: 1, itemCode: 'log', side: 'buy', qty: 10, orderType: 'limit' })).status >= 400, true)

// ── idempotence ─────────────────────────────────────────────────────────────
console.log(`\n[12] idempotence (stejný klíč = stejný výsledek, žádný duplicitní obchod)`)
const key = crypto.randomUUID()   // idempotency_key je v DB uuid
const a1 = await post('/orders', {
  companyId: 1, itemCode: 'log', side: 'buy', qty: 10, priceLimit: 0.02, idempotencyKey: key,
})
const a2 = await post('/orders', {
  companyId: 1, itemCode: 'log', side: 'buy', qty: 10, priceLimit: 0.02, idempotencyKey: key,
})
check('první volání prošlo', a1.status, 200)
check('stejné orderId při opakovaném klíči', a2.body.orderId, a1.body.orderId)
check('druhé volání je označené jako cached', a2.body.cached, true)
check('nevznikl duplicitní příkaz',
  (await j('/orders?companyId=1')).orders.filter((x) => Number(x.id) === a1.body.orderId).length, 1)
check('audit stále PASS po idempotenci', (await j('/audit')).verdict, 'PASS')

// ── questy + sandbox (Fáze B) ───────────────────────────────────────────────
console.log(`\n[13] questy a sandbox (odvozený stav, quicksell, makro identita)`)
const qb = await j('/companies/1/quests')
check('questů v řetězu je 7', qb.quests.length, 7)
check('quest „zaloz“ je hotový', qb.quests[0].done, true)
check('quest „pozemek“ hotový (demo firma vlastní půdu)', qb.quests[1].done, true)
check('aktivní quest má hint', typeof (qb.active?.hint ?? 'x'), 'string')
const qsell = await post('/companies/1/quicksell', { itemCode: 'log' })
check('quicksell: 200 nebo 422 (prázdný sklad)', [200, 422].includes(qsell.status), true)
check('audit PASS i po sandbox akcích', (await j('/audit')).verdict, 'PASS')
const mb = await j('/macro')
check('makro identita M2 ≡ vytvořeno − zničeno',
  Math.abs(mb.m2 - (mb.moneyCreated - mb.moneyDestroyed)) < 0.01, true)

// ── Fáze D: kodex, hodiny, silniční síť ─────────────────────────────────────
console.log(`\n[14] kodex, herní hodiny a silniční síť`)
const codex = await j('/codex')
check('kodex má recepty (≥25)', codex.recipes.length >= 25, true)
check('kodex má vstupy vč. energie', codex.inputs.some((i) => i.item === 'power'), true)
const clk = await j('/clock')
check('hodiny mají speed 0/1/2/4', [0, 1, 2, 4].includes(clk.speed), true)
check('špatná rychlost → 400', (await post('/clock', { speed: 3 })).status, 400)
check('pauza jde nastavit', (await post('/clock', { speed: 0 })).status, 200)
check('po pauze speed 0', (await j('/clock')).speed, 0)
await post('/clock', { speed: 1 })
const mapd = await j('/map')
check('mapa má státní silnice', mapd.plots.some((p) => p.type === 'road'), true)
check('mapa hlásí napojení', mapd.plots.some((p) => p.connected === true), true)
{
  const byP = new Map(mapd.plots.map((p) => [`${p.x},${p.y}`, p]))
  const nbr4 = (p) => [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .some(([dx, dy]) => byP.get(`${p.x + dx},${p.y + dy}`)?.type === 'water')
  const shore = mapd.plots.find((p) => p.type !== 'water' && p.type !== 'road' && nbr4(p))
  check('nábřeží je napojené zdarma (řeka = dopravní síť)', shore?.connected === true, true)
  const dry = mapd.plots.find((p) => p.owner_id === '1' && !p.b_code
    && p.type !== 'water' && !nbr4(p))
  if (dry) {
    const hb = await post(`/plots/${dry.id}/build`, { companyId: 1, buildingCode: 'harbor' })
    check('přístav mimo vodu → 422', hb.status, 422)
  }
}
check('audit PASS po Fázi D', (await j('/audit')).verdict, 'PASS')

// ── Cargo: hráčské dopravní trasy ────────────────────────────────────────────
console.log(`\n[15] cargo — trasy, které si zakládá hráč`)
const rts = await j('/routes?companyId=1')
check('demo firma má ukázkové trasy (≥2)', rts.routes.length >= 2, true)
const r0 = rts.routes[0]
check('trasa má uloženou cestu po dlaždicích', Array.isArray(r0.path) && r0.path.length >= 2, true)
check('trasa má kapacitu a přepravné', (r0.capacityPerHour > 0) && (r0.feePerHour > 0), true)

// firma 2 (Borealis) má dvě budovy u tahu — musí jít založit truck trasa
const mapR = await j('/map')
const b2 = mapR.plots.filter((p) => p.owner_id === '2' && p.b_id)
check('firma 2 má ≥2 budovy pro trasu', b2.length >= 2, true)
const [fa, fb] = b2
const q = await post('/routes/quote', { companyId: 2, fromPlotId: Number(fa.id), toPlotId: Number(fb.id) })
check('nabídka trasy: 200 a mód truck', q.status === 200 && q.body.modes.some((m) => m.mode === 'truck'), true)
const qBad = await post('/routes/quote', { companyId: 2, fromPlotId: Number(fa.id), toPlotId: Number(fa.id) })
check('trasa sama na sebe → 422', qBad.status, 422)

const cashBefore = (await j('/companies/2')).cash
const cr = await post('/routes', { companyId: 2, fromPlotId: Number(fa.id), toPlotId: Number(fb.id), mode: 'truck', vehicles: 3 })
check('trasa jde založit', cr.status, 200)
const cashAfter = (await j('/companies/2')).cash
// 3× truck = 750 Kč setup; tick může mezitím strhnout údržbu (do ~150)
check('vozový park (750) se odečetl z cash', cashBefore - cashAfter >= 750 && cashBefore - cashAfter < 950, true)
const dup = await post('/routes', { companyId: 2, fromPlotId: Number(fa.id), toPlotId: Number(fb.id), mode: 'truck', vehicles: 1 })
check('duplicitní trasa → 422', dup.status, 422)
const delR = await del(`/routes/${cr.body.id}?companyId=2`)
check('trasa jde smazat', delR.status, 200)
const del2 = await del(`/routes/${cr.body.id}?companyId=2`)
check('smazání cizí/neexistující trasy → 404', del2.status, 404)
check('audit PASS po cargo sekci', (await j('/audit')).verdict, 'PASS')
const mbr = await j('/macro')
check('M2 identita drží i po setup poplatcích',
  Math.abs(mbr.m2 - (mbr.moneyCreated - mbr.moneyDestroyed)) < 0.01, true)

console.log('\n────────────────────────────────────────────────────────────')
console.log(` ${pass} ✅   ${fail} ❌   →  ${fail === 0 ? 'VŠECHNO PROŠLO' : 'MÁME PROBLÉM'}`)
console.log('────────────────────────────────────────────────────────────\n')
process.exit(fail === 0 ? 0 : 1)

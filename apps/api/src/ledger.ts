/**
 * Podvojný ledger.
 *
 * Každá operace = jeden `txn_id` a 2+ „legs", jejichž součet je NULA.
 * Invariant vynucuje `CONSTRAINT TRIGGER journal_assert_balanced DEFERRABLE
 * INITIALLY DEFERRED` — tedy až při COMMIT. Kontrola v aplikaci (`assertBalanced`)
 * je tu kvůli srozumitelné chybové hlášce; DB trigger je záchranná síť proti bugům.
 *
 * PENÍZE V JS: JS float je nepřesný, proto veškerá aritmetika (sčítání zůstatků,
 * price × qty, poplatky) probíhá v SQL nad `numeric(24,6)`. V JS hodnoty jen
 * předáváme a zaokrouhlujeme na 6 desetinných míst (`round6`) — nikdy je dál
 * nesčítáme. Viz docs/20-datovy-model.md §1.1.
 */
import { randomUUID } from 'node:crypto'
import type { Db } from './db.ts'
import { many, one } from './db.ts'

export type AccountKind =
  | 'cash' | 'escrow_market'
  | 'faucet_retail' | 'faucet_state' | 'faucet_starting_grant'
  | 'sink_exchange_fee' | 'sink_contract_tax' | 'sink_transport' | 'sink_storage_rent'
  | 'sink_plot_rent' | 'sink_property_tax' | 'sink_wages' | 'sink_upkeep'
  | 'sink_hq_overhead' | 'sink_capex' | 'sink_demolition' | 'sink_research'
  | 'sink_wealth_tax' | 'sink_auction_burn' | 'sink_loan_interest'
  | 'sink_land_purchase' | 'sink_utilities'

export type MoneyFlow = 'faucet' | 'sink' | 'transfer' | 'internal'

/** Odkud/kam peníze jdou. `company:<id>` nebo `system`. */
export type Party = { type: 'company'; id: number } | { type: 'system' }

export type Leg = {
  party: Party
  kind: AccountKind
  /** signed — klady zvyšují zůstatek účtu, záporny snižují */
  amount: number
  moneyFlow: MoneyFlow
  refType?: string
  refId?: number
  meta?: Record<string, unknown>
}

/** Zaokrouhlení na přesnost sloupce numeric(24,6). */
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

/**
 * post() MUSÍ běžet uvnitř explicitní transakce.
 *
 * `journal_assert_balanced` je DEFERRABLE CONSTRAINT TRIGGER — vyhodnocuje
 * Σ legs při COMMIT. V autocommitu je ale každý jednotlivý INSERT svou vlastní
 * transakcí, takže trigger vystřelí už po první noze a odmítne commit, i když
 * jsou obě strany operace správně spárované. Obalit obě nohy jednou transakcí
 * je celý smysl deferred triggeru.
 *
 * Diskriminátor: holá PGlite instance má isInTransaction(), Transaction objekt ne.
 */
function assertInTransaction(d: Db): void {
  const probe = (d as { isInTransaction?: () => boolean }).isInTransaction
  if (probe === undefined) return // Transaction objekt → jsme uvnitř transakce
  if (!probe.call(d)) {
    throw new Error(
      'post() musí běžet uvnitř transakce — obalte volání do tx(async (t) => …). ' +
      'V autocommitu je každý INSERT vlastní transakce a DEFERRED trigger ' +
      'journal_assert_balanced by odmítl commit už po první noze.',
    )
  }
}

/** Vyhledá (a pro systémové účty vytvoří) id účtu. */
export async function accountId(
  d: Db,
  worldId: number,
  party: Party,
  kind: AccountKind,
): Promise<number> {
  const ownerId = party.type === 'company' ? party.id : null
  const ownerType = party.type

  const found = await one<{ id: string }>(
    d,
    `SELECT id FROM accounts
      WHERE owner_type = $1
        AND owner_id IS NOT DISTINCT FROM $2
        AND world_id IS NOT DISTINCT FROM $3
        AND kind = $4
        AND currency = 'USD'`,
    [ownerType, ownerId, worldId, kind],
  )
  if (found) return Number(found.id)

  if (party.type === 'company') {
    // účty firmy vznikají triggerem při založení company — tohle je bug
    throw new Error(
      `účet company:${party.id}/${kind} neexistuje ve světě ${worldId} ` +
      `(trigger companies_create_accounts ho měl vytvořit)`,
    )
  }

  await d.query(
    `INSERT INTO accounts (owner_type, owner_id, world_id, kind, currency, balance)
     VALUES ('system', NULL, $1, $2, 'USD', 0)
     ON CONFLICT DO NOTHING`,
    [worldId, kind],
  )
  const created = await one<{ id: string }>(
    d,
    `SELECT id FROM accounts
      WHERE owner_type = 'system' AND owner_id IS NULL
        AND world_id IS NOT DISTINCT FROM $1 AND kind = $2 AND currency = 'USD'`,
    [worldId, kind],
  )
  if (!created) throw new Error(`nepodařilo se vytvořit systémový účet ${kind}`)
  return Number(created.id)
}

export type Posted = { txnId: string; legs: number; total: number }

/**
 * Zaúčtuje sadu legs jako jednu transakci.
 * Vyhodí, pokud součet není nula — dřív, než to odmítne DB při COMMIT.
 */
export async function post(
  d: Db,
  worldId: number,
  legs: Leg[],
  opts: { kind: string; txnId?: string } = { kind: 'adjustment' },
): Promise<Posted> {
  if (legs.length === 0) throw new Error('post() bez legs nemá smysl')
  assertInTransaction(d)

  const total = round6(legs.reduce((s, l) => s + l.amount, 0))
  if (total !== 0) {
    const detail = legs
      .map((l) => `  ${l.party.type}${l.party.type === 'company' ? ':' + l.party.id : ''}` +
                  `/${l.kind} ${l.amount >= 0 ? '+' : ''}${l.amount}`)
      .join('\n')
    throw new Error(
      `podvojný ledger není vyrovnaný: Σ = ${total} (musí být 0)\n${detail}\n` +
      `DB trigger by to odmítl při COMMIT — aplikace musí zapsat obě strany operace.`,
    )
  }

  const txnId = opts.txnId ?? randomUUID()

  for (const leg of legs) {
    const acct = await accountId(d, worldId, leg.party, leg.kind)
    await d.query(
      `INSERT INTO journal_entries
         (txn_id, world_id, account_id, amount, kind, money_flow, ref_type, ref_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        txnId, worldId, acct, round6(leg.amount), opts.kind, leg.moneyFlow,
        leg.refType ?? null, leg.refId ?? null, JSON.stringify(leg.meta ?? {}),
      ],
    )
  }
  return { txnId, legs: legs.length, total }
}

/** Stav účtu. numeric vrací driver jako string → převádíme na number až tady. */
export async function balance(
  d: Db,
  worldId: number,
  party: Party,
  kind: AccountKind,
): Promise<number> {
  const row = await one<{ b: string }>(
    d,
    `SELECT COALESCE(SUM(balance), 0)::float8::text AS b FROM accounts
      WHERE owner_type = $1
        AND owner_id IS NOT DISTINCT FROM $2
        AND world_id = $3
        AND kind = $4
        AND currency = 'USD'`,
    [party.type, party.type === 'company' ? party.id : null, worldId, kind],
  )
  return Number(row?.b ?? 0)
}

/** Makro pohled: M2, faucets, sinks — pro dashboard. */
export async function macroSnapshot(d: Db, worldId: number) {
  const rows = await many<{ kind: string; total: string }>(
    d,
    `SELECT kind, SUM(balance)::float8::text AS total
       FROM accounts
      WHERE world_id = $1 AND owner_type = 'system'
      GROUP BY kind ORDER BY kind`,
    [worldId],
  )
  const m2 = await one<{ m2: string }>(
    d,
    `SELECT COALESCE(SUM(balance),0)::float8::text AS m2 FROM accounts
      WHERE world_id = $1 AND owner_type = 'company'
        AND kind IN ('cash','escrow_market')`,
    [worldId],
  )
  const byKind: Record<string, number> = {}
  for (const r of rows) byKind[r.kind] = Number(r.total)

  const faucet = Object.entries(byKind)
    .filter(([k]) => k.startsWith('faucet_'))
    .reduce((s, [, v]) => s + v, 0)
  const sink = Object.entries(byKind)
    .filter(([k]) => k.startsWith('sink_'))
    .reduce((s, [, v]) => s + v, 0)

  // ZNAMÉNKOVÁ KONVENCE (důležité — ADR-009 na tom stojí):
  //   faucet účet jde do MÍNUSA, když se peníze vytvoří (je to zdroj)
  //   sink   účet jde do PLUSU,  když se peníze zničí   (je to odtok)
  // Proto vytvořené peníze = -faucet a zničené = +sink.
  const moneyCreated = round6(-faucet)
  const moneyDestroyed = round6(sink)

  return {
    m2: Number(m2?.m2 ?? 0),
    // surové zůstatky systémových účtů (pro transparentnost)
    faucetTotal: round6(faucet),
    sinkTotal: round6(sink),
    // odvozené toky v konvenci „kladné = peníze přibyly do ekonomiky“
    moneyCreated,
    moneyDestroyed,
    deltaM: round6(moneyCreated - moneyDestroyed),
    faucets: Object.fromEntries(Object.entries(byKind).filter(([k]) => k.startsWith('faucet_'))),
    sinks: Object.fromEntries(Object.entries(byKind).filter(([k]) => k.startsWith('sink_'))),
  }
}

/**
 * Noční audit — musí vrátit prázdná pole. Když ne, máš leak.
 * Viz docs/20-datovy-model.md §8.3.
 */
export async function audit(d: Db) {
  const unbalanced = await many<{ txn_id: string; leg_count: string; total: string }>(
    d, `SELECT * FROM fn_audit_unbalanced_txns(now() - interval '365 days')`,
  )
  const drift = await many<{ account_id: string; drift: string }>(
    d, `SELECT * FROM fn_audit_balance_drift()`,
  )
  const oversold = await many<{ inventory_item_id: string }>(
    d, `SELECT * FROM fn_audit_oversold_inventory()`,
  )
  // Únik peněz: escrow zablokovaný na příkazech musí přesně odpovídat účtu.
  const escrowMismatch = await many<{
    company_id: string; locked_on_orders: string; account_balance: string; diff: string
  }>(
    d, `SELECT * FROM fn_audit_escrow_mismatch()`,
  )

  // Čtvrtý invariant — makro identita. Každá koruna v držení firem musela projít
  // faucetem a dosud neprošla sinkem, takže musí platit přesně:
  //     M2 == peníze vytvořené − peníze zničené
  // Transfery mezi firmami M2 nemění. Pokud se to nerovná, někde peníze vznikly
  // nebo zmizely mimo ledger — tj. porušené první pravidlo ekonomiky (doc 10).
  // Porovnáváme v numeric, ne ve floatu, aby neprošlo zaokrouhlovací šumění.
  const moneyIdentity = await many<{
    world_id: string; m2: string; created: string; destroyed: string; delta_m: string
  }>(
    d,
    `WITH sys AS (
       SELECT world_id,
              -- kind je ENUM, LIKE umí jen text → explicitní cast
              COALESCE(SUM(balance) FILTER (WHERE kind::text LIKE 'faucet_%'), 0) AS faucet,
              COALESCE(SUM(balance) FILTER (WHERE kind::text LIKE 'sink_%'),   0) AS sink
         FROM accounts WHERE owner_type = 'system' GROUP BY world_id),
      co AS (
       SELECT world_id,
              COALESCE(SUM(balance), 0) AS m2
         FROM accounts
        WHERE owner_type = 'company' AND kind IN ('cash','escrow_market')
        GROUP BY world_id)
     SELECT w.id::text AS world_id,
            COALESCE(c.m2, 0)::text     AS m2,
            (-COALESCE(s.faucet, 0))::text AS created,
            COALESCE(s.sink, 0)::text   AS destroyed,
            (-COALESCE(s.faucet, 0) - COALESCE(s.sink, 0))::text AS delta_m
       FROM worlds w
       LEFT JOIN sys s ON s.world_id = w.id
       LEFT JOIN co  c ON c.world_id = w.id
      WHERE COALESCE(c.m2, 0) <> (-COALESCE(s.faucet, 0) - COALESCE(s.sink, 0))`,
  )

  return {
    ok: unbalanced.length === 0 && drift.length === 0 && oversold.length === 0
        && moneyIdentity.length === 0 && escrowMismatch.length === 0,
    unbalanced, drift, oversold, moneyIdentity, escrowMismatch,
  }
}

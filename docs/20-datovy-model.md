# 20 · Datový model

> **Fáze 2.** Kompletní DDL: [`db/migrations/0001_init.sql`](../db/migrations/0001_init.sql)
> — 122 statementů, validováno skutečným PostgreSQL parserem (`tools/db/validate_sql.py`).
>
> Navazuje na [`docs/00-vize-a-koncept.md`](00-vize-a-koncept.md) §4 a
> [`docs/10-ekonomika-core-loop.md`](10-ekonomika-core-loop.md).

---

## 1. Tři nezrušitelná pravidla

### 1.1 Peníze jsou `numeric(24,6)`. Nikdy `float`.

```sql
price  numeric(24,6)   -- ✅
price  double precision -- ❌ zakázáno, validátor na to hlásí varování
```

`0.1 + 0.2 = 0.30000000000000004` v IEEE 754. V ekonomice, kde se sčítají miliony
transakcí a kde invariant `SUM(legs) = 0` je hlavní debugging nástroj, je to
nepoužitelné. `numeric` je v Postgresu přesný a dost rychlý.

Rozsah `24,6` = 18 cifer před desetinnou čárkou, 6 za ní. To pokryje i pozdní hru
s miliardovými zůstatky a sub-centovými cenami (elektřina 0,05 $/kWh) zároveň.

Množství zboží jsou `numeric(20,4)`, ne `bigint` — rate-based výroba produkuje
zlomky jednotek mezi ticky a zaokrouhlování do `bigint` by systematicky vytvářelo
nevyrovnaný ledger.

### 1.2 Podvojný ledger, vynucený databází

Každý pohyb peněz = 2+ legs se součtem **nula**. Ne jeden sloupec `cash`, který se
inkrementuje.

```
Příklad: hráč A prodá 100 prken hráči B za 0,69 $/ks = 69 $, fee taker 2,5 %

txn_id = < jedno UUID pro celou operaci >
  A.cash            +67,2750     (69 − fee)
  A.escrow_goods    −100 ks      ← tohle NENÍ journal entry, ale inventory_items.reserved_qty
  B.cash            −69,0000
  B.escrow_market   +69,0000     (uvolnění zablokované hotovosti)
  system.sink_exchange_fee  +1,7250
  ────────────────────────────
  Σ = 0  ✅
```

Invariant je vynucen **CONSTRAINT TRIGGEREM `DEFERRABLE INITIALLY DEFERRED`** — kontrola
proběhne až při commitu, takže aplikace může legs vkládat v libovolném pořadí:

```sql
CREATE CONSTRAINT TRIGGER journal_assert_balanced
    AFTER INSERT ON journal_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_journal_assert_balanced();
```

Když součet nesedí, **transakce se odmítne commitnout**. To je nejlepší debugging
nástroj, jaký v ekonomické hře můžeš mít: s jedním sloupcem `cash` nikdy nezjistíš,
kde se peníze ztratily; tady to spadne okamžitě se zprávou, které `txn_id` je špatně.

`accounts.balance` se udržuje inkrementálně triggerem ve stejné transakci. CHECK
constraint `accounts_no_overdraft` (`owner_type = 'system' OR balance >= 0`) pak
znamená, že **přečerpání hotovosti abortne transakci na úrovni DB** — není možné
utratit peníze, které nemáš, ani kdyby aplikační logika měla bug.

### 1.3 `world_id` na všem, co je per-svět

ADR-003 rozhodl pro sezónní světy. I kdyby první rok běžel jen jeden, `world_id`
musí být v `companies`, `market_orders`, `trades`, `plots`, `accounts`,
`journal_entries`, `daily_snapshots` **od první migrace**.

Zpětná migrace na multi-world znamená: přidat sloupec do 12 tabulek, backfillnout
miliardy řádků `trades`, přepsat všechny unique indexy (jméno firmy je unikátní
*per svět*, ne globálně), přepsat každý dotaz. To je týdenní práce s reálným rizikem
ztráty dat. Teď je to jeden sloupec.

---

## 2. ERD

```
  users ──< companies >── worlds            industries
              │                                │
              │ 1:N                            │
              ├──< accounts >──┐               │
              │                │ 1:N           │
              │                └──< journal_entries   (txn_id seskupuje legs)
              │
              ├──< plots (owner) ──< buildings ──< production_orders
              │         │                │              │
              │         │                │              └── recipes ──< recipe_inputs >── items
              │         │                │
              │         │                └──< retail_stores ──< retail_listings >── items
              │         │
              │         └──< inventories ──< inventory_items >── items
              │
              ├──< market_orders ──< trades >── items
              │                        │
              │                        └── buyer/seller company
              ├──< plot_auctions ──< plot_bids
              ├──< events
              └──< retail_listings

  npc_quotes (world, item, tier)      daily_snapshots (world, date)
  market_flags (world, company)       audit_results (world)

  STATIC / SEED (neměnné za běhu světa):
    items · building_types · recipes · recipe_inputs · industries
```

**26 tabulek**, rozdělených do čtyř skupin:

| Skupina | Tabulky | Vlastnosti |
|---|---|---|
| **Static/seed** | `items`, `building_types`, `recipes`, `recipe_inputs`, `industries` | Načteno z `seed/balance-v0.2.json`. **Za běhu světa neměnné** — změna uprostřed sezóny rozbije order book i rozdělanou výrobu. |
| **Stav** | `worlds`, `users`, `companies`, `plots`, `buildings`, `inventories`, `inventory_items`, `production_orders`, `retail_stores`, `retail_listings` | Mutuje se, potřebuje transakce |
| **Burza** | `market_orders`, `trades`, `npc_quotes`, `market_flags`, `idempotency_keys` | `trades` je **append-only** |
| **Ledger + observabilita** | `accounts`, `journal_entries`, `events`, `daily_snapshots`, `audit_results` | `journal_entries` append-only |

---

## 3. Klíčové invarianty (všechny vynucené v DB, ne v aplikaci)

| Invariant | Jak | Proč nestačí aplikace |
|---|---|---|
| `Σ legs = 0` per `txn_id` | CONSTRAINT TRIGGER deferred | race condition při concurrent operacích |
| Firma nemůže přečerpat | `CHECK (owner_type='system' OR balance >= 0)` | bug v matching enginu by vytvořil peníze z ničeho |
| `reserved_qty <= quantity` | `CHECK` na `inventory_items` | přeprodání zásob v escrow |
| Wash trading | `CHECK (buyer_company_id IS DISTINCT FROM seller_company_id)` na `trades` | první vrstva anti-manipulace |
| Recept není sám sobě vstupem | BEFORE trigger (CHECK nesmí mít poddotaz) | cyklus v grafu = tisknutí zboží z ničeho |
| Údržba roste pomaleji než propustnost | `CHECK (level_upkeep_mult < level_throughput_mult)` na `building_types` | jinak jsou upgrady trest, viz doc 10 §3.2 |
| Retail cena > burzovní | `CHECK (retail_base > base_price)` na `items` | jinak by retail nedával smysl |
| Jedna budova = jedna výroba | partial UNIQUE index na `production_orders(building_id)` | duplicitní příkazy by double-spendovaly vstupy |
| Jeden primární sklad na firmu | partial UNIQUE index `WHERE is_primary` | |
| Mřížka pozemků | `UNIQUE (world_id, x, y)` | |
| `qty_filled <= qty` | `CHECK` | over-fill by tiskl zboží |
| Market order nemůže zůstat `open` | `CHECK` | IOC sémantika |

**Pravidlo:** cokoliv, co musí platit *vždy*, patří do DB. Aplikační validace je první
linie pro UX (hezká chybová hláška), DB constraint je záchranná síť proti bugům.
U ekonomické hry, kde jeden bug vytvoří peníze z ničeho, to není paranoia — je to nutnost.

---

## 4. Indexy: co je hot path a co ne

### 4.1 ★ Matching engine — nejteplejší dotaz ve hře

```sql
-- asks: nejnižší cena první, při shodě rozhoduje čas (price-time priority)
CREATE INDEX market_orders_asks_idx
    ON market_orders (world_id, item_id, quality_tier, price_limit ASC, created_at ASC)
    WHERE status IN ('open','partial') AND side = 'sell';

-- bids: nejvyšší cena první
CREATE INDEX market_orders_bids_idx
    ON market_orders (world_id, item_id, quality_tier, price_limit DESC, created_at ASC)
    WHERE status IN ('open','partial') AND side = 'buy';
```

**Proč partial:** `market_orders` bude mít miliardy historických řádků (filled/cancelled/
expired), ale order book obsahuje jen zlomek. Bez partial indexu by matching skenoval
mrtvá data. S ním je index přesně tak velký jako živý book.

**Proč dva indexy a ne jeden:** buy side potřebuje `price DESC`, sell side `price ASC`.
Jeden index s `side` v klíči by nedal správné řazení pro obě strany najednou.

**Dotaz enginu:**
```sql
SELECT id, company_id, price_limit, qty - qty_filled AS remaining
  FROM market_orders
 WHERE world_id = $1 AND item_id = $2 AND quality_tier = $3
   AND side = 'sell' AND status IN ('open','partial')
   AND price_limit <= $4          -- limitní cena příchozího buy orderu
 ORDER BY price_limit ASC, created_at ASC
 LIMIT 50
 FOR UPDATE SKIP LOCKED;          -- ★ viz 4.2
```

### 4.2 `FOR UPDATE SKIP LOCKED` — proč

Dva matcheři zpracovávající stejný book zároveň by mohly utratit tentýž ask dvakrát.
`FOR UPDATE` uzamkne řádky; `SKIP LOCKED` znamená, že druhý matcher je přeskočí místo
čekání — žádný deadlock, žádná serializace celého booku.

**Alternativa pro MVP** (jednodušší a dostatečná): matching přímo uvnitř jedné Postgres
transakce s `SERIALIZABLE` nebo s `SELECT … FOR UPDATE` na hlavu booku. Postgres to
serializuje za tebe. Stačí na stovky obchodů/s — řádově víc, než budeš na začátku
potřebovat. Extrahovat do dedikovaného workeru (jedno vlákno per shard komodit) až když
to profily ukážou.

### 4.3 Ostatní indexy a jejich účel

| Index | Dotaz, který obsluhuje |
|---|---|
| `trades_chart_idx (world, item, tier, executed_at DESC)` | candlestick graf + TWAP 30d |
| `inventory_items_item_idx (item_id, quality_tier)` | „kdo všechno má tohle zboží" (admin, analýza) |
| `retail_listings_item_idx … WHERE qty_available > 0` | retail simulace: agregace nabídky per item |
| `events_inbox_idx (company_id, created_at DESC) WHERE read_at IS NULL` | notifikační inbox — partial, aby nezahrnoval přečtené |
| `buildings_settle_idx (world_id, last_settled_at)` | tick engine: které budovy ještě nebyly settled |
| `production_orders_settle_idx` | totéž pro výrobu |
| `journal_world_flow_idx (world_id, money_flow, created_at DESC)` | makro dashboard: faucets vs sinks |
| `market_orders_expiry_idx … WHERE expires_at IS NOT NULL` | úklid expirovaných GTD orderů |
| `market_orders_idempotency_uniq (company_id, idempotency_key)` | deduplikace při výpadku sítě |

### 4.4 Co v indexu záměrně není

`market_orders(company_id, status)` obslouží „moje otevřené objednávky". Ale **není**
tam index na `(item_id, status)` bez `world_id` — všechny dotazy musí být scoped na svět,
jinak by po prvním resetu index obsahoval data ze všech sezón najednou.

---

## 5. Escrow: jak se zamykají zásoby a hotovost

Kritické pro správnost. **Při založení příkazu, ne při vyplnění.**

```
SELL limit order na 100 prken:
  inventory_items.reserved_qty += 100        (CHECK: reserved <= quantity)
  → dostupné = quantity − reserved

BUY limit order na 100 prken @ 0,69:
  accounts.balance(cash)       −= 69,00
  accounts.balance(escrow)     += 69,00      (journal: 2 legs, Σ = 0, transfer/internal)

Při vyplnění:
  prodávající: reserved_qty −= 100, quantity −= 100, cash += (69 − fee)
  kupující:    escrow −= 69, quantity += 100
  systém:      sink_exchange_fee += fee
  → jeden txn_id, Σ legs = 0, všechno nebo nic

Při zrušení:
  reserved_qty −= 100  /  escrow −= 69, cash += 69
```

Důvod, proč *při založení*: bez toho lze přeprodat. Hráč založí 10 sell orderů na
stejných 100 prken a všechny se vyplní — zboží vznikne z ničeho. CHECK constraint
`reserved_qty <= quantity` to odmítne na úrovni DB.

**Zásoby nejsou účet.** `inventory_items` je stavová tabulka, ne ledger. Důvod: zboží
se netvoří podvojně (vzniká jen těžbou, zaniká jen spotřebou — doc 00 §3.2), takže
klasické „debit/credit" na zboží by jen zdvojovalo stav. Ale **každý pohyb zboží má
odpovídající `journal_entries` záznam v penězích** a množství se loguje do `meta` jsonb,
takže je auditovatelné.

---

## 6. Tick engine a `last_settled_at`

```sql
buildings.last_settled_at          timestamptz NOT NULL DEFAULT now()
production_orders.last_settled_at  timestamptz NOT NULL DEFAULT now()
companies.last_settled_at          timestamptz NOT NULL DEFAULT now()
```

Tři úrovně, protože tick engine má tři fáze s různou granularitou:

| Fáze | Frekvence | Co dělá | Index |
|---|---|---|---|
| Výroba | 1 min | set-based UPDATE: spotřeba vstupů, produkce výstupů, kontrola skladu | `production_orders_settle_idx` |
| Provoz | 1 min | údržba, nájem, mzdy, HQ režie → journal entries | `buildings_settle_idx` |
| Retail | 5 min | simulace poptávky, fill rate, alokace, faucet | `retail_listings_item_idx` |
| Snapshot | 1× denně | `daily_snapshots`, CPI, Gini, audit invariantů | — |

**Proč `last_settled_at` per řádek a ne globální timestamp:** umožňuje dva režimy najednou.
Globální ticker (set-based UPDATE nad všemi budovami) je levný a stačí do ~200 000 řádků.
Kdyby přestal stačit, přepne se na lazy evaluation per firma — při loginu dopočítáš
`elapsed = now() − last_settled_at` a vyrobíš `floor(elapsed × rate)`. Schema to podporuje
bez migrace.

**Real-time tempo (ADR-002) neznamená 1s tick.** Server settle 1 min, klient interpoluje
progress bary lokálně na 60 fps. Detail: doc 10 §2.

---

## 7. Kvalita — v klíčích od první migrace (ADR-008)

`quality_tier smallint NOT NULL DEFAULT 1` je v:

- `inventory_items` — součást UNIQUE klíče
- `market_orders` — součást obou book indexů
- `trades` — součást chart indexu
- `npc_quotes` — součást UNIQUE klíče
- `retail_listings` — součást UNIQUE klíče

V MVP se produkuje jen tier 1 a UI kvalitu nezobrazuje. Ale **je v klíčích**. Zpětné
přidání do `inventory_items` + `market_orders` + `trades` je migrace přes miliony řádků
s přestavbou všech unique indexů a partial indexů — na živé databázi s probíhající sezónou.

Proč na tom záleží: bez kvality je každá komodita jediná cena a book degeneruje do závodu
ke dnu. S ní existuje 5 samostatných booků na komoditu a prostor pro specializaci.

---

## 8. Makro observabilita

### 8.1 `daily_snapshots` — jedna řádka na svět a den

Obsahuje všechno z doc 10 §8: M2, CPI, **reálný výstup Y** (Laspeyres při fixních
základních cenách), `cpi_drift_monthly` (= %ΔM2 − %ΔY, cílová metrika dle ADR-009),
velocity, Gini, podíl top-1 %, fill rate, podíl prázdných booků, bankroty, a rozpad
sinků/faucetů do `jsonb`.

### 8.2 Systémové účty jako akumulátory

```
account_kind: faucet_retail · faucet_state · faucet_starting_grant
              sink_exchange_fee · sink_plot_rent · sink_property_tax · sink_wages
              sink_upkeep · sink_hq_overhead · sink_capex · sink_research
              sink_wealth_tax · sink_auction_burn · sink_transport · …
```

Díky tomu je makro dashboard **jeden GROUP BY**:

```sql
SELECT kind, SUM(balance) FROM accounts
 WHERE world_id = $1 AND owner_type = 'system' GROUP BY kind;

-- a celková peněžní zásoba jednou funkcí:
SELECT * FROM fn_world_money_supply($1);   -- m2, faucet_total, sink_total
```

Nemusíš rekonstruovat toky z `journal_entries` — systémové účty *jsou* kumulativní
historie faucetů a sinků.

### 8.3 Noční audit — tři funkce, které musí vrátit 0 řádků

```sql
SELECT * FROM fn_audit_unbalanced_txns();      -- Σ legs ≠ 0  → leak
SELECT * FROM fn_audit_balance_drift();        -- accounts.balance ≠ Σ entries → drift
SELECT * FROM fn_audit_oversold_inventory();   -- reserved > quantity → přeprodáno
```

Výsledky se zapisují do `audit_results` s partial indexem na `WHERE NOT passed`, takže
admin dashboard „co je rozbité" je jeden dotaz.

---

## 9. Co v MVP záměrně chybí

| Chybí | Kdy | Proč teď ne |
|---|---|---|
| `research_*` tabulky | fáze 2 | ADR-010: aspirativní sinky jsou nutné, ale ne pro první hratelnou verzi |
| `workers` / `executives` | fáze 2 | mzdy jsou v MVP agregované (sink), ne per jednotku |
| `contracts` (OTC) | fáze 2 | |
| `bonds`, `shares`, `ipo` | fáze 3 | vlastní rizika, samostatný modul |
| `transport_shipments` | fáze 2 | MVP: doprava = okamžitá, cena podle manhattan vzdálenosti |
| `loans` | fáze 2 | |
| Více `inventories` na firmu | fáze 2 | schema připraveno (tabulka existuje), MVP používá jednu s `is_primary` |
| `levels` nad 5 | fáze 2 | `building_types.max_level` to povoluje, balance ne |
| Více měn | nikdy (zatím) | `accounts.currency char(3)` je připraveno |

**Pravidlo:** tabulka se přidá, když je potřeba. Sloupec v existující tabulce se přidá
*tehdy, když by zpětné přidání bylo drahé* — proto `quality_tier`, `world_id`, `currency`,
`inventories` jako samostatná entita. To jsou levné teď a pekelně drahé později.

---

## 10. Validace

```bash
pip install pglast
python3 tools/db/validate_sql.py db/migrations/0001_init.sql
```

Spouští SQL skutečným PostgreSQL parserem (pglast je binding na parser z Postgresu,
ne aproximace) a navíc hlásí známé pasti, které parser propustí, ale Postgres odmítne
za běhu: CHECK s poddotazem, `COMMENT ON CONSTRAINT TRIGGER`, float v peněžních
sloupcích, trailing comma.

Parser při psaní tohoto schématu odhalil `COMMENT ON CONSTRAINT TRIGGER` — taková
syntax v Postgresu neexistuje (správně je `COMMENT ON TRIGGER … ON <table>`). Další dvě
pasti jsem opravil preventivně, než na ně došlo: CHECK constraint s `NOT EXISTS`
poddotazem (Postgres v CHECK poddotazy zakazuje → nahrazeno BEFORE triggerem) a funkci
s `RETURNS TABLE`, která používala `SELECT … INTO` bez `RETURN QUERY` (→ OUT parametry).

⚠️ **Parser neověří sémantiku** — typy, FK na neexistující sloupce, duplicitní názvy.
To odhalí až `psql -f` na skutečné instanci. Validátor je první linie, ne náhrada.

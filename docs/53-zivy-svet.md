# 53 · Živý svět: NPC firmy, progrese, zakázky, finance

> Fáze F. Hráč řekl: „super prototyp — co přidat dál?“ a vybral si svět, který
> **žije i bez něj**: AI firmy, které skutečně vyrábějí, obchodují a expandují;
> úrovně a výzkum jako dlouhodobý cíl; státní zakázky jako řízený odbyt;
> a prezentační vrstvu D (výsledovka, půjčky, manažeři, upgrade budov,
> denní/noční cyklus, historie cen) **bez mobilní responsivity a zvuků**.
> Zůstáváme singleplayer — žádná registrace, žádná MMO vrstva.

## 1 · Princip: jedna ekonomika pro všechny

Nejdůležitější rozhodnutí Fáze F: **NPC nemají vlastní simulaci**. Každá
akce soupeře prochází stejným `placeOrder`, `buyPlot`, `buildBuilding`,
`upgradeBuilding` a `startResearch` jako akce hráče — stejné escrow, stejné
poplatky, stejné sinky/faucety, stejný anti-wash. Díky tomu:

- audit invarianty (Σ journal = 0, M2 ≡ ΔM, escrow) platí beze změny,
- order book je „živý“ doopravdy — NPC limitky v něm hráč vidí a může je lízat,
- žádná paralelní logika, která by se mohla s hlavní ekonomikou rozejít.

## 2 · Kdo je NPC (`npc.ts`)

Hráčskou firmu určuje `worlds.player_company_id` — nastaví ji endpoint
`POST /api/companies/:id/claim`, který klient volá při každém výběru firmy
(singleplayer bez auth: „přepnout se do firmy“ = claim). Všichni ostatní
jsou NPC a každý tick (ve stejné transakci jako výroba) dělají tři věci:

| akce | pravidlo |
|---|---|
| **prodává přebytky** | volné zásoby > 400 ks → limit sell 35 % přebytku za `mid × 0,985` (zaokrouhleno na tick_size, max 2 000 ks) |
| **nakupuje vstupy** | zásoba receptového vstupu < 6 h potřeby → limit buy na 12 h dopředu za `mid × 1,02`, max 15 % hotovosti; elektřinu neřeší (tariff) |
| **expanduje** | p = 5 % × cycles při cash > 9 000: upgrade budovy → nový pozemek u silnice + budova dle biomu → nejlevnější dostupný výzkum |

Ochrany: firma s ≥ 6 otevřenými příkazy další nedává (book nezahlcujeme),
každá akce je v try/catch na `MarketError` — NPC svět nesmí shodit tick.
Ceny čtou mid z booku → poslední obchod → base_price (`refPrices`).

Výsledek z živého běhu: Borealis prodala hráči klády a koupila od něj prkna,
Krupp postavil rafinerii a sklárnu, Panetteria solární elektrárnu — vše přes
běžné endpointy, s audit PASS po celou dobu.

## 3 · Progrese: XP a úrovně (`progression.ts`)

- Křivka: `xpForLevel(n) = 250·(n−1)·n` → L2 = 500, L5 = 5 000, L10 = 22 500.
- Zdroje XP (jen činnost, nikdy čekání): **+1 za každou vyrobenou dávku**,
  **+25 za dokončený výzkum**, **+15 až ~50 za splněnou zakázku**.
- Úroveň firmy je brána: upgrade budovy na úroveň N vyžaduje firmu úrovně N,
  výzkum T2 od úrovně 3 a T3 od úrovně 5, strop půjčky roste s úrovní.
- NPC sbírají XP stejně jako hráč — svět „roste“ souběžně.

### Výzkumný strom (10 uzlů, 3 tiery)

| tier | uzly | efekt |
|---|---|---|
| 1 (L1+) | Ostřejší pily / Vrtání do hloubky | výroba odvětví +10 % |
| 1 | Centrální dispečink | kapacita dopravy +25 % |
| 1 | Údržbářské čety | údržba −10 % |
| 2 (L3+) | Osevní postupy / Předehřívání vsázky | agri / metalurgie +10 % |
| 2 | Výměnné návěsy | doprava +50 % |
| 2 | Výlohy a merchandising | retail +8 % |
| 3 (L5+) | Automatizace linek | veškerá výroba +15 % |
| 3 | Prediktivní údržba | údržba −20 % |

Platba je okamžitá z cash → `sink_research` (journal `research`), běh trvá
herní hodiny (`done_hours` vs `sim_hours`), dokončení v ticku + 25 XP.
Řetězce: dřevo→agri, těžba→hutě, dispečink→návěsy→automatizace,
údržbáři→výlohy→prediktivka.

Efekty se do ticku aplikují přes `companyEffects()` — multiplikátory
`outputByIndustry`, `outputAll`, `upkeep`, `retail`, `transport` — a v
dopravě přes `capMult` v `haulCargo`. Obchodní ředitel snižuje burzovní
poplatky přímo v `match()` (cache na fill).

## 4 · Zakázky (`contracts.ts`)

Řízený odbyt vedle burzy — učí plánovat výrobu a dává cíl, když je book
mělký. Svět drží **~4 otevřené** (doplňují se v ticku), parametry:

- množství 100–800 ks (násobek min_lot), prémie **1,15–1,40×** nad referencí,
- termín **48–168 herních hodin**, odměna XP ≈ `15 + hodnota/800`.
- příjem (`take`) → splnění (`deliver`): zboží se odepíše **napříč sklady**
  firmy v jednom kroku (žádná rezervace mezi kontrolou a odběrem), platba
  z `faucet_state` journal kindem `state_purchase` — stejné faucet pravidla
  jako retail, takže makro identita drží.
- po termínu `expired` (i rozdělané) — bez penalizace, jen utečená příležitost.

## 5 · Finance (`finance.ts`)

| nástroj | pravidla | účetnictví |
|---|---|---|
| **Půjčky** | strop `5 000 × úroveň`, min 500, úrok 0,02 %/herní h z jistiny | výplata `faucet_state → cash` (`adjustment`), splátka zpět, úrok `cash → sink_loan_interest` (`loan_interest`) |
| **Manažeři** | 1 na roli (UNIQUE): výroba +10 % / logistika +15 % kapacity / obchod −8 % poplatků; nájem 150–300, mzda 2–4/h | nájem i mzdy `cash → sink_wages` (`wages`); bez peněz se mzdy přeskočí |
| **P&L** | cash nohy journalu od půlnoci UTC podle druhu, escrow interní toky se nezobrazují | čistě čtení — `revenue + costs = net` |
| **Historie cen** | každý tick (herní hodinu) upsert mid/last všech položek | `price_history (world,item,sim_hour)` UNIQUE |

## 6 · Stavby: upgrade a demolice (`game.ts`)

- `upgradeBuilding`: cena `base_capex × 0,6 × level` → `sink_capex`
  (`upgrade_capex`), budova jde do `construction` na 60 % původní doby
  výstavby × level. Brána: `max_level` typu + **úroveň firmy ≥ nová úroveň**.
- `demolishBuilding`: stát odkoupí `25 % × capex × level` (`faucet_state →
  cash`, `demolition`), smaže budovu i dopravní trasy dotýkající se pozemku;
  pozemek a jeho dvorec (inventář) zůstávají.
- Tick nově počítá s `level_throughput_mult` / `level_upkeep_mult` /
  `level_storage_mult` z `building_types` — úrovně budov skutečně působí.

## 7 · Kritická oprava: prodej napříč sklady

Od Fáze E má každá budova vlastní dvorec, ale `placeOrder` rezervoval sell
jen z **primárního** inventáře a fill odečítal množství ze **všech** řádků
firmy najednou (dvojí/trojí odečet + porušení CHECK `reserved ≥ 0`).
Rezervace, uvolnění i spotřeba fillu jsou teď greedy napříč inventáři
(`reserveGoods` / `consumeReservedGoods` / `unreserveGoods` v `market.ts`).
Bez téhle opravy by hráč nemohl prodat, co vyrobil — a NPC by neobchodovali.

## 8 · Prezentace (D bez mobilu a zvuků)

- **HUD**: úroveň ⭐ + XP bar; tlačítka 📋 Zakázky, 🔬 Výzkum, 💰 Finance.
- **Modaly**: `ResearchView` (strom po tierech, stavy karet, progress),
  `ContractsView` (volné/moje/obsazené, countdown, splnění),
  `FinanceView` (P&L tabulka, půjčky, manažeři).
- **Terminál**: sparkline historie ceny nad bookem (SVG polyline, ▲/▼),
  **tutoriál pro začátečníky** — 5 kroků nad skutečným UI (zvýraznění sekcí
  přes `data-tut`, stav v `localStorage`, tlačítko ✦ pro znovuotevření).
- **Inspektor**: u vlastní budovy ⬆ Upgrade (s cenou a důvodem zamčení)
  a 🧨 Zbourat (s odkupem).
- **Denní/noční cyklus**: `WorldMap` dostává `hourOfDay` z hodin; noc
  (21–4) tmavý tint 0,42, soumraky 19–21 a 4–6 lineární; kreslí se v
  screen-space poslední vrstvou.

## 9 · Tick — nové pořadí fází

```
1 výroba/údržba/retail (s efekty výzkumu, manažerů a úrovní budov)
2 cargo (kapacita × transport mult)
3 XP z výroby → sim_hours += cycles
4 researchTick (dokončení + XP) → contractsTick (expire + doplnění)
5 loansTick (úroky) → execsTick (mzdy) → recordPriceHistory
6 npcTick (prodeje, nákupy, expanze)
```

Vše v JEDNÉ transakci — svět je po každém ticku konzistentní a auditovatelný.

## 10 · Endpointy

```
POST   /api/companies/:id/claim          hráčova firma (NPC ji vynechává)
GET    /api/companies/:id/progression    XP, úroveň, stav stromu
POST   /api/companies/:id/research       {code} → start výzkumu
GET    /api/contracts?companyId=         otevřené + rozdělané zakázky
POST   /api/contracts/:id/take           {companyId}
POST   /api/contracts/:id/deliver        {companyId} → platba + XP
GET    /api/companies/:id/loans          přehled + kapacita
POST   /api/companies/:id/loans          {principal}
POST   /api/loans/:id/repay              {companyId}
GET    /api/companies/:id/executives     role + obsazení
POST   /api/companies/:id/executives     {role}
DELETE /api/companies/:id/executives/:role
GET    /api/companies/:id/pnl            výsledovka dne
GET    /api/market/:code/history?hours=  mid/last po herních hodinách
POST   /api/buildings/:id/upgrade        {companyId}
POST   /api/buildings/:id/demolish       {companyId}
```

`GET /api/companies` nově vrací `xp`, `level`, `is_player`;
`GET /api/companies/:id` navíc `isNpc`.

## 11 · Testy

Smoke sekce **[17]** (37 assertů, celkem **117/117**): claim, strom a jeho
brány, výzkum (cena přesně −400, double-start 422, locked 422, running),
zakázky (≥4 open, take/double-take/deliver bez zboží/isMine), půjčky
(strop L1, loan_limit, splacení na 0), manažeři (nájem/duplicita/propuštění),
P&L (řádek výzkumu, net = revenue + costs), historie, upgrade brána
(`level_required`), demolice (odkup > 0, budova zmizí), audit PASS a
M2 identita na konec. Živý běh: NPC expanze v logu (`🏗️ expanze …`),
obchody NPC ↔ hráč v pásce, noční tint po 19. herní hodině.

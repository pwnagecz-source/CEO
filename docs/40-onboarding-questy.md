# 40 · Onboarding, questy a produkční tick (Fáze B)

**Stav:** ✅ implementováno (API + web) · **Navazuje na:** [10-ekonomika-core-loop](10-ekonomika-core-loop.md), [00-vize](00-vize-a-koncept.md)

## 1 · Proč tahle fáze existuje

Vize říká: *„musí to být hra, ne školní pomůcka“* a *„uč se hraním, ne čtením
manuálu“*. Fáze A dodala shell (mapa, HUD, inspektor). Ale svět byl **statický**:
budova po postavění nic nedělala, hráč neměl co prodat a neměl důvod se vrátit
za pět minut. Fáze B přidává tři věci, které z shellu dělají smyčku:

1. **Produkční tick** — svět žije: budovy vyrábějí, platí údržby, prodejny prodávají.
2. **Questový řetěz** — učí herní smyčku krok po kroku, vždy jen jeden úkol naráz.
3. **Progresivní odemykání** — hluboká ekonomika (order book, limitky) je schovaná
   za jedno-klikovými akcemi a odemkne se, až ji hráč poprvé potřebuje.

## 2 · Produkční tick (`apps/api/src/tick.ts`)

Jednou za `TICK_MS` (výchozí **12 s = jedna herní hodina**, laditelné env) projde
tick všechny budovy světa v **jedné transakci** a udělá tři věci:

| krok | co se stane | peněžní tok |
|---|---|---|
| údržba | `cash −upkeep` | → `sink_upkeep` ( peníze zanikají ) |
| výroba | vstupy ze skladů firmy → výstup do skladu budovy | peníze se nehýbou |
| retail | sklad −zboží → `cash +tržba` | z `faucet_retail` ( peníze vznikají ) |

Stavové kódy budov jsou zároveň jazyk UI: `producing` (zelená tečka),
`starved` (chybí vstupy), `full` (sklad plný), `paused` (není na údržbu/energii),
`construction`, `idle`.

### 2.1 Elektřina a státní síť

Balance v0.2 dává **vstup `power` skoro každé budově** — energetika je záměrně
vzácný zdroj. Aby to nebyla zeď pro nového hráče (který elektrárnu ještě nemá),
tick dokoupí chybějící elektřinu ze **státní sítě za regulovaný tarif
= base_price × 1.15**:

- peníze se spálí (`sink_utilities`, journal kind `utilities_purchase`) →
  makro identita `M2 ≡ ΔM` drží i pod tickem,
- hráč s vlastní elektrárnou může energii prodávat levěji než je tarif →
  **motivace stavět energetiku a obchodovat**, přesně jak chce vize.

### 2.2 Kázeň

Tick nesmí vytvořit ani zničit peníze jinde než přes faucets/sinks. Kontrola je
end-to-end v `npm run smoke` (sekce 13): `M2 ≡ moneyCreated − moneyDestroyed`
a audit invarianty po každé sandbox akci.

## 3 · Questový řetěz (`apps/api/src/quests.ts`)

Questy **neukládáme do tabulky** — celý stav se odvozuje z faktů v DB (pozemky,
budovy, stav výroby, obchody, hotovost). Nic tedy nemůže „ztratit krok“ s realitou
světa a reset světa funguje stejně jako návrat po týdnu.

| # | kód | učí | odměna |
|---|---|---|---|
| 1 | `zaloz` | rozhodnout se pro obor | — |
| 2 | `pozemek` | půda je vzácný zdroj | — |
| 3 | `stavba` | budova musí sedět na terén | — |
| 4 | `vyroba` | tick světa, stavové tečky | — |
| 5 | `prodej` | cenu určuje trh, ne hra | **odemkne Terminál** |
| 6 | `expanze` | řetězce (surovina → polotovar → finál) | — |
| 7 | `magnat` | hotovost je kyslík | titul v HUD |

UI (`QuestRail`) ukazuje **jen aktivní quest** s progressem a konkrétním hintem
(„klikni na…“); zbytek řetězu je sbalený. To je progresivní disclosure v praxi:
hráč nikdy nevidí deset úkolů naráz.

## 4 · Jedno-klikové akce místo terminálu

| akce | co really dělá | kde je hluboká verze |
|---|---|---|
| `Koupit pozemek` | ledger: cash → `sink_land_purchase` | — |
| `Postavit` | ledger: cash → `sink_capex` | — |
| `⚡ Prodat` (sklad) | market **IOC sell** na celé volné množství (`quicksell`) | Terminál: limitky, hloubka booku |
| Terminál 🔒 | odemkne se questem `prodej` | expertní pohled |

`quicksell` volá **stejný `placeOrder`** jako terminál (escrow, poplatky,
anti-wash, idempotence) — žádná paralelní logika prodeje, jen jiná tloušťka skla.

## 5 · Endpoints

```
GET  /api/companies/:id/quests     → { quests[], active, terminalUnlocked }
POST /api/companies/:id/quicksell  → PlaceOrderResult (market sell, celé množství)
```

## 6 · Otevřené otázky (→ [99](99-otevrena-rozhodnuti.md))

- Tick je zatím „1 cyklus za tick“ bez front (`production_queue` je připraveno
  v DDL) — dlouhé výroby přijdou s produkčním tick enginem.
- Logistika mezi sklady firmy je zdarma (spotřeba napříč inventáři);
  transportní náklady (`sink_transport`) jsou v DDL připravené.
- Questy odměňují zatím jen odemykáním; peněžní odměny by potřebovaly
  vlastní journal kind, aby nezamíchaly makro identitu.

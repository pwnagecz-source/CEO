# CEO — Vize a koncept

> **Fáze 0 / Základní kámen.** Tento dokument definuje vizi, designové pilíře, ekonomický model,
> datovou architekturu a technologický směr. Jednotlivé moduly (výroba, trh, retail, ledger)
> rozpracujeme do implementačních specifikací v samostatných souborech `docs/10-*`, `docs/20-*` atd.
>
> Stav: **návrh k odsouhlasení** — viz `docs/99-otevrena-rozhodnuti.md`.

---

## 1. Vize

**CEO** je textově/UI orientovaný prohlížečový MMO ekonomický simulátor. Hráč zakládá firmu,
staví výrobní řetězce, obchoduje na burze řízené výhradně hráči a prodává finální zboží
simulovaným zákazníkům. Cílem není „dojít na konec hry", ale stát se nejvýznamnějším hráčem
živé ekonomiky.

**Co si bereme z inspirací:**

| Zdroj | Co přebíráme | Co vědomě zahazujeme |
|---|---|---|
| **Capital Rift** | Skutečný order book (CLOB) řízený hráči, „když nikdo neprodává dřevo, žádné dřevo není", live P&L per business per minute, banka s účty, logistika | 3D svět, reálná mapa OpenStreetMap, minihry vaření, chození po mapě |
| **Sim Companies** | Tick-based výroba s offline postupem, agregovaná simulace retail poptávky, systém odvětví, výzkum, dluhopisy | 24h čekání na první výrobu (jejich největší retenční problém), izometrická grafika |

**Designový důsledek:** *Burza je hra. Výroba je generátor obsahu. Sinky jsou vyvažovací ventil.*
Veškerá architektura musí vycházet z toho, že order book je jediný zdroj pravdy o cenách.

---

## 2. Designové pilíře

1. **Hráčská ekonomika je posvátná.** Neexistuje „oficiální cena". Každá koruna a každý kus zboží
   má svůj původ a svůj zánik, dohledatelný v ledgeru. Hra nikdy netiskne peníze ad hoc.
2. **Specializace se musí vyplácet víc než integrace.** Pokud si každý může postavit celý řetězec
   bez postihu, trh umře. Odvětvové bonusy + disekonomie rozsahu + doprava.
3. **Server je autoritativní, klient je hloupý.** Žádná herní logika na klientovi. Každá akce je
   validovaná, idempotentní a rate-limitovaná.
4. **Čísla, ne grafika.** Hloubka jde z tabulek, grafů a rozhodnutí — ne z assetů. To je výhoda:
   jeden člověk dokáže vyrobit obsah (recept, budova, item) za minuty, ne za dny.
5. **Ekonomika je měřitelná.** Denní makro dashboard (M2, CPI, rychlost oběhu, Gini, faucets/sinks)
   je součástí MVP, ne „až potom". Bez něj se vyvažuje naslepo.
6. **První zisk do 5 minut.** První výrobní cyklus trvá 2–5 minut, ne hodiny. Pacing křivka je
   explicitní designový artefakt (§3.4).

---

## 3. Herní mechaniky a ekonomika

### 3.1 Jádro ekonomické smyčky

Tři vnořené smyčky s různou periodou — každá musí dávat smysl sama o sobě:

```
┌─ MIKRO smyčka (2–15 min) ──────────────────────────────────────┐
│  zkontroluj trh → uprav objednávky → vyber hotovou výrobu      │
│  → naskladni vstupy → spusť další výrobní příkaz → mrkni na P&L│
└────────────────────────────────────────────────────────────────┘
          ↓ kumuluje se do
┌─ MAKRO smyčka (1–14 dní) ──────────────────────────────────────┐
│  akumuluj hotovost → investuj do kapacity (budovy/upgrady)     │
│  → odemkni vyšší maržové patro → expanduj do nového odvětví    │
└────────────────────────────────────────────────────────────────┘
          ↓ kumuluje se do
┌─ META smyčka (1–6 měsíců) ─────────────────────────────────────┐
│  staň se market makerem / vertikálně integruj / ovládni        │
│  komoditu / vyhrál sezónu → prestiž do dalšího světa           │
└────────────────────────────────────────────────────────────────┘
```

**Klíčové rozhodnutí v mikro smyčce** (tohle je to, co dělá hru hrou):
*„Vyplatí se mi ten vstup vyrobit, nebo koupit na burze?"* — a obráceně: *„Prodám výstup
do retailu, nebo na burzu?"* Pokud je na tuhle otázku vždy stejná odpověď, ekonomika je mrtvá.
Tomu slouží **dvě nezávislé odbytové cesty** s různou dynamikou:

| | Burza (CLOB) | Retail (NPC poptávka) |
|---|---|---|
| Prodejce získá | tržní cenu, okamžitě | vyšší cenu, ale pomalu a nejistě |
| Riziko | cenové (spreads, pády) | nesprodané zásoby, skladné |
| Kapacita | neomezená (pokud je poptávka) | omezená úrovní obchodu |
| Role v ekonomice | přerozděluje peníze mezi hráči | **jediný faucet peněz** |

### 3.2 Toky: faucety a sinks

Nejdůležitější část celého návrhu. **Základní věta ekonomiky hry:**

> *Zboží vzniká jen těžbou a zaniká jen spotřebou. Peníze vznikají jen prodejem do retailu
> (a státními zakázkami) a zanikají jen poplatky, daněmi, mzdami a údržbou.*
> *Všechno ostatní je přenos mezi hráči — a musí být v ledgeru vyrovnaný na nulu.*

```
                    ┌──────────── FAUCETS (vznik) ────────────┐
   ZBOŽÍ:           │ těžba: důl, farma, lesní tábor, vrtná   │
                    │ (jediný zdroj nových jednotek zboží)    │
   PENÍZE:          │ retail prodej NPC zákazníkům            │
                    │ státní zakázky / tendry                 │
                    └──────────────────────────────────────────┘
                                     │
                        transformace / přenos
                        (výroba, burza, kontrakty)
                        ── v ledgeru součet = 0 ──
                                     │
                    ┌──────────── SINKS (zánik) ──────────────┐
   ZBOŽÍ:           │ retail spotřeba NPC, výrobní vstupy,    │
                    │ kažení, opotřebení, demolice, scrap     │
   PENÍZE:          │ poplatky, daně, mzdy NPC, údržba,       │
                    │ úroky, výzkum, demolice, licence, aukce │
                    └──────────────────────────────────────────┘
```

**Rovnice, kterou budeme skutečně sledovat (denně):**

```
ΔM  = (retail_tržby + státní_zakázky) − (poplatky + daně + mzdy + údržba + úroky + výzkum + demolice)
M2  = Σ hotovost firem + Σ escrow na burze + Σ bankovní účty
CPI = vážený koš 8–12 finálních spotřebitelských zboží (váhy fixní od spuštění)

Cílové hodnoty:
  ΔM/M2      ≈ +2 až +4 % měsíčně        (řízená, mírná inflace)
  CPI drift  ≈ +1 až +3 % měsíčně
  rychlost oběhu (objem obchodů / M2) ≈ 0,3–0,8 / den
  Gini coefficient bohatství < 0,75      (nad tím = ekonomika umírá na oligarchii)
  podíl top-1 % na M2 < 35 %
```

Pokud `ΔM/M2` dlouhodobě přesáhne ~6 %, hra se rozpadá: staří hráči hromadí hotovost,
ceny aktiv letí nahoru, nový hráč nemá šanci. Viz §3.6.

### 3.3 Výroba, těžba a spotřeba

**Model: rate-based s diskrétními výrobními příkazy.** Budova má propustnost (jednotek/hod).
Hráč zakládá *Production Order* s cílovým množstvím; engine každým tickem (1 min) spotřebuje
vstupy a vyprodukuje výstup proporcionálně.

Proč tohle a ne okamžité crafting ani čistě kontinuální simulace:

- **Offline postup zadarmo** — při loginu dopočítáš `elapsed × rate`, žádný per-player job.
- **Levný výpočet** — set-based `UPDATE` nad tabulkou budov; 200k budov zvládne Postgres pod 1 s.
- **Přirozené napětí** — vstupy se spotřebovávají *ve stejném ticku*; když dojdou, výroba stojí.
  To vytváří reálný důvod mít zásoby, dodavatele a sklad.

**Recept (jádro datového modelu):**

```
recipe = {
  id:              'sawmill_planks_t1'
  building_type:   'sawmill'
  inputs:          [{ item: 'log',   qty: 10 }, { item: 'power', qty: 8 }]
  output:          {  item: 'planks', qty: 12 }
  units_per_hour:  12          // propustnost na úrovni 1
  quality_base:    35           // výchozí kvalita výstupu
  min_level:       1
}
```

**Úroveň budovy škáluje tři věci najednou** (to je hlavní progression osa):
`throughput × (1 + 0,25·(level−1))`, `storage × (1 + 0,30·(level−1))`, `upkeep × (1 + 0,35·(level−1))`.
Všimni si, že **údržba roste rychleji než propustnost** — to je záměrná disekonomie rozsahu
a zároveň sink, který škáluje s velikostí říše (§3.6).

**Kvalita zboží (0–100, seskupená do 5 tierů).** Každý kus zboží má kvalitu; ta je funkcí
`recipe.quality_base × building_level_bonus × worker_skill × research_bonus`. Důvod, proč to
zavést už v MVP alespoň schema-only: **kvalita segmentuje order book**. Bez ní je každá
komodita jediná cena a trh degeneruje do závodu ke dnu. S ní vzniká 5 samostatných booků
na komoditu a prostor pro specializaci („dělám jen prémiové prkna").

**Ilustrační startovní řetězec** (čísla jsou placeholder pro balance spreadsheet):

| # | Budova | Vstup | Výstup | /hod | Údržba | Jedn. náklad |
|---|---|---|---|---|---|---|
| 1 | Logging Camp | 5 Power | 20 Log | 20 | 4 $ | 0,225 $/log |
| 2 | Sawmill | 10 Log + 8 Power | 12 Planks | 12 | 3 $ | 0,504 $/prkno |
| 3 | Nail Press | 2 Ingot + 4 Power | 40 Nails | 40 | 3 $ | ~0,30 $/10 hřebíků |
| 4 | Furniture Factory | 6 Planks + 40 Nails + 10 Power | 2 Furniture | 2 | 6 $ | 5,61 $/kus |
| 5 | Store (retail) | Furniture | → zákazník | — | 8 $ | prodej ~12 $ (marže ~53 %) |

**Elektřina jako univerzální vstup.** Většina průmyslu potřebuje `power`. Je to záměrné:
energetika je odvětví s minimem vstupů a stabilní poptávkou → ideální první podnikání
pro nováčka a zároveň přirozený bottleneck pro celou ekonomiku. (Sim Companies to má stejně
a je to jeden z jejich nejlépe fungujících sektorů.)

**Sklad jako ventil — nejdůležitější mechanismus v celé hře.**
Výroba běží offline **dokud se nenaplní výstupní sklad**. Pak se zastaví.

Tohle jediné pravidlo řeší čtyři problémy najednou a nepotřebuje žádný umělý timer:
1. **Strop offline postupu** — hráč, který se přihlásí 1× denně, nepředběhne aktivního hráče.
2. **Money sink** — zvětšení skladu stojí peníze a místo.
3. **Rozhodnutí** — „upgradnu sklad, nebo se budu přihlašovat častěji, nebo nastavím
   automatický prodej na burzu?" → přirozeně vede k funkci *auto-sell order*.
4. **Ochrana trhu** — nikdo nemůže nekonečně hromadit a pak dumpovat.

### 3.4 Pacing křivka (retenční záchrana)

Explicitní cíl, ne náhoda. Recenze Sim Companies to pojmenovávají přesně: *„5 star gameplay,
1 star player retention — requiring you to wait upwards of 24 hours for production in your
first day of playing."* Nedělejme tu chybu.

| Fáze | Čas výrobního cyklu | Co hráč dělá | Cíl |
|---|---|---|---|
| 0–15 min | **2–5 min** | tutorial: postavit tábor → vyrobit dřevo → prodat na burze | **první zisk do 5 minut** |
| 15 min–2 h | 5–15 min | druhá budova, první retail prodej, první upgrade | naučit obě odbytové cesty |
| 2 h–1 den | 15–60 min | první mezivýrobek, první nákup vstupu od jiného hráče | závislost na trhu |
| 1–7 dní | 1–4 h | expanze kapacity, první limit order „přes noc" | plánování dopředu |
| 7+ dní | 4–12 h | výzkum, nové odvětví, market making | dlouhodobá strategie |

**Nikdy ne 24 h v prvním týdnu.** Maximální délka cyklu v pozdní hře: ~12 h (přes noc).

### 3.5 Globální trh hráčů — CLOB

**Struktura:** jeden order book na každou dvojici `(item_id, quality_tier)`. Ne na komoditu —
na komoditu × kvalitu. To je klíčové pro §3.3.

**Typy příkazů:**

| Typ | Chování | MVP? |
|---|---|---|
| `LIMIT` (GTC / s expirací) | čeká v booku na cenu | ✅ ano |
| `MARKET` (IOC) | okamžitě se vyhodí proti nejlepšímu booku | ✅ ano |
| `LIMIT-IMMEDIATE` (post-only / fill-or-kill) | varianty | ⏳ fáze 2 |
| `STOP-LOSS` | ochrana pozice | ⏳ fáze 3 |
| `CONTRACT` (OTC, privátní) | přímý obchod mezi dvěma firmami, bez burz. poplatku | ⏳ fáze 2 |

**Matching engine — pravidla:**
- **Price-time priority**: nejlepší cena vyhrává; při stejné ceně rozhoduje čas založení.
- **Deterministický**: stejná posloupnost příkazů = stejný výsledek. Nutné pro replay a testy.
- **Escrow při založení** (kritické pro správnost): u sell limitu se **okamžitě zarezervuje zboží**
  v inventáři, u buy limitu se **okamžitě zablokuje hotovost**. Nikdy nemůže dojít k přeprodání.
- **Settlement je atomický**: jedna DB transakce přesune zboží + hotovost + zapíše trade +
  zaúčtuje obě strany do ledgeru. Buď všechno, nebo nic.
- **Implementace pro MVP**: žádné samostatné procesy. Matching probíhá uvnitř Postgres transakce
  se `SELECT ... FOR UPDATE` na otevřené příkazy daného booku. Postgres to serializuje za tebe.
  To stačí na stovky obchodů/s — řádově víc, než budeš na začátku potřebovat. Extrahovat do
  dedikovaného workeru (jedno vlákno per shard komodit, příkazy z Redis streamu) až když to
  profily ukážou.
- **Idempotence**: klient posílá `Idempotency-Key` (UUID) s každým založením příkazu. Server si
  ho pamatuje 24 h. Zabraňuje duplicitním orderům při výpadku sítě / rychlém klikání.

**Parametry booku:**

```
tick_size      per item — např. 0,01 pod 10 $; 0,10 pod 100 $; 1,00 nad 100 $
min_lot        per item — např. 10 jednotek (brání spamu booku mikro-ordera)
max_order_qty  per item × společnost — např. 100 000 (brání corneringu)
fee_maker      0,5 %   (odměna za poskytování likvidity)
fee_taker      2,5 %   (trest za netrpělivost → hlubší booky)
fee_min        0,01 $  (aby mikro-obchody nebyly zadarmo)
price_band     ±25 % od předchozího close denně — circuit breaker
```

Maker/taker split místo jednotné 3% sazby (Sim Companies) je záměrný: **subvencuje trpělivost
a trestá netrpělivost**, což systematicky prohlubuje booky a snižuje spready. To je přesně ta
vlastnost, kterou chceš u hráči řízené burzy.

**Co posíláme klientovi:** **L2 data** (agregovaná hloubka po cenových hladinách) + poslední
obchody. Ne L3 (jednotlivé příkazy). A **ne každý trade zvlášť** — server slučuje aktualizace:
max 1 push per book per 250–500 ms, obsahující delta. Přesně tak to dělají reálné burzy
a je to největší úspora zátěže, jakou v tomhle systému uděláš.

**Cold start — NPC market maker („Státní sklad").**
Capital Rift si může dovolit „když nikdo neprodává dřevo, žádné dřevo není", protože má tisíce
hráčů. Ty na začátku nebudeš mít nikoho a nový hráč by nemohl vůbec začít. Řešení:

```
Pro každou komoditu existuje NPC market maker, který oboustranně quotuje kolem referenční ceny:
  bid  = ref_price × 0,85        ask  = ref_price × 1,15
  ref_price = TWAP(30 dní) skutečných hráčských obchodů, jinak seeded base_price

  Má OMEZENÝ inventář (např. 50 000 jednotek) a OMEZENOU rychlost doplňování
  (např. 2 % inventáře / den). Tj. chová se jako AMM s bounded inventory.

  Vypíná se per komodita, když hráčská likvidita překročí práh:
    ≥ 20 resting orders na obou stranách  A  ≥ 5 000 jednotek zobchodovaných / den
```

Tohle je elegantní: řeší cold start, je to řízený faucet i sink, je to cenový stabilizátor
a je to *dočasné* — postupně mizí a předává trh hráčům. V MVP **nutné**, ne volitelné.

**Anti-manipulace:**
- **Wash trading**: detekce self-matching (stejná společnost na obou stranách → reject),
  monitorování párů firem s anomálně vysokým vzájemným objemem.
- **Spoofing**: sledování cancel-rate per účet; nad prahem (např. >90 % zrušených a <1 %
  vyplněných za hodinu) → soft limit na rychlost zakládání.
- **Cornering**: `max_order_qty` + `max_open_orders` + position limit per komodita.
- **Pump & dump**: `price_band` circuit breaker + cooldown po překročení.
- Všechno server-side, logováno do `market_flags` pro ruční review.

### 3.6 Retail — simulace poptávky (jediný faucet)

Retail je místo, kde vznikají nové peníze. Musí být dostatečně velký, aby uživil celou
ekonomiku, ale ne tak velký, aby obešel burzu.

**Model (per item, per tick):**

```
D(item) = base_demand(item)
        × population_factor          // roste s počtem aktivních hráčů ve světě
        × seasonality(day, hodina)   // víkendový/večerní peak
        × (ref_price / avg_price)^ε  // ε = elasticita, 1,2–2,0 dle kategorie
        × quality_factor(avg_quality)
        × brand_factor               // ⏳ fáze 3

Alokace mezi hráče:
  share(player) ∝ offered_qty × attractiveness(price, quality, store_level)
  attractiveness = 1 / (1 + (price / weighted_avg_price − 1)^2 × k)   // penalizuje odchylnou cenu

Nesplněná poptávka → propadá (MVP), částečný backlog (fáze 2)
```

**Kapacita retailu je hlavní progression brána:**
`úroveň obchodu → počet polic → max SKU → max jednotek/hod → sklad obchodu`.
Hráč nemůže prodat nekonečno; musí stavět a upgradovat obchody. To je sink i pacing.

**Důležité:** retail má *zpoždění a nejistotu*. Burza je okamžitá za nižší cenu, retail je
pomalý za vyšší cenu. Tenhle trade-off je jádrem rozhodování (§3.1).

### 3.7 Inflace a hromadění peněz — money sinks v pěti vrstvách

Tohle je nejtěžší problém žánru a musí se řešit od prvního řádku kódu, ne dodatečně.
Princip: **sinky musí škálovat superlineárně s bohatstvím**, jinak velryby jen akumulují.

**Vrstva 1 — Frikční (malé, konstantní, všudypřítomné)**
- Burzovní poplatky maker/taker (§3.5)
- Daň z OTC kontraktů (nižší než burza, ale nenulová — jinak všichni utečou na OTC)
- Doprava per převod (i paušální)
- Skladné za zásoby nad limit

**Vrstva 2 — Provozní (škáluje s velikostí — tohle je ta důležitá)**
- **Údržba budov**: `base × level^1,15` per hodinu. Superlineární exponent je záměrný.
- **Mzdy NPC pracovníků**: **indexované na CPI**. Jak ekonomika roste a inflace stoupá,
  mzdy rostou automaticky → *samo-regulační sink*. Tohle je nejsilnější mechanismus v seznamu.
- **Daň z pozemku/nájmu**
- **Úroky z úvěru** (herní banka = čistý sink)

**Vrstva 3 — Aspirativní (neomezené, statusové)**
- **Výzkum** — obrovské peněžní spalování za permanentní % bonusy. Hlavní pozdní sink.
- **Kapitálové výdaje** — budovy tieru 4–5, expanze do nových odvětví
- **Prestiž / status** — úroveň HQ, pojmenované landmarky, tituly, vlastní logo v žebříčku
- **Sběratelské předměty** — limitované edice v aukci se **100% spálením** vyvolávací částky
- **Veřejné aukce / státní tendry** — týdenní aukce vzácných aktiv (exkluzivní důl, licence);
  **100 % vítězné částky se spálí**. Vynikající: sink + PvP napětí + sink je dobrovolný.

**Vrstva 4 — Strukturální (skutečná odpověď)**
- **Sezóny / světy.** 3–6měsíční sezóna s částečným přenosem (prestiž, kosmetika, „legacy"
  bonus do dalšího světa). Resetuje peněžní zásobu, udržuje trh likvidní a soutěžní, dává
  novým hráčům férový vstup. **Tohle je nejúčinnější anti-inflační nástroj, jaký existuje,
  a musí to být pilíř od dne 1** — i kdybychom první sezónu spustili až za rok, schema musí
  počítat s `world_id` od začátku. Dodatečné přidání multi-world je bolestivá migrace.
- **Demurrage / daň z bohatství**: malá periodická daň z hotovostních zůstatků nad prahem
  (např. 0,1 %/týden nad 10 M). Nebo totéž zabalené jako explicitní „globální inflace" —
  hra aplikuje drift cenové hladiny, což je demurrage na hotovost pod jiným názvem.
  *Designově nejčistší varianta:* prezentovat to jako inflaci, ne jako daň.
- **Kapex běhací pás**: top-tier aktiva vyžadují průběžné masivní investice do údržby.

**Vrstva 5 — PvP sinky**
- Pojištění proti sabotáži, náklady na právní spory/inspekce, poplatky za audity
- Bidding war o omezená veřejná aktiva (viz vrstva 3)

**Negativní zpětné vazby, které musí v ekonomice existovat** (jinak je nestabilní):

1. Elasticita retail cen → nadprodukce srazí ceny → producenti omezí výrobu ✅
2. Údržba škáluje s velikostí → velká říše má vysoké fixní náklady → zranitelná ✅
3. Limity skladu → nelze nekonečně hromadit ✅
4. Limity inventáře NPC MM → nelze nekonečně dumpovat na stát ✅
5. Mzdy indexované na CPI → náklady rostou s inflací ✅

**Pozitivní zpětné vazby, které musíme tlumit:**

1. *Bohatí bohatnou* (víc hotovosti → víc kapacity → víc hotovosti) → tlumí vrstvy 2, 4, 5
2. *Cornering trhu* → tlumí position limity, circuit breakery, státní tendry

---

## 4. Datový model (přehled — detail v modulu 2)

**Hlavní technické rozhodnutí: plné podvojné účetnictví.**
Každý pohyb peněz = 2+ legs, jejichž součet je **nula**. Ne jeden sloupec `cash` na firmě,
který se inkrementuje. Tohle je nejdůležitější technické rozhodnutí v celé hře a důvody jsou tři:

1. **Bugy jsou odhalitelné.** Invariant `SUM(amount) = 0 per txn_id` jde ověřit nočním auditem.
   S jedním sloupcem `cash` nikdy nezjistíš, kde se peníze ztratily.
2. **Makro dashboard zadarmo.** `M2 = SUM(balance) WHERE kind='cash'`. Sinks/faucets jsou
   prostě součty přes účty. Bez toho se vyvažuje naslepo.
3. **Escrow je přirozený.** Rezervovaná hotovost na burze = jiný účet téhož vlastníka.

**Typy: nikdy `float`.** Buď `numeric(24,6)`, nebo `bigint` v minor units (centech).
Doporučuji `numeric(24,6)` — v Postgresu je rychlý a eliminuje celou třídu zaokrouhlovacích bugů.

**Přehled entit:**

```
IDENTITA
  users              id, email, password_hash, created_at, last_seen_at, is_banned, settings jsonb
  worlds             id, code, name, season_no, starts_at, ends_at, status      ← od dne 1!
  companies          id, user_id, world_id, name, industry_id, created_at, prestige_level

STATIC / SEED DATA (versionovaná, neměnná za běhu)
  items              id, code, name, category, base_price, tick_size, min_lot, quality_tiers, stack_size
  recipes            id, code, building_type_id, output_item_id, output_qty, units_per_hour,
                     quality_base, min_level
  recipe_inputs      recipe_id, item_id, qty
  building_types     id, code, name, industry_id, base_cost, base_throughput, base_storage,
                     base_upkeep, max_level, build_time_sec
  industries         id, code, name, bonus_pct

DYNAMICKÝ STAV
  buildings          id, company_id, type_id, level, plot_id, status, completed_at,
                     storage_capacity, is_producing, last_ticked_at
  inventory          id, company_id, storage_id, item_id, quality_tier, quantity, reserved_quantity
                     UNIQUE(company_id, storage_id, item_id, quality_tier)
                     CHECK(reserved_quantity >= 0 AND reserved_quantity <= quantity)
  production_orders  id, building_id, recipe_id, target_qty, produced_qty, consumed jsonb,
                     status, started_at, eta_at, last_ticked_at
  retail_listings    id, company_id, store_id, item_id, quality_tier, price, qty_available,
                     qty_sold_total, updated_at

BURZA
  market_orders      id, world_id, company_id, item_id, quality_tier, side, order_type,
                     price, qty, qty_filled, status, idempotency_key, created_at, expires_at
                     partial index: (item_id, quality_tier, side, price) WHERE status='open'  ← HOT
  trades             id, world_id, item_id, quality_tier, price, qty, buy_order_id,
                     sell_order_id, buyer_company_id, seller_company_id,
                     fee_buyer, fee_seller, executed_at                                       ← append-only
  npc_quotes         id, item_id, quality_tier, bid_price, ask_price, inventory, restock_rate

ÚČETNICTVÍ
  accounts           id, owner_type, owner_id, kind, currency, balance
                     UNIQUE(owner_type, owner_id, kind, currency)
  journal_entries    id, txn_id uuid, kind, account_id, amount (signed), meta jsonb, created_at
                     INDEX(txn_id), INDEX(account_id, created_at)

ENGAGEMENT
  events             id, company_id, type, payload jsonb, read_at, created_at
  daily_snapshots    world_id, date, m2, cpi, velocity, gini, top1pct_share,
                     faucets jsonb, sinks jsonb                                              ← makro dashboard
```

**Klíčové detaily, které se snadno přehlédnou:**
- `inventory.reserved_quantity` odděleně od `quantity`; `available = quantity − reserved`.
  CHECK constraint vynucuje invariant na úrovni DB.
- `world_id` na všem, co je per-svět (companies, orders, trades) — i kdyby byl první rok jen
  jeden svět. Migrace zpětně je peklo.
- `trades` je **append-only** — zdroj pravdy pro grafy, TWAP, CPI, referenční ceny NPC MM.
- `market_orders.idempotency_key` s UNIQUE indexem per společnost.
- `buildings.last_ticked_at` per řádek → umožňuje lazy evaluation i globální ticker.

---

## 5. Technologický stack (doporučení)

**Hlavní doporučení: TypeScript end-to-end, modulární monolit, Postgres jako zdroj pravdy.**

| Vrstva | Doporučení | Proč |
|---|---|---|
| **DB** | **PostgreSQL 16/17** | Nediskutovatelné. ACID, `SELECT FOR UPDATE SKIP LOCKED`, `numeric`, partial indexy, CTE. Redis je cache, **ne** store of record. |
| **Backend** | **Node.js 22 + Fastify** | Rychlý, má magie, ideální pro jednoho člověka. (NestJS jen pokud chceš DI a striktní strukturu za cenu rychlosti vývoje.) |
| **DB layer** | **Drizzle ORM** | SQL-first, lehký, neztrácíš kontrolu nad dotazy, které matching engine nutně potřebuje. (Ne Prisma — příliš abstrahuje.) |
| **Cache / queue** | **Redis 7 + BullMQ** | (a) pub/sub market events, (b) repeatable jobs pro tick engine / retail sim / upkeep, (c) rate limiting, (d) cache horkých dat booku |
| **Frontend** | **React 19 + Vite + TanStack Query + Zustand** | TanStack Query = server-state cache s refetch/revalidate; Zustand = lehký client-state |
| **UI** | **shadcn/ui + Tailwind 4** | Text/UI hra = hlavně tabulky a formuláře. Vlastní komponenty, žádné runtime závislosti |
| **Tabulky / grafy** | **TanStack Table + ECharts** | TanStack Table pro order book, inventář, ledger. **ECharts ne Recharts** — má nativní candlestick + depth chart, což Recharts nemá |
| **Validace** | **Zod** | Jedno schéma = runtime validace + TS typy + OpenAPI. Sdílené mezi FE a BE přes monorepo |
| **Realtime** | **SSE** (viz níže) | |
| **Auth** | **Lucia / vlastní session cookies** | Ne Auth0/Clerk — u hry chceš kontrolu a žádný vendor lock |
| **Monorepo** | **pnpm workspaces + Turborepo** | `packages/shared` (Zod schémata + typy), `apps/api`, `apps/web` |
| **Hosting** | **Hetzner Cloud + Docker Compose + Caddy** | ~15 €/měs za vše. Alternativa: Fly.io / Railway pro nulovou ops zátěž |

### WebSockets vs SSE — skutečná odpověď

**Doporučení: začni se SSE. Ale navrhni event schéma jako WS-ready.**

Rozbor:

| | SSE | WebSocket |
|---|---|---|
| Směr | server → klient | obousměrně |
| Auto-reconnect | **vestavěný** | musíš implementovat |
| Resume po výpadku | **vestavěný (`Last-Event-ID`)** | musíš implementovat |
| Proxy / LB / HTTP infra | bezproblémové (obyčejný HTTP) | sticky sessions, upgrade handling, heartbeat, backpressure |
| Overhead per message | vyšší (HTTP hlavičky) | nižší |
| Binární protokol | ne (bez base64) | ano |

**Rozhodující argument:** v téhle hře klient **čte** tržní data vysokou frekvencí, ale **zapisuje**
výhradně diskrétními uživatelskými akcemi (založit příkaz, zrušit příkaz, postavit budovu).
Ty zápisky patří do REST — kvůli validaci, idempotenci, rate limiting, audit logu a jasné
error sémantice. Takže obousměrnost WebSocketu reálně nepotřebuješ.

SSE ti dá 90 % hodnoty za 20 % složitosti. A u sólo vývojáře je „o 20 % méně infrastrukturního
kódu" rozdíl mezi hotovou a nedokončenou hrou.

**Kdy přejít na WS:** při >2 000 concurrent uživatelů nebo potřebě sub-100 ms latence booku.

**Aby byl přechod triviální, udělej tři věci teď:**
1. **Abstrakce `MarketEventBus`** — transport je plug-in. `SseTransport implements MarketEventBus`.
2. **Delta schéma, ne snapshoty.** Posílej `{item, tier, side, price, qty_delta}`, ne celý book.
   Klient si drží lokální stav a aplikuje delty. Přesně tenhle formát pak přejde na WS beze změny.
3. **Coalescing na serveru** — max 1 push per book per 250–500 ms (§3.5).

### Architektura

```
                    ┌──────────────────────────────────────┐
   Browser ──HTTPS──│  Caddy / reverse proxy               │
        │           └───────┬────────────────────┬─────────┘
        │ REST (mutace)     │                    │ SSE (market data)
        ▼                   ▼                    ▼
   ┌─────────────────────────────────────────────────────┐
   │  Node.js — MODULÁRNÍ MONOLIT                        │
   │                                                     │
   │  api/       REST routes + Zod validace + auth       │
   │  domain/    economy, market, production, retail     │  ← čisté, bez I/O
   │  infra/     postgres (Drizzle), redis, bus, jobs    │
   │  workers/   tick engine, retail sim, upkeep,        │
   │             npc-mm rebalance, snapshots, audit      │
   └───────────────┬──────────────────────┬──────────────┘
                   │                      │
                   ▼                      ▼
           ┌───────────────┐      ┌──────────────┐
           │ PostgreSQL 17 │      │  Redis 7     │
           │ zdroj pravdy  │      │ cache, queue,│
           │ ACID, ledger  │      │ pub/sub      │
           └───────────────┘      └──────────────┘
```

**Tick engine:** BullMQ repeatable job každou 1 min. Set-based SQL `UPDATE` nad budovami
(spotřeba vstupů, produkce výstupů), pak retail simulace, pak údržba/mzdy, pak snapshot.
10 000 firem × 20 budov = 200 000 řádků → Postgres zvládne pod 1 s. Kdyby to přestalo stačit,
fallback je lazy evaluation per firma s `last_ticked_at` (schema už s tím počítá).

**Ekonomický simulátor (tooling, ne hra):** offline skript, který spawnuje N fake hráčů
s jednoduchými strategiemi (náhodný producent, arbiter, market maker) a spustí 1 000 ticků.
Bez tohohle budeš vyvažovat ekonomiku na živých hráčích — a to je nejdražší způsob, jaký existuje.
Postgres + stejný domain kód, jen jiný entrypoint. ~200 řádků, obrovská hodnota. **Do MVP.**

---

## 6. MVP

### Musí být (hratelný ekonomický slice)

**P0 — bez toho hra není hrou**
1. Auth (email + heslo), založení firmy, výběr odvětví
2. Obsah: **~16 itemů / 3 patra, ~10 budov, ~15 receptů** (viz §3.3 tabulka)
3. **Výrobní příkazy** — rate-based progress, spotřeba vstupů, limity skladu
4. **Inventář** s rezervacemi
5. **Stavba a upgrade budov** — čas + cena + kapacita
6. **CLOB burza** — limit + market orders, matching, maker/taker fee, escrow, historie obchodů,
   hloubka (L2), idempotence, price band
7. **NPC market maker** — cold start (§3.5)
8. **Retail** — listování zboží, simulace NPC poptávky, jediný faucet
9. **Podvojný ledger + P&L + rozvaha** (§4)
10. **Tick engine** — výroba, údržba, retail, mzdy (BullMQ)
11. **SSE market updates** — delta formát, coalescing

**P1 — bez toho se nedá vyvažovat a provozovat**
12. **Makro dashboard** (interní, admin) — M2, CPI, faucets/sinks, velocity, Gini
13. **Ekonomický simulátor** (offline skript, §5)
14. **Notifikace / inbox** — výroba hotová, order vyplněn, sklad plný
15. **Základní anti-cheat** — rate limit, server-authoritative, idempotency, audit log
16. **Denní snapshoty + noční audit invariantů** (`SUM(amount)=0 per txn_id`)
17. **Onboarding / tutorial** — první zisk do 5 minut (§3.4)

### Odložit

| Funkce | Fáze | Poznámka |
|---|---|---|
| Výzkum / tech tree | 2 | hlavní pozdní sink — schema připravit teď |
| Pracovníci / executives | 2 | mzdy jako sink už v MVP (zjednodušeně, bez jednotek) |
| OTC kontrakty | 2 | přímé obchody mezi hráči |
| Stop-loss / pokročilé ordery | 3 | |
| Dluhopisy, akcie, IPO | 3 | velký modul, vlastní rizika |
| Doprava / logistika / vzdálenost | 3 | viz otevřené rozhodnutí č. 1 |
| Kvalita jako gameplay feature | 2 | **sloupec v DB už v MVP**, produkce jen tier 1 |
| Značky / brand / marketing | 3 | vstup do retail modelu — placeholder už v MVP |
| Chat, DM, přátelé, korporace/gildy | 3 | |
| Achievements, kosmetika | 3 | |
| Sezóny / multi-world | 2 (kód) | **`world_id` v DB od MVP** — migrace zpětně je peklo |
| Sabotáž / PvP / audit / pojištění | 3 | |
| Mobilní aplikace / PWA offline | 3 | PWA shell ale ano (je zadarmo) |
| Státní zakázky / tendry | 2 | druhý faucet + silný sink |
| Banka: úvěry, spoření, úroky | 2 | sink i faucet |
| Reálná mapa / pozemky | viz rozhodnutí č. 1 | |

### Pravidlo monetizace (doporučení)

**F2P, nikdy pay-to-win.** Reálné peníze nesmí přímo injectovat herní měnu — jinak se celá
ekonomika (§3.2) stane nefunkční a ztratíš důvěru hráčů. Povolené: kosmetika, QoL (více slotů
pro příkazy, rychlejší notifikace), předplatné s **neekonomickými** bonusy. Sim Companies
funguje 10+ let čistě na tomhle a jejich recenze to explicitně chválí (*„it has never been
pay to win"*). Detaily monetizace navrhneme ve fázi 3 — teď stačí závazek pravidla.

---

## 7. Co následuje

Postup rozpracování modulů (každý = samostatný dokument + implementace):

| # | Dokument | Obsah |
|---|---|---|
| 01 | `docs/10-ekonomika-core-loop.md` | balance spreadsheet, konkrétní čísla, faucets/sinks v $ |
| 02 | `docs/20-datovy-model.md` | kompletní DDL, indexy, constrainty, migrace |
| 03 | `docs/30-matching-engine.md` | CLOB specifikace, pseudokód, race conditions, testy |
| 04 | `docs/40-tick-engine.md` | výroba, retail simulace, údržba, lazy eval |
| 05 | `docs/50-realtime.md` | SSE/WS, event schéma, coalescing, reconnect |
| 06 | `docs/60-mvp-sprint-plan.md` | rozpad na 2týdenní sprinty s akceptačními kritérii |
| 07 | `docs/70-ekonomicky-simulator.md` | offline balance testing |

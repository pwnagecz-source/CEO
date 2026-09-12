# 10 · Ekonomika a core loop — rozpracovaný modul

> **Fáze 1.** Navazuje na [`docs/00-vize-a-koncept.md`](00-vize-a-koncept.md).
> Číselná část je **generovaná**, ne ručně psaná:
> [`docs/generated/balance-v0.2.md`](generated/balance-v0.2.md) ← `tools/balance/generate_v0.py`

---

## 1. Uzamčená rozhodnutí a jejich důsledky

| ADR | Rozhodnutí | Co to mění |
|---|---|---|
| **001** | **Omezená mřížka pozemků** (288 pozemků/svět, 24×12) | Nová ekonomická vrstva: půda jako vzácný zdroj, dražby, nájem, daň z nemovitosti, adjacency. Viz §4. |
| **002** | **Real-time / aktivní sezení** | Mění architekturu ticku (§2), **obrací doporučení SSE → WebSocket** (§7), zrychluje pacing křivku. |
| **003** | **Sezónní světy 3–6 měs. + prestige** | `world_id` v DB od MVP. Model v §6 ukazuje, že tohle **není kosmetika ale nosný anti-inflační mechanismus**. |
| **004** | **TypeScript / Node + React** | Potvrzuje doporučení z `docs/00` §5 beze změny. |

---

## 2. Real-time: „real-time" je vlastnost UX, ne simulace

Tohle je nejdůležitější architektonický důsledek ADR-002 a zároveň nejčastější chyba.

**Nedělej globální tick každou sekundu.** Při 2 000 firmách × 25 budovách = 50 000 řádků
na update každou sekundu to je 4,3 M zápisů/den do tabulky, kterou nikdo nečte — protože
99 % hráčů právě není online.

Místo toho:

```
SERVER  settle každou 1 min (BullMQ repeatable job)
        → set-based UPDATE nad buildings/production_orders
        → authoritative stav: quantity, last_settled_at

KLIENT  zná rate a last_settled_at
        → interpoluje progress bar lokálně na 60 fps
        → žádný request na server pro animaci
```

Hráč vidí plynule ubíhající progress bar v reálném čase. Server platí jednu set-based
UPDATE za minutu. **Výsledek je k nerozeznání od 1s ticku a stojí 60× míň.**

Kde real-time *skutečně* musí být doopravdy:

| Subsystem | Latence | Proč |
|---|---|---|
| **Order book** | < 500 ms | hráč na to kouká a obchoduje proti tomu; tohle JE hra |
| Trade confirmation | < 200 ms | odezva na klik musí být okamžitá |
| Progress bary výroby | klient, 60 fps | interpolace, server 1 min |
| Inventář / P&L | 1 min (settle) | nikdo nepotřebuje sub-sekundovou přesnost |
| Notifikace | push při settle | |

**Důsledek pro design:** real-time tempo neznamená „všechno je rychlé". Znamená to
„**burza je živá a výroba má krátké první cykly**". Rozdíl mezi real-time a async hrou
je v tom, *kde* je napětí — a u nás je v order booku, ne v čekání na výrobu.

### 2.1 Pacing křivka (revidovaná pro real-time)

| Fáze | Délka cyklu | Co hráč dělá | Cíl |
|---|---|---|---|
| 0–5 min | **90 s** (tutorial batch) | postavit tábor → vyrobit → prodat na burze | **první zisk do 5 minut** |
| 5 min–1 h | 2–5 min | druhá budova, první limit order | naučit obě odbytové cesty |
| 1–3 h (sezení) | sklad se plní ~1,5 h | aktivní obchodování, 2–3 výrobní cykly | jádro real-time zážitku |
| offline | výroba běží do plného skladu | — | strop bez timeru |
| den 2+ | 1,5–2 h plnění skladu | plánování, expanze, upgrady | strategie |
| pozdní hra | 4–8 h cykly u tier-3 | market making, výzkum | dlouhodobá hra |

Všimni si: **doba plnění skladu je u všech budov ~1,5–1,8 h** (viz generovaná tabulka §2).
To je záměrné — rytmus vracení se ke hře se s progresem nemění, roste jen *počet* věcí,
které sleduješ.

---

## 3. Ceny: odvozené zdola nahoru, ne hádané

Největší chyba, kterou lze v ekonomické hře udělat, je ručně napsat ceník. Položky pak mají
nekonzistentní marže, některé řetězce jsou ztrátové, a hráči to najdou za den.

**Postup v `tools/balance/generate_v0.py`:**

```
1. ukotví se jedna cena (power = 0,05 $/kWh)
2. pro každou budovu v pořadí závislostí (fixpoint iterace):
     inputs_cost = Σ qty_i × price_i
     net         = inputs_cost / [ (1−m)/m − k·P ]        m = cílová marže, P = návratnost, k = 0,015
     capex       = net · P
     upkeep      = k · capex
     revenue     = (inputs_cost + upkeep) / (1−m)
     price_out   = revenue / q_out
3. retail_base = exchange_mid / 0,70
```

Výsledek: **25 položek, 25 budov, všechny marže přesně podle politiky, žádný ztrátový
řetězec.** Retuning = změna `m` / `payback` / `q_out` a jeden rerun. Nic se nepřepočítává ručně.

Kompletní ceník a tabulka budov: [`docs/generated/balance-v0.2.md`](generated/balance-v0.2.md) §1–§2.

### 3.1 Maržová politika

| Tier | Cílová hrubá marže | Návratnost | Důvod |
|---|---|---|---|
| 0 · extrakce + energie | 55–70 % | 18–55 h | nejtučnější, ale gated vzácnými pozemky s deposit |
| 1 · zpracování | 38–42 % | 30–38 h | hubené, závislé na cizích vstupech → **nuttí obchodovat** |
| 2 · komponenty | 30–34 % | 48–66 h | |
| 3 · spotřební (na burzu) | 24–28 % | 44–108 h | |
| 3 · spotřební (do retailu) | +43 % k mid | — | `retail_base = mid / 0,70` |

**Pravidlo, které drží specializaci:** marže klesá s tierem. Kdyby byla plochá, každý by
si integroval celý řetězec a trh by umřel. Klesající marže + vzácné depositní pozemky
+ rostoucí návratnost = specializace se vyplácí.

### 3.2 Škálování úrovní — a kde je háček

```
propustnost  × (1 + 0,30·(L−1))
údržba       × (1 + 0,22·(L−1))   ← roste POMALEJI
sklad        × (1 + 0,35·(L−1))
upgrade L→L+1 = 0,75 · capex_L1 · 1,85^(L−1)
```

Protože údržba roste pomaleji než propustnost, **jednotkové náklady s úrovní klesají** —
výroba má ekonomiku z rozsahu. To je záměrné a musí to tak být, jinak by upgrady byly trest.

**Diseconomie rozsahu je z toho důvodu vytažená VEN z výroby do korporátní režie:**

```
hq_overhead($/h) = HQ_K · N_budov^1,45     (kalibrováno automaticky z vypočtených marží)
```

Trestá se velikost *říše*, ne efektivní výroba. Poměr režie k hrubému zisku roste jako
N^0,45: ~10 % při 5 budovách, ~30 % při 50, ~50 % při 200.

---

## 4. Pozemky — nová ekonomická vrstva (ADR-001)

288 pozemků na svět (mřížka 24×12), sedm typů. **Revize Fáze 4B:** výchozí svět je
800 pozemků (40×20, `WORLD_W`/`WORLD_H`); poměry níže platí jako zlomky plochy.

| Typ | Počet | Nájem $/h | Co umožňuje |
|---|---:|---:|---|
| `forest` | 40 | 8 | Logging Camp — **jinak nefunguje** |
| `mine` | 30 | 8 | Iron Mine, Quarry, Oil Rig |
| `water` | 18 | 8 | Grain Farm, Cotton Farm |
| `utility` | 20 | 6 | Power Plant |
| `industrial` | 100 | 5 | všechny továrny |
| `commercial` | 60 | 10 | obchody, lahůdky (bonus foot traffic) |
| `civic` | 20 | 0 | rezervováno — HQ, landmarky, aukce |

### 4.1 Proč jsou depositní pozemky klíčové

Extrakce má marži 55–70 %, tedy je to nejvýnosnější činnost ve hře. Kdyby byla dostupná
kdekoliv, všichni by těžili a zpracování by nikdo nedělal. **Deposit je to, co ji limituje:**
jen 88 z 288 pozemků (31 %) umožňuje těžbu, a jen 18 (6 %) farmaření.

Z toho plyne celá vrstva hry, kterou by jinak bylo potřeba vymýšlet zvlášť:
- **Dražby na začátku sezóny** — největší jednorázový sink a okamžitě vytvoří sociální hierarchii
- **Sekundární trh s půdou** — hráči si pozemky prodávají a pronajímají (transfer + daň = sink)
- **Spekulace** — koupit `commercial` pozemek vedle plánovaného retail klastru
- **Vzácnost jako pacing** — nemůžeš expanovat nekonečně, i když máš peníze

### 4.2 Adjacency (levná hloubka)

| Pravidlo | Efekt |
|---|---|
| Budova na odpovídajícím depositu | +25 % propustnosti (jinde nelze postavit vůbec) |
| Zpracování sousedí se svým dodavatelem vstupu | −15 % nákladů na dopravu |
| `commercial` s vysokou hustotou sousedů | +10 % retail poptávky (foot traffic) |
| Těžký průmysl sousedí s `commercial` | −5 % retail poptávky (externalita) |

Implementačně: tabulka `plots(x, y)` + dotaz na 8 sousedů. Žádný renderer, žádná mapa —
jen tabulka a barevné odlišení typů. To je celý důvod, proč je varianta B levná.

### 4.3 Doprava (MVP zjednodušení)

```
MVP:    okamžitý přesun, cost = 0,002 $ × manhattan_vzdálenost × množství
Fáze 2: transit time (1 min na 3 políčka), kapacita vozidel
Fáze 3: vlastní logistická síť, sklady na více pozemcích
```

Manhattan vzdálenost na mřížce je jeden `ABS()` výraz. Žádné pathfinding.

---

## 5. Retail — simulace poptávky

Retail je **jeden ze dvou faucetů** a v pozdní hře ten dominantní.

```
poptávka_po_kompletním_zboží(den) = NPC_populace × útrata_na_obyvatele

fill_rate = min(1, poptávka / Σ světová retail kapacita)

faucet_firmy = její_retail_kapacita × fill_rate × retail_base
```

**Klíčová vlastnost: faucet je demand-constrained, ne capacity-constrained.**
Firma neutrhne to, co vyrobí, ale to, co jí dovolí prodat poptávka. Když světová kapacita
převýší poptávku, `fill_rate < 1`:

- zboží zůstává neprodané a **propadá** → goods sink
- tržby klesají → marže komprimované konkurencí
- hráči musí buď zlevnit, nebo snížit kapacitu, nebo zvýšit kvalitu

To je negativní zpětná vazba, která drží ekonomiku stabilní. Přesně tak funguje retail
simulace v Sim Companies („retail parameters of all players are combined to simulate
how fast the goods sold").

**Alokace mezi hráče** (když je `fill_rate < 1`, kdo prodá?):

```
share(firma) ∝ nabízené_množství × attractivita(cena, kvalita, úroveň_obchodu)
attractivita = 1 / (1 + (cena / vážený_průměr − 1)² × k)     # trestá odchylnou cenu
```

Kapacita retailu je hlavní progression brána: `úroveň obchodu → počet polic → max SKU →
max jednotek/hod`.

---

## 6. Inflace — odpověď na otázku, která zabíjí tenhle žánr

**Model ukázal, že odpověď není „přidat víc sinků".** Sweep 972 kombinací
(`tools/balance/tune.py`) nenašel stabilní střed, jen dva režimy:

| disposal (kolik zisku hráči utratí) | CPI/měs | Přeživších firem | M2 | Bohatství |
|---|---:|---:|---:|---:|
| 0,70 | **+141 %** | 2 359 (všechny) | 2 595 M | 44× startu |
| 0,97 | **+1,5 %** | 679 (72 % mrtvých) | 10 M | 0,6× startu |

**CPI stabilitu lze dosáhnout pouze zabitím ekonomiky.** Detail a diagnóza:
[`docs/generated/balance-v0.2.md`](generated/balance-v0.2.md) §7.2.

### 6.1 První oprava: správná cílová metrika

Původní cíl `ΔM/M2 = 2–4 %/měsíc` **byl chybný**. Z kvantitativní rovnice `M·V = P·Y`:

```
CPI drift (%/měsíc)  =  růst M2 (%/měsíc)  −  růst reálného výstupu Y (%/měsíc)
```

Rostoucí herní ekonomika vyrábí víc zboží. Když se svět rozroste z 12 na 2 359 firem,
Y roste desítkami procent měsíčně a M2 *musí* růst podobně rychle, jen aby cenová hladina
stála. Cílit přímo růst M2 by trestalo zdravý růst. **Správný cíl je CPI drift 1–4 %/měsíc.**

### 6.2 Čtyři závazné důsledky pro návrh

**1. Anti-inflační zátěž musí nést NOMINÁLNÍ sinky.**
Capex a výzkum jsou vázané na zisk (`capex = max(0, profit) × disposal`) — vypadnou přesně
ve chvíli, kdy by měly tlumit. Páteř musí být nájem, režie, daně a **mzdy indexované na CPI**
(jediný sink, který roste automaticky s inflací).

**2. Režie HQ nesmí být čistě fixní.**
Čistě fixní režie při poklesu cen způsobí bankrotovou kaskádu. Návrh:
```
hq = 0,60 × fixní složka (HQ_K · N^1,45)  +  0,40 × hrubá marže
```
Fixní část tvorí tlak, plovoucí část brání kaskádě.

**3. Vstupy se musí kupovat na burze, ne za tabulkové ceny.**
Tohle je nejhlubší důsledek a je to argument **PRO** hluboký CLOB a **PROTI** jakémukoli
NPC výkupu za fixní cenu v pozdní hře. Když cena padá, musí padat nominální tržby
*i nominální náklady na vstupy* současně — jen tak marže přežijí pokles cenové hladiny.
NPC market maker (§3.5 v doc 00) se musí vypínat, jakmile to jde.

**4. Sezónní reset je nosný mechanismus, ne volitelná kosmetika.**
Uvnitř jedné sezóny, kde hráčská báze roste 200×, nelze držet CPI v pásmu laděním sinků.
Reset peněžní zásoby je to, co inflaci řeší strukturálně. ADR-003 = B je tedy potvrzeno
*modelovým důkazem*, ne jen intuicí.

### 6.3 Pětivrstvý systém sinků (konkrétní čísla)

Vrstvy z `docs/00` §3.7, teď s vyčíslením z generovaného modelu (pozdní fáze, 60 budov, $/den):

| Sink | $/den | Typ | Škáluje s |
|---|---:|---|---|
| Capex (budovy + upgrady) | ~150 000 | profit-linked ⚠️ | ziskem |
| Korporátní režie HQ | 108 000 | **nominální** ✅ | N^1,45 |
| Nájem z pozemků | 2 880 | **nominální** ✅ | počtem pozemků |
| Mzdy (indexované na CPI) | ~1 500 | **nominální** ✅ | počtem a úrovní budov |
| Burzovní poplatky | ~1 200 | frikční ✅ | obratem |
| Daň z retail tržeb (5 %) | ~7 000 | na faucetu ✅ | retail objemem |
| Daň z nemovitosti (0,3 %/týden) | ~90 | **nominální** ✅ | hodnotou půdy |
| Daň z bohatství (0,3 %/týden nad 500 k) | backstop | **nominální** ✅ | nahromaděnou hotovostí |

⚠️ = vypadne při poklesu zisku. ✅ = drží i v recesi. **Páteř musí být ty se ✅.**

### 6.4 Co chybí a musí přijít ve fázi 2

Model ukázal, že chybí **neomezené aspirativní sinky** — věci, které mohou pohltit
libovolné množství hotovosti:

- **Výzkum** — nekonečný strom, rostoucí cena, permanentní bonusy
- **Státní tendry** — týdenní aukce vzácných aktiv, **100 % vítězné částky se spálí**
- **Sběratelské aukce** — limitované edice, 100 % burn
- **Úrovně budov 6–10** — exponenciální capex za sublineární užitek
- **Prestiž / status** — HQ úrovně, landmarky, tituly

Bez nich platí: *„když není co koupit, hotovost se hromadí a influje."* Model to ukazuje
přímo — disposal 0,70 (není co koupit) dává +141 % CPI, disposal 0,97 (vždy je co koupit)
dává +1,5 %.

---

## 7. Real-time obrací doporučení transportu: SSE → WebSocket

V `docs/00` §5 jsem doporučil SSE. **ADR-002 = A (real-time) ten vstup mění**, takže
doporučení obracím. Transparentně, včetně toho, co se změnilo:

| Vstup | Async tempo | Real-time tempo |
|---|---|---|
| Concurrent users v peaku | ~50–200 (rozloženě přes den) | **~1 000–3 000** (všichni večer najednou) |
| Frekvence změn sledovaných booků | nízká, hráč kouká 1× za čas | **vysoká, hráč aktivně obchoduje** |
| Subscription churn | malý | **velký** — hráč přepíná mezi komoditami každou chvíli |
| Latence zápisu (place/cancel order) | nekritická | **kritická, je to gameplay** |
| Stavy server | nemusí být | **už je** (tick engine, BullMQ) |

Poslední řádek je rozhodující: hlavní námitka proti WS (sticky sessions, stateful LB)
**odpadá**, protože stateful Node proces s tick enginem stejně musíš mít.

**Rozhodnutí: WebSocket jako primární transport, SSE jako fallback** pro klienty za
proxy, která WS blokuje. Implementačně:

```ts
interface MarketEventBus {
  publish(evt: BookDelta): void
  subscribe(client: ClientId, books: BookKey[]): void
  unsubscribe(client: ClientId, books: BookKey[]): void
}
class WsTransport  implements MarketEventBus { /* primární */ }
class SseTransport implements MarketEventBus { /* fallback */ }
```

**Tři věci, které musí být stejně u obou transportů** (aby byl přechod bezbolestný):

1. **Delta protokol, ne snapshoty.** `{item, tier, side, price, qtyDelta}`. Klient drží
   lokální stav booku a aplikuje delty.
2. **Coalescing na serveru.** Max 1 push per book per 250 ms. Bez toho: 2 000 klientů ×
   10 booků × 4 Hz = 80 000 msg/s. S coalescingem a deduplikací ~5 000 msg/s.
3. **Explicitní subscriptions.** Klient odebírá jen booky, na které se dívá (max ~10).
   Žádný broadcast všeho všem — to je největší úspora zátěže v celém systému.

---

## 8. Co měřit od prvního dne

Tabulka `daily_snapshots` (per svět, per den). Bez ní se vyvažuje naslepo — a model výše
ukázal, že intuice selhává i u tak základní věci, jako je správná cílová metrika.

| Metrika | Výpočet | Alarm |
|---|---|---|
| **M2** | `SUM(balance) WHERE kind='cash'` + escrow | — |
| **CPI** | vážený koš 8–12 finálních zboží, fixní váhy | drift > 4 %/měs |
| **Reálný výstup Y** | Σ množství × fixní základní ceny (Laspeyres) | — |
| **CPI drift** | `%ΔM2 − %ΔY` (30d klouzavě) | **> 4 % nebo < 1 %** |
| Faucets / sinks | součty přes `journal_entries` dle `kind` | poměr mimo 0,9–1,1 |
| Rychlost oběhu | denní objem obchodů / M2 | < 0,2 nebo > 1,5 |
| **Gini bohatství** | z `companies` cash + aktiva | **> 0,75** |
| Podíl top-1 % na M2 | | **> 35 %** |
| Fill rate retail | prodáno / nabízeno | < 0,4 (přebytek) nebo = 1,0 dlouhodobě |
| Prázdné booky | % komodit s < 5 resting orders | > 30 % |
| Bankroty / den | počet firem s cash = 0 | rostoucí trend |

**Noční audit job** (musí být v MVP): `SELECT txn_id FROM journal_entries GROUP BY txn_id
HAVING SUM(amount) <> 0` → musí vrátit 0 řádků. Když ne, máš leak a musíš ho najít,
než ho najdou hráči.

---

## 9. Sezónní ekonomika (ADR-003)

| Parametr | Hodnota | Poznámka |
|---|---|---|
| Délka sezóny | **120 dní** | 3–6 měs; kratší = častější reset, delší = víc času na oligarchii |
| Co přechází | Legacy Points, jméno firmy, kosmetika, archiv | **NE** hotovost, budovy, inventář, objednávky |
| Legacy Points | z konečného umístění + achievementů | utravitelné na začátku další sezóny |
| Za LP jde koupit | +10–40 % startovního kapitálu, 1 volný bid na pozemek, odemčený recept tieru, kosmetické HQ, executive | **nikdy** přímá hotovost nad rámec bonusu |
| Konec sezóny | „Velký audit" — finální žebříčky, přiznání LP, archiv světa | archiv je veřejný → lore + retenční hák |
| Start sezóny | **72h dražba pozemků** → všichni začínají se stejnou šancí na půdu | největší jednorázový sink sezóny |

**Proč dražba pozemků na začátku:** řeší dva problémy najednou. Jednak je to masivní sink,
jednak to je *férový* mechanismus alokace vzácného zdroje — nováček s dobrým odhadem
porazí veterána, který jen převedl LP. A protože na začátku sezóny mají všichni málo
hotovosti, aukční ceny jsou přirozeně nízké; sink roste s týdenními tendry zbylých pozemků.

**Archivace:** řádky se nemažou, jen se označí `world_id` a `season_status='archived'`.
Historie světů je zadarmo a je to obsah (žebříčky všech sezón, vývoj cen, slavné firmy).

---

## 10. Co z toho plyne pro implementaci

| Priorita | Úkol | Odkaz |
|---|---|---|
| P0 | Načíst `seed/balance-v0.2.json` do DB při startu světa | generátor už JSON produkuje |
| P0 | `daily_snapshots` + makro dashboard (admin) | §8 |
| P0 | Noční audit invariantů ledgeru | §8 |
| P0 | `plots` + deposit typy + adjacency dotaz | §4 |
| P0 | Retail fill-rate simulace v tick engine | §5 |
| P1 | HQ režie 60/40 fixní/plovoucí | §6.2 |
| P1 | Mzdy indexované na CPI | §6.3 |
| P1 | Dražba pozemků na startu sezóny | §9 |
| P2 | Agent-based simulátor s endogenní tvorbou cen | doc 70 |
| P2 | Neomezené aspirativní sinky (výzkum, tendry, aukce) | §6.4 |

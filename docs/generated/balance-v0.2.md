# Balance v0.2 — generováno automaticky

> ⚠️ **Generuje `tools/balance/generate_v0.py`. NEUPRAVOVAT RUČNĚ.**
> Retuning: změň `m` / `payback` / `q_out` ve skriptu a spusť znovu.
> `python3 tools/balance/generate_v0.py`

Konstanty: údržba = 1.5% capex/h · burzovní mid = 70% retail základu · max úroveň 5

## 1. Ceník položek

| Položka | Tier | Burzovní mid | Retail základ | Zdroj |
|---|---|---:|---:|---|
| `cotton` | 0 | 0.0833 $ | — | Bavlněná farma |
| `crude_oil` | 0 | 0.1046 $ | — | Ropná věž |
| `grain` | 0 | 0.0492 $ | — | Obilná farma |
| `iron_ore` | 0 | 0.2416 $ | — | Železný důl |
| `log` | 0 | 0.1111 $ | — | Dřevařský tábor |
| `power` | 0 | 0.0500 $ | — | Solární elektrárna |
| `stone` | 0 | 0.0986 $ | — | Kamenolom |
| `cement` | 1 | 0.4350 $ | — | Cementárna |
| `fabric` | 1 | 1.0340 $ | — | Textilka |
| `flour` | 1 | 0.1933 $ | — | Mlýn |
| `glass` | 1 | 0.9540 $ | — | Sklárna |
| `iron_ingot` | 1 | 1.4543 $ | — | Huť |
| `planks` | 1 | 0.3006 $ | — | Pila |
| `plastic` | 1 | 0.6838 $ | — | Rafinerie |
| `circuit` | 2 | 1.7084 $ | — | Elektronická linka |
| `nails` | 2 | 0.1275 $ | — | Lis na hřebíky |
| `steel_sheet` | 2 | 11.7675 $ | — | Ocelárna |
| `wire` | 2 | 0.1561 $ | — | Tažírna drátů |
| `appliance` | 3 | 140.5838 $ | 200.83 $ | Továrna na spotřebiče |
| `bread` | 3 | 0.0961 $ | 0.14 $ | Pekárna |
| `clothing` | 3 | 2.8127 $ | 4.02 $ | Oděvní továrna |
| `furniture` | 3 | 4.9576 $ | 7.08 $ | Továrna na nábytek |
| `machine_part` | 3 | 28.3152 $ | — | Strojírna |
| `sandwich` | 3 | 0.1824 $ | 0.26 $ | Lahůdky |
| `tools` | 3 | 14.8587 $ | 21.23 $ | Nástrojárna |

## 2. Budovy a recepty (úroveň 1)

| Budova | Pozemek | Vstupy /h | Výstup /h | Sklad | Plnění | Capex | Údržba | Návrat. | Jedn. náklad | Cena | Marže |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| **Bavlněná farma** `cotton_farm` | water | 60 `power` | 400 `cotton` | 600 | 1.5 h | 467.0 $ | 7.00/h | 20 h | 0.0250 $ | 0.0833 $ | 70% |
| **Obilná farma** `grain_farm` | water | 60 `power` | 550 `grain` | 800 | 1.5 h | 341.0 $ | 5.12/h | 18 h | 0.0148 $ | 0.0492 $ | 70% |
| **Železný důl** `iron_mine` | mine | 100 `power` | 300 `iron_ore` | 450 | 1.5 h | 1 116 $ | 16.7/h | 22 h | 0.0725 $ | 0.2416 $ | 70% |
| **Dřevařský tábor** `logging_camp` | forest | 80 `power` | 400 `log` | 600 | 1.5 h | 622.0 $ | 9.33/h | 20 h | 0.0333 $ | 0.1111 $ | 70% |
| **Ropná věž** `oil_rig` | mine | 80 `power` | 400 `crude_oil` | 600 | 1.5 h | 626.0 $ | 9.39/h | 22 h | 0.0335 $ | 0.1046 $ | 68% |
| **Kamenolom** `quarry` | mine | 80 `power` | 350 `stone` | 520 | 1.5 h | 469.0 $ | 7.04/h | 20 h | 0.0315 $ | 0.0986 $ | 68% |
| **Solární elektrárna** `solar_plant` | utility | — | 4000 `power` | 6000 | 1.5 h | 6 000 $ | 90.0/h | 55 h | 0.0225 $ | 0.0500 $ | 55% |
| **Cementárna** `cement_kiln` | industrial | 300 `stone`, 150 `power` | 200 `cement` | 320 | 1.6 h | 1 124 $ | 16.9/h | 34 h | 0.2697 $ | 0.4350 $ | 38% |
| **Mlýn** `flour_mill` | industrial | 400 `grain`, 60 `power` | 300 `flour` | 480 | 1.6 h | 731.0 $ | 11.0/h | 30 h | 0.1121 $ | 0.1933 $ | 42% |
| **Sklárna** `glass_works` | industrial | 300 `stone`, 200 `power` | 100 `glass` | 160 | 1.6 h | 1 305 $ | 19.6/h | 36 h | 0.5915 $ | 0.9540 $ | 38% |
| **Rafinerie** `refinery` | industrial | 300 `crude_oil`, 200 `power` | 150 `plastic` | 240 | 1.6 h | 1 481 $ | 22.2/h | 38 h | 0.4239 $ | 0.6838 $ | 38% |
| **Pila** `sawmill` | industrial | 200 `log`, 120 `power` | 240 `planks` | 380 | 1.6 h | 909.0 $ | 13.6/h | 30 h | 0.1744 $ | 0.3006 $ | 42% |
| **Huť** `smelter` | industrial | 250 `iron_ore`, 200 `power` | 120 `iron_ingot` | 200 | 1.7 h | 2 520 $ | 37.8/h | 38 h | 0.9017 $ | 1.4543 $ | 38% |
| **Textilka** `textile_mill` | industrial | 500 `cotton`, 120 `power` | 120 `fabric` | 190 | 1.6 h | 1 787 $ | 26.8/h | 36 h | 0.6204 $ | 1.0340 $ | 40% |
| **Elektronická linka** `electronics_lab` | industrial | 120 `wire`, 25 `glass`, 250 `power` | 80 `circuit` | 130 | 1.6 h | 2 706 $ | 40.6/h | 66 h | 1.1959 $ | 1.7084 $ | 30% |
| **Lis na hřebíky** `nail_press` | industrial | 30 `iron_ingot`, 80 `power` | 900 `nails` | 1400 | 1.6 h | 1 872 $ | 28.1/h | 48 h | 0.0841 $ | 0.1275 $ | 34% |
| **Ocelárna** `steel_mill` | industrial | 180 `iron_ingot`, 300 `power` | 60 `steel_sheet` | 100 | 1.7 h | 13 556 $ | 203.3/h | 60 h | 8.0019 $ | 11.7675 $ | 32% |
| **Tažírna drátů** `wire_draw` | industrial | 30 `iron_ingot`, 100 `power` | 750 `wire` | 1100 | 1.5 h | 1 911 $ | 28.7/h | 48 h | 0.1031 $ | 0.1561 $ | 34% |
| **Továrna na spotřebiče** `appliance_plant` | industrial | 30 `steel_sheet`, 40 `circuit`, 20 `machine_part`, 60 `plastic`, 300 `power` | 20 `appliance` | 35 | 1.8 h | 72 879 $ | 1 093/h | 108 h | 106.8436 $ | 140.5838 $ | 24% |
| **Pekárna** `bakery` | industrial | 200 `flour`, 50 `power` | 800 `bread` | 1300 | 1.6 h | 947.0 $ | 14.2/h | 44 h | 0.0692 $ | 0.0961 $ | 28% |
| **Lahůdky** `deli` | commercial | 200 `bread`, 30 `grain`, 40 `power` | 240 `sandwich` | 400 | 1.7 h | 588.0 $ | 8.82/h | 48 h | 0.1313 $ | 0.1824 $ | 28% |
| **Továrna na nábytek** `furniture_factory` | industrial | 80 `planks`, 300 `nails`, 120 `power` | 30 `furniture` | 50 | 1.7 h | 2 784 $ | 41.8/h | 72 h | 3.6686 $ | 4.9576 $ | 26% |
| **Oděvní továrna** `garment_factory` | industrial | 80 `fabric`, 100 `wire`, 100 `power` | 80 `clothing` | 130 | 1.6 h | 4 212 $ | 63.2/h | 72 h | 2.0814 $ | 2.8127 $ | 26% |
| **Strojírna** `machine_shop` | industrial | 40 `steel_sheet`, 20 `circuit`, 300 `power` | 50 `machine_part` | 80 | 1.6 h | 33 299 $ | 499.5/h | 84 h | 20.3870 $ | 28.3152 $ | 28% |
| **Nástrojárna** `tool_works` | industrial | 30 `steel_sheet`, 200 `nails`, 200 `power` | 60 `tools` | 100 | 1.7 h | 18 080 $ | 271.2/h | 78 h | 10.9954 $ | 14.8587 $ | 26% |

**Plnění skladu ~1,5–1,8 h u všech budov** — to je záměrné. Sklad je ventil: výroba běží offline, dokud se nenaplní. Konstantní doba plnění napříč tiery znamená konstantní rytmus vracení se ke hře.

## 3. Škálování úrovní

```
propustnost  × (1 + 0.30·(L−1))
údržba       × (1 + 0.22·(L−1))   ← roste POMALEJI než propustnost
sklad        × (1 + 0.35·(L−1))
upgrade L→L+1 = 0.75 · capex_L1 · 1.85^(L−1)
```

Protože údržba roste pomaleji než propustnost, **jednotkové náklady s úrovní klesají** (ekonomika z rozsahu ve výrobě). Diseconomie rozsahu je záměrně vytažená VEN z výroby a dána do korporátní režie (§4) — aby se trestala velikost *říše*, ne efektivní výroba.

| Úroveň | Výstup /h | Jedn. náklad | Údržba | Capex upgradu | Pracovníci | Mzda |
|---:|---:|---:|---:|---:|---:|---:|
| L1 | 30 | 3.6686 $ | 41.8/h | 2 088 $ | 1 | 3.50 $/h |
| L2 | 39 | 3.5829 $ | 50.9/h | 3 863 $ | 1 | 4.02 $/h |
| L3 | 48 | 3.5294 $ | 60.1/h | 7 146 $ | 2 | 4.63 $/h |
| L4 | 57 | 3.4928 $ | 69.3/h | 13 220 $ | 2 | 5.32 $/h |
| L5 | 66 | 3.4661 $ | 78.5/h | — $ | 3 | 6.12 $/h |

*(příklad: Továrna na nábytek — jednotkový náklad klesá z 3.6686 $ na 3.4661 $)*

## 4. Korporátní režie — diseconomie rozsahu

```
hq_overhead($/h) = 2.2 · N_budov^1.35 + 0.35 · Σ_úrovní^1.3
```

| N budov | Režie $/h | Režie $/den | Podíl na hrubém zisku |
|---:|---:|---:|---:|
| 2 | 14.7 | 351.6 | 4.4% |
| 5 | 50.5 | 1 211 | 6.0% |
| 12 | 164.6 | 3 950 | 8.2% |
| 25 | 443.3 | 10 639 | 10.5% |
| 50 | 1 130 | 27 120 | 13.4% |
| 100 | 2 880 | 69 132 | 17.1% |
| 200 | 7 343 | 176 225 | 21.8% |

Hrubý zisk škáluje ~lineárně s N, režie s N^1,45 → **poměr roste jako N^0,45**: ~10 % @ N=5, ~30 % @ N=50, ~50 % @ N=200. Velká říše se dusí vlastní vahou. Tohle je hlavní strukturální brzda oligarchie — spolu se sezónními resety.

## 5. Pozemky

| Typ | Počet | Nájem $/h | Nájem $/den (plno) | Odhadní cena | Daň $/týden |
|---|---:|---:|---:|---:|---:|
| `forest` | 40 | 8.00 | 7 680 | 9 000 $ | 27.0 |
| `mine` | 30 | 8.00 | 5 760 | 11 000 $ | 33.0 |
| `water` | 18 | 8.00 | 3 456 | 9 000 $ | 27.0 |
| `utility` | 20 | 6.00 | 2 880 | 14 000 $ | 42.0 |
| `industrial` | 100 | 5.00 | 12 000 | 6 000 $ | 18.0 |
| `commercial` | 60 | 10.00 | 14 400 | 12 000 $ | 36.0 |
| `civic` | 20 | 0.00 | 0.0000 | 0.0000 $ | 0.0000 |
| **Σ** | **288** | | **46 176 $/den** | | |

Nájem + daň z nemovitosti = **46 176 $/den** recurring sink na svět při plné obsazenosti, plus jednorázový sink z dražeb na začátku sezóny.

## 6. Makro model: faucet vs. sink vs. ΔM

**Faucet je demand-constrained, ne capacity-constrained.** Firma neutrhne to, co vyrobí,
ale to, co jí dovolí prodat NPC poptávka:

```
retail_pool(den)  = NPC_populace(den) × útrata_na_obyvatele
fill_rate_retail  = min(1, retail_pool / Σ světová retail kapacita)
```

Když světová kapacita převýší poptávku, `fill_rate < 1` → zboží zůstává neprodané
(propadá = goods sink) a faucet se smrskne. **To je ta negativní zpětná vazba,**
která drží ekonomiku stabilní. Bez ní model ukazuje hyperinflaci (viz §7 poznámka).

Dva faucety: **RETAIL** (NPC zákazníci, tier 3) a **STÁTNÍ ZAKÁZKY** (odkup za
85% mid, funguje od dne 1, podíl klesá s vyspělostí ekonomiky).
**Burza je TRANSFER** — v M2 se vyruší, není faucet ani sink.

Vše v $/den na jednu reprezentativní firmu, **při plné poptávce (fill = 1)**:

| Fáze | Bud. | **RETAIL**<br>faucet | **STÁT**<br>faucet | **Σ FAUCET** | Burza<br>(transfer) |
|---|---:|---:|---:|---:|---:|
| **Den 1-2 - STARTER** | 3 | 0.0000 | 2 906 | **2 906** | 4 179 |
| **Den 5-9 - RANA EXPANZE** | 8 | 1 582 | 3 920 | **5 502** | 8 564 |
| **Den 10-45 - STREDNI FAZE** | 20 | 35 476 | 13 059 | **48 534** | 54 469 |
| **Den 46+ - POZDNI FAZE** | 78 | 367 277 | 51 746 | **419 023** | 446 437 |

| Fáze | Nájem | Mzdy | Režie HQ | Poplatky | Daň<br>retail | Daň<br>nemov. | Capex | **Σ SINK** | Zisk | **ΔM** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Den 1-2 - STARTER** | 456.0 | 252.0 | 607.8 | 64.7 | 0.0000 | 12.4 | 1 491 | **2 884** | 2 711 | **22.5** |
| **Den 5-9 - RANA EXPANZE** | 1 200 | 672.0 | 2 285 | 140.3 | 79.1 | 27.9 | 2 049 | **6 453** | 4 098 | **−951.1** |
| **Den 10-45 - STREDNI FAZE** | 2 880 | 1 907 | 7 872 | 972.5 | 1 774 | 67.7 | 24 529 | **40 002** | 40 882 | **8 533** |
| **Den 46+ - POZDNI FAZE** | 11 280 | 18 010 | 49 432 | 8 360 | 18 364 | 257.1 | 225 058 | **330 760** | 321 511 | **88 263** |

Režie HQ je kalibrovaná automaticky z vypočtených marží: `HQ_K = 5.7473` $/h, což dává ~6% hrubého zisku při N=5 budovách a roste jako N^1.35 (poměr tedy jako N^0.35).

## 7. Projekce světa (kohortový model s kompresí marží)

Předpoklady: 120 dní · 12–40 nových firem/den · churn 0.6%/den · 40% hráčů plateauje ve střední fázi · startovní kapitál 25 000 $ · cílová fill rate retail 85%, stát 70% · daň z bohatství 0.3%/týden nad 500 000 $.

| Den | Firem | **M2** | $/firmu | Fill<br>ret | Fill<br>stát | Faucet/den | Sinks/den | **ΔM/den** | ΔM2<br>/měs | ΔY<br>/měs | **CPI<br>/měs** |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 12 | **300 268 $** | 25 173 | 1.00 | 1.00 | 334 666 | 34 398 | **300 268** | — | — | — |
| 7 | 87 | **2.12 M $** | 24 354 | 1.00 | 1.00 | 711 864 | 421 165 | **290 699** | — | — | — |
| 14 | 181 | **5.06 M $** | 27 882 | 1.00 | 1.00 | 3.23 M | 2.55 M | **681 435** | — | — | — |
| 30 | 425 | **31.14 M $** | 73 339 | 1.00 | 1.00 | 13.54 M | 11.02 M | **2.52 M** | — | — | — |
| 45 | 684 | **84.51 M $** | 123 469 | 1.00 | 1.00 | 24.74 M | 20.23 M | **4.51 M** | +1345.8 % | +570.2 % | **+775.7 %** 🔥 |
| 60 | 972 | **222.93 M $** | 229 279 | 1.00 | 1.00 | 65.94 M | 53.06 M | **12.89 M** | +615.8 % | +376.8 % | **+239.0 %** 🔥 |
| 90 | 1,623 | **948.54 M $** | 584 551 | 1.00 | 0.89 | 179.24 M | 143.70 M | **35.54 M** | +325.5 % | +151.9 % | **+173.6 %** 🔥 |
| 120 | 2,359 | **2594.71 M $** | 1.10 M | 0.85 | 0.70 | 247.31 M | 170.74 M | **76.57 M** | +173.5 % | +32.6 % | **+140.9 %** 🔥 |

**Výsledek:** M2 na konci sezóny **2594.71 M $** při 2,359 firmách → průměr 1.10 M $/firmu (44.0× startovního kapitálu). CPI drift **+140.9 %/měsíc** = růst M2 +173.5 % − růst reálného výstupu +32.6 %.

### 7.1 Proč CPI, a ne ΔM/M2

Z kvantitativní rovnice `M·V = P·Y` plyne `%ΔP = %ΔM + %ΔV − %ΔY`. Při zhruba konstantní
rychlosti oběhu tedy:

```
CPI drift (%/měsíc)  =  růst M2 (%/měsíc)  −  růst reálného výstupu Y (%/měsíc)
```

**Rostoucí herní ekonomika vyrábí víc zboží.** Když se svět rozroste z 12 na 2 359 firem,
reálný výstup Y roste desítkami procent měsíčně, a M2 tedy *musí* růst podobně rychle,
jen aby cenová hladina stála. Cílit přímo `ΔM/M2 = 2–4 %` by trestalo zdravý růst.
Správný cíl je **CPI drift 1–4 %/měsíc**.

### 7.2 Zjištění: model je bistabilní — a proč to není chyba ladění

Parametrický sweep (`tools/balance/tune.py`, 972 kombinací) nenašel stabilní střed.
Našel dva režimy a přímou úměru mezi nimi:

| disposal (kolik zisku hráči utratí) | CPI/měs | Přeživších firem | M2 | Bohatství |
|---|---:|---:|---:|---:|
| 0,70 | **+141 %** | 2 359 (všechny) | 2 595 M | 44× startu |
| 0,97 | **+1,5 %** | 679 (72 % mrtvých) | 10 M | 0,6× startu |

**CPI stabilitu lze v tomhle modelu dosáhnout pouze zabitím ekonomiky.** To není špatně
nastavený knoflík — je to chybějící mechanismus.

#### Diagnóza

Model používá `fill_rate` jako proxy za cenovou adjustaci. Jenže `fill_rate` snižuje
**tržby, aniž by snižoval náklady**. V reálném order booku to funguje jinak: když je
přebytek nabídky, klesne *cena* — a s ní klesnou nominální tržby **i nominální náklady
na vstupy** současně, protože vstupy se kupují na téže burze. Marže v poměrovém vyjádření
zůstává zachována; mění se jen cenová hladina.

Proto:

1. **Sinky vázané na zisk (capex, výzkum) se samy vyradí**, když komprese srazí zisk
   k nule — `capex = max(0, profit) × disposal`. Přestávají tlumit přesně ve chvíli,
   kdy by tlumit měly.
2. **Sinky nominální a fixní (režie HQ, nájem, daň z nemovitosti) při kompresi drtí**,
   protože neklesají spolu s tržbami → bankrotová kaskáda.
3. Reprezentativní-firma model **neumí tvořit ceny**. Rovnováha vzniká až v order booku.

#### Důsledky pro návrh (závazné)

- **Anti-inflační zátěž musí nést NOMINÁLNÍ sinky** (nájem, režie, daně, mzdy indexované
  na CPI). Capex a výzkum jsou bonus, ne páteř — vypadnou přesně když je potřeba.
- **Režie HQ nesmí být čistě fixní.** Návrh: 60 % fixní (škáluje s N^1,45) + 40 % z hrubé
  marže. Fixní složka tworí tlak, plovoucí složka brání bankrotové kaskádě.
- **Vstupy se musí kupovat na burze, ne za tabulkové ceny.** Jenom tak při poklesu cenové
  hladiny klesnou náklady spolu s tržbami a marže přežijí. To je argument PRO hluboký
  order book a PROTI jakémukoli „NPC výkupu za fixní cenu“ v pozdní hře.
- **Sezónní reset (ADR-003) je nosný mechanismus, ne volitelná kosmetika.** Uvnitř jedné
  sezóny, kde hráčská báze roste 200×, nelze držet CPI v pásmu laděním sinků. Reset
  peněžní zásoby je to, co inflaci řeší strukturálně.
- **Agent-based simulátor s endogenní tvorbou cen (doc 70) je nutnost, ne nice-to-have.**
  Statický model odvodil konzistentní ceny (§1–§5) a odhalil strukturální problém;
  rovnováhu ale najít neumí a ani nemůže.

**Praktický závěr pro MVP:** tabulka cen v §1–§2 je použitelná jako *seed* pro order book
a NPC market makera. Makro stabilitu ale nelze zaručit tabulkově — bude se ladit za běhu
podle denního makro dashboardu (`daily_snapshots`) a první sezóna se musí brát jako
kalibrační běh, ne jako hotový produkt.

**Jak číst fill rate:** `1.00` = svět je supply-constrained (vyprodáno, tukové marže, typicky raná hra). `< 1.00` = demand-constrained (přebytek kapacity, marže komprimované konkurencí). Přechod z 1.00 na ~0.75 během sezóny je přesně ta žádoucí dynamika: raní hráči mají šanci vyrůst, pozdní hráči musí soutěžit.

⚠️ *Model počítá reprezentativní firmu per fáze; reálná distribuce je širší a velryby táhnou průměr. Slouží k řádovému ladění. Přesné číslo dá agent-based simulátor (`docs/70-ekonomicky-simulator.md`), kde má každý hráč vlastní strategii.*

## 8. Ladící knoflíky — co otočit, když metrika ujede

| Symptom | Knoflík | Směr | Poznámka |
|---|---|---|---|
| ΔM/M2 > 6 %/měs (inflace) | `RETAIL_FILL_TARGET` | ↓ | víc přebytečné kapacity → menší faucet |
| ″ | `GOV_FILL_TARGET`, `gov_share` | ↓ | stát přestane tisknout |
| ″ | `WEALTH_TAX_WEEKLY` | ↑ | backstop na hromadění hotovosti |
| ″ | `HQ_BASE_SHARE` / `HQ_P` | ↑ | víc dusí velké říše |
| ″ | `aspirational_rate` | ↑ | výzkum/prestige/aukce pohltí zisk |
| ΔM/M2 < 1 % nebo záporné (deflace) | `RETAIL_FILL_TARGET` | ↑ | víc poptávky |
| ″ | `NPC_SPEND_PER_DAY`, `POOL_RAMP_START` | ↑ | větší/rychlejší pool |
| ″ | `gov_share` v raných fázích | ↑ | stát podpoří studený start |
| Nováček nemá šanci proti veteránovi | `HQ_P` | ↑ (1,45→1,60) | ostřejší diseconomie rozsahu |
| ″ | `WEALTH_TAX_THRESHOLD` | ↓ | zdaní dříve |
| ″ | `PROPERTY_TAX_WEEKLY` | ↑ | daň z nahromaděné půdy |
| Trh mrtvý, všichni vyrábí sami | `PLOT_COUNT` depositů | ↓ | vzácnější pozemky → nutí kupovat |
| ″ | marže `m` tieru 1–2 | ↑ | zpracování se musí vyplatit vs. integrace |
| Extrakce příliš tučná | `m` tieru 0 | ↓ (0,70→0,60) | nebo ↑ `PLOT_RENT` depositů |
| Pozdní hra je grind bez odměny | `payback` tieru 3 | ↓ | rychlejší návratnost |
| Order book závodí ke dnu | `quality_tier` | zapnout | segmentace booku, viz ADR-008 |

**Pořadí páky podle síly:** `RETAIL_FILL_TARGET` > `gov_share` > `HQ_BASE_SHARE` > `aspirational_rate` > `WEALTH_TAX_WEEKLY` > daně z pozemků. Vždy toč nejdřív fauceten, pak sinky — daň z bohatství je backstop, ne primární nástroj.

## 9. Design pravidla, která model drží pohromadě

1. **Maržový žebříček klesá s tierem** (70 % → 24 %). Extrakce je nejtučnější, ale gated vzácnými pozemky s deposit (`forest` 40, `mine` 30, `water` 18 z 288). Zpracování je hubené a závislé na cizích vstupech → **nuttí obchodovat**.
2. **Burzovní mid = 70% retail základu.** Burza rychlá za nižší cenu, retail pomalý a nejistý za vyšší. Jádro rozhodování.
3. **Návratnost roste s tierem** (18 h u farmy → 108 h u spotřebičů).
4. **Údržba = 1,5 % capex/h**, roste s úrovní pomaleji než propustnost → výroba má ekonomiku z rozsahu. Diseonomie rozsahu je záměrně vytažená VEN do korporátní režie, aby trestala velikost *říše*, ne efektivní výrobu.
5. **Režie HQ je FIXNÍ náklad** (ne % ze zisku), kalibrovaný automaticky z marží. Když komprese poptávky srazí tržby, režie zůstává → velké říše jsou zranitelné na pokyv cen. To je záměrná negativní zpětná vazba.
6. **Doba plnění skladu ~1,5–1,8 h u všech budov.** Sklad je ventil: výroba běží offline, dokud se nenaplní. Rytmus hry se s progresem nemění, roste jen *počet* věcí, které sleduješ.
7. **Dva faucety s opačným průběhem.** Stát dominuje raně (45 %), retail pozdní fázi (75 %). Součet je stabilní → ΔM nekouše.
8. **Neprodané retail zboží propadá.** Není to jen ztracená tržba — je to goods sink, který brání hromadění zásob a drží tlak na přesné plánování výroby.

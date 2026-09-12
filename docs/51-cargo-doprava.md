# 51 · Cargo simulace — doprava, kterou si zakládá hráč

> Fáze E. Navazuje na [50 · Logistika, silnice a čas](50-logistika-silnice-cas.md).
> Heslo: **nic nejezdí samo od sebe.** Každý náklaďák a každá loď na mapě
> patří na trasu, kterou hráč vědomě založil a platí ji.

## 1 · Motivace: plný dvorec

Produkční budova má vlastní malý sklad (`base_storage`, tábor 600, pila 380).
Když se naplní, budova přepadne do `full` a **přestane vyrábět**. Sklady
(`warehouse` +2 500, `harbor` +1 000) zvětšují kapacitu celé firmě, ale zboží
se do nich samo nepřemístí — to je práce cargo tras. Logistická smyčka hry:

```
důl/tábor ──🚚──> sklad ──(vstupy napříč firmou)──> továrna ──🚚──> obchod/sklad
```

## 2 · Datový model (`transport_routes`)

| sloupec | význam |
|---|---|
| `from_plot_id` / `to_plot_id` | oba body musí být **tvoje pozemky s budovou** |
| `mode` | `truck` (silnice) · `ship` (voda) |
| `vehicles` | 1–8; násobí kapacitu, přepravné i cenu vozového parku |
| `distance`, `path` | délka a dlaždice trasy (jsonb) — spočteno BFS při založení |
| `fee_per_hour`, `capacity_per_hour` | při plném vytížení, za celou trasu |
| `hauled_total`, `last_haul_at` | celkem svezeno (feedback do UI) |

Unikátní index `(from, to, mode)` — stejná trasa dvakrát nevznikne.

## 3 · Pravidla sítě (`apps/api/src/transport.ts`)

- 🚚 **truck**: BFS po dlaždicích `plot_type='road'` + hráčské budovy `road`.
- 🚢 **ship**: BFS po dlaždicích `plot_type='water'` (řeka musí spojovat oba body).
- Krajní body (budovy) do sítě nepatří — trasa startuje na budově, projde
  sousední průchozí dlaždicí a končí na cílové budově.
- Žádná cesta → `no_route` (422) s radou postavit silnice / využít nábřeží.
- `quoteRoute` vrací nabídku pro **oba** módy najednou (které jdou, s cenami).

## 4 · Ekonomika (vše přes podvojný ledger)

| tok | kam mizí/vzniká | kdy |
|---|---|---|
| vozový park: `truck` 250 Kč/ks, `ship` 1 500 Kč/ks | `sink_transport` (journal `transport`) | při založení trasy |
| přepravné: (1,2 + 0,12 × dlaždice)/h na náklaďák; (2,0 + 0,06)/h na loď | `sink_transport` | **jen za svezené jednotky** |

Přepravné za jednotku = `fee_per_hour / capacity_per_hour`. Nic se neveze →
nic nestojí; žádná skrytá daň za zapomenutou trasu. Není-li na přepravné
v hotovosti, zboží zůstane ležet (trasa nebankrotuje firmu).

Kapacity: náklaďák 150 ks/h, loď 600 ks/h. Při ceně kulatiny ~0,11 Kč a
těžbě 400 ks/h je plný vláček (3 náklaďáky, 10 dlaždic) za ~2,7 Kč/h —
pár procent z tržby, přesně jak má být logistická režie.

## 5 · Tick (`haulCargo`)

Po výrobě a retailu, ve stejné transakci:

1. pro každou `active` trasu: sklad „odkud“ (inventář na pozemku budovy),
2. volné místo ve skladu „kam“ (`base_storage` cílové budovy + `extra_capacity`),
3. přesun `min(kapacita × cykly, zásoby, volno)` po řádcích inventáře,
4. přepravné za svezené množství → ledger, `hauled_total += ks`.

**Oprava u kořene:** `plotInventory` v ticku dřív padal zpět na primární
inventář firmy — všechny budovy tak sdílely jeden sklad a cargo nemělo co
převážet. Teď má každá budova vlastní dvorec (inventář na svém pozemku);
primární HQ inventář drží počáteční zásoby a do vstupu výroby jde jako
běžný sklad (vstupy se berou napříč inventáři firmy — `companyStock`).

## 6 · UI

- Inspektor: u vlastní budovy **„🚚 Vézt zboží odsud…“** → horní banner
  „klikni na cílovou budovu“ → u cíle nabídka: 🚚/🚢 přepínač, počet vozidel
  −/＋, kapacita, přepravné, cena parku, **Založit trasu**.
- Panel **„Tvoje trasy“**: ikonka módu, odkud → kam, vozidla, dlaždice, ks/h,
  svezeno celkem, ✕ smazat.
- Mapa (`TrafficLayer`): trasy vykreslené čárkovaně (zlatá = silnice, modrá =
  voda), vozy krouží **jednosměrně** (fix „popojíždění tam a zpět“ z fáze D),
  rychlost sleduje herní čas, v pauze stojí. Dekorativní samovolná doprava
  z fáze D **odstraněna** — jezdí jen hráčovy trasy.
- Seed: první demo firma (Borealis Woods) dostane sklad u tahu a dvě ukázkové trasy (tábor→sklad 2×🚚,
  pila→sklad 1×🚚), aby nový hráč dopravu hned viděl v akci.

## 7 · Testy

Smoke sekce 15 (`tools/api/smoke.mjs`): demo trasy existují, cesta v jsonb,
nabídka 200 + truck, self-route 422, založení 200 a **přepočet ceny parku**
(−750 Kč z cash firmy 2), duplicita 422, smazání 200/404, audit PASS,
M2 identita. Celkem 76/76.

## 8 · Otevřené otázky

- Ceny přepravy jsou fixní; trh je dál nepřenáší (žádné `transport orders`).
- Trasy neřeší fronty (dva vozy stejné firmy se potkávají — kosmetika).
- Lodě berou vodu jako volnou síť; kanály/plavební komory mezi řekami neexistují.

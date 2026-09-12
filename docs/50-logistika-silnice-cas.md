# 50 · Logistika, silnice a herní čas (Fáze D)

**Stav:** ✅ implementováno · **Navazuje na:** [40-onboarding](40-onboarding-questy.md), [10-ekonomika](10-ekonomika-core-loop.md)

## 1 · Větší svět

Výchozí mřížka je **80×40 = 3200 pozemků** (dříve 64×32) (`WORLD_W`/`WORLD_H`). Poměry biomů
jsou zlomky plochy, takže charakter světa se s velikostí nemění; silniční síť
se generuje rozměrově (osy + okruh), ne natvrdo.

## 2 · Silniční síť (`apps/api/src/logistics.ts`)

Tři druhy dlaždic:

| druh | jak vzniká | kdo vlastní |
|---|---|---|
| **státní tah** | seed: vodorovná + svislá osa (protnou město = bulváry) a okruh kolem centra (`plot_type='road'`) | stát (neprodejné) |
| **hráčská silnice** | budova `road` na vlastním pozemku, libovolný terén | hráč |
| **napojená produkce** | budova, jejíž SOUSEDní dlaždice leží v souvislé síti s hlavním tahem (BFS) | — |

Produkční budova bez napojení má stav **`disconnected`** (nová položka enumu
`building_status`): nevyrábí a neplatí údržby, dokud se nenapojí.

### 2.1 Dvě cesty k napojení

1. **DIY:** koupit sousední pozemky a postavit na ně `road` (150 Kč + údržba).
2. **Najmout stavební firmu** (`POST /api/plots/:id/hire-road`): BFS najde
   nejkratší schůdnou trasu (volné pozemky + vlastní prázdné; cizí vlastněné
   ne), **vykoupí půdu za 30 % odhadní ceny** (veřejná infrastruktura) a
   účtuje **250 Kč/dlaždici**. Cena předem: `GET /api/plots/:id/road-quote`.

Peníze: výkup → `sink_land_purchase`, poplatek → `sink_capex` — oboje mizí
z oběhu, makro identita drží. Designový záměr: **čím dál od tahů stavíš,
tím dráž** — mapa tím dostává ekonomickou geografii.

## 3 · Sklady a doprava

- Budova `warehouse` (industrial) přidává **+2 500 kapacity celé firmě**
  (tick ji přičítá ke skladům všech provozů).
- Auta jsou zatím **vizuální vrstva** (`TrafficLayer` ve WorldMap): BFS přes
  silniční síť dá trasu hlavní tah → produkční budova a po ní jezdí dodávky
  (izometrický model: korba, kabina, kola, stín). Rychlost aut sleduje herní
  čas; v pauze stojí. Simulace nákladů dopravy (`sink_transport`) je dál
  otevřená otázka — viz §5.

### Lodě a vodní cesty

- **Řeka je přírodní dopravní síť:** `roadNetwork` bere dlaždice `water` jako
  navigovatelné „státní tahy“ — pozemek sousedící s vodou je napojený zdarma
  (nábřeží = prémiová parcela, oceňuje ji trh, ne kód).
- Budova **`harbor` (Přístav)**: capex 900, údržba 2/h, **+1 000 skladu**
  (tick ji sčítá se sklady stejně jako `warehouse`). `buildBuilding` ji pustí
  jen na pozemek se 4-sousední vodou, jinak `wrong_terrain`.
- **Lodě** (`buildShipRoutes` ve WorldMap): pro dvě největší řeky spočteme
  průměr (2× BFS) a každému přístavu trasu od jeho nábřeží ke vzdálenému konci
  řeky (max. 4). Izometrický model: trup, paluba s kontejnery, kabina, brázda.
  Lodě jedou ~2× pomaleji než dodávky; v pauze stojí s nimi.

### Viewport culling

Svět poroste nad 2 048 dlaždic, proto WorldMap kreslí jen okno viditelné
pohledem: rohy viewBoxu převedeme inverzní izometrií zpět na mřížku
(`u = x−y`, `v = x+y`) a filtrujeme `ordered` na obdélník + rezervu 2 dlaždice
(nad horizontem dalších 120 px pro výškové budovy). Při plném oddálení se
kreslí vše, při práci na detailu jen stovky uzlů.

## 4 · Herní čas (`worlds.sim_speed`, `worlds.sim_hours`)

- Viditelný čas v HUD: **Den N · HH:00**; jeden tick = jedna herní hodina.
- `POST /api/clock {speed}` s `speed ∈ {0,1,2,4}`: **0 = pauza** (tick nic
  nedělá, hodiny stojí), 2/4 = tick reprezentuje 2/4 hodiny — výroba, vstupy,
  údržby i retail se škálují počtem hodin, takže zrychlení je poctivé,
  ne jen kosmetické.
- Stav je v DB (řádek světa), přežije restart; `CHECK (sim_speed IN (0,1,2,4))`.

## 5 · Kniha (kodex)

`GET /api/codex` vrací recepty (vstupy → výstupy, terén, množství) a UI
`CodexView` je podává ve třech záložkách: **Recepty** (řetězce po tierech),
**Budovy** (katalog s capex/údržbou/skladem) a **Příručka** (peníze, trh,
energie, silnice, čas, questy). Je to čtecí vrstva nad hlubokou ekonomikou:
hrát jde bez ní, plánovat s ní.

## 6 · Otevřené otázky (→ [99](99-otevrena-rozhodnuti.md))

- Auta a lodě jsou dekorace: cargo simulace (náklad, doby svozu,
  `sink_transport`) je další krok.
- Silnice zatím nezvyšují hodnotu sousedních pozemků (adjacency bonus z doc 10).

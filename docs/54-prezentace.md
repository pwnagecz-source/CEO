# 54 · Prezentační vlna: hra musí vypadat jako hra

> Hráč po Fázi F řekl: *„Silnice a náklaďáky vypadají hrozně, budovy jsou všechny
> stejné, tutoriál se ukáže jen jednou a celkově to chce profesionálnější design.“*
> Z nabízených balíčků vybral **★ Doporučený**: jeho 4 přání + noční světla,
> staveniště, toasty, feed světa, HUD badgy a ESC/ikony/prázdné stavy.
> Mimo scope zůstaly: minimapa, klávesová kamera, bohatší terén, level-up konfety,
> tutoriál herního pohledu.

Princip celé vlny: **žádná nová herní mechanika, jen zpětná vazba a řemeslo**.
Ekonomika, ledger ani tick se nemění (kromě nové tabulky `world_events`, která
je čistě prezentační — zápisy se nedotýkají peněz).

## 1 · Budovy: 28 procedurálních variant (`game/buildingArt.ts`)

Dosud kreslil `drawBuilding` v `WorldMap.tsx` generický kvádr s barvou odvětví.
Nový modul `buildingArt.ts` obsahuje `drawBuildingArt(o: ArtOpts, code)` —
switch přes všech 28 kódů budov, kde **každý typ má vlastní siluetu čitelnou
na první pohled**:

| skupina | příklady kreseb |
|---|---|
| těžba | `iron_mine` headframe s těžní klecí, `quarry` terasovaný lom s drtičkou, `oil_rig` pumpjack s houpající se hlavou, `logging_camp` srub + hromada klád |
| energie | `solar_plant` pole panelů s odleskem, rafinerie `refinery` s nádržemi a **animovaným hořákem** |
| zemědělství | `grain_farm` / `cotton_farm` pruhy polí (`fieldRows`) + silo / sklizeň, barva dle plodiny |
| zpracování | `cement_kiln` rotační pec s komínem a kouřem, `smelter`/`steel_mill` **pulzující výheň**, `glass_works` sklářská pec, `flour_mill` mlýn s dopravníkem, `sawmill` pila s katrem |
| lehký průmysl | `textile_mill` tkalcovna s pilovou střechou, `electronics_lab` čisté hala + antény, `nail_press`/`wire_draw`/`machine_shop`/`tool_works` dílenské haly s převody a kompresory, `appliance_plant` hala s jeřábovými drahami, `furniture_factory` dřevozpracující hala |
| retail | `bakery` výloha se stříškou a pecí vevnitř, `deli` **neon** (v noci svítí), obchody s markýzami |
| infrastruktura | `warehouse` sklad s rampami a kontejnery, `harbor` přístav s gantry a jeřábem, `road` (nekreslí se — řeší terénní vrstva) |

Architektura modulu:

- `ArtOpts = { ctx, c, now, level, producing, night, skin, seed }` — vše, co
  kresba potřebuje: pozici, čas (animace), úroveň (počet pater), stav výroby
  (kouř/výheň jen když budova skutečně vyrábí), **noční faktor**, skin odvětví
  a deterministický seed z pozice (okna/náhodné detaily se mezi snímky nehýbou).
- Sada primitiv: `box` (kvádr se 3 viditelnými stěnami), `hipRoof`/`sawRoof`,
  `cylinder` (nádrže/sila), `chimney` (+ animovaný kouř z částic), `pile`,
  `crate`, `windows` (mřížka oken, v noci náhodně svítí dle seedu),
  `nightGlow`, `awning`, `fieldRows`. Z nich jsou složené všechny varianty —
  přidat novou budovu je ~20 řádků.
- `drawConstructionArt` — **staveniště**: jeřáb s otáčejícím se ramenem,
  oplocení, hromady materiálu, základy. Kreslí se místo budovy, dokud je
  `b_status === 'construction'` (nová stavba i upgrade).

Rozhodnutí: procedurální Canvas kresby místo sprite sheetů — nulová datová
stopa, nekonečné rozlišení (zoom), snadná úprava, konzistentní paleta přes
`shade()` z `art.ts`. Sprite atlas zůstal jako otevřená možnost (99-rozhodnutí).

## 2 · Silnice: síť, ne čtverečky

Terénní vrstva (`drawTileBase`) teď dostává `roadSet` (množinu klíčů `x,y`
obsazených silnicí) a kreslí:

- **asfalt** se speckle šumem (tmavší základ + světlé tečky),
- **štěrkové krajnice** jen na hranách, kde silnice *nesousedí* s další
  silnicí (4 kontroly sousedů) — křižovatky tak plynule splývají,
- **přerušovanou osu** jen když silnice pokračuje v jedné ze dvou diagonálních
  os (NE–SW nebo NW–SE); na křižovatkách žádné čáry (byl by guláš),
- návaznost na státní síť i najaté stavitele — stejná množina z `plots`.

Silnice jako „budova“ (`b_code === 'road'`) se v budovové vrstvě přeskakuje —
už je vyřešená v terénu, takže nestojí žádný per-frame čas navíc.

## 3 · Doprava: tahače s návěsy, lodě s kontejnery

- `drawTruck(ctx, x, y, dir, cargo, long)` — kabina s oknem a světlem,
  návěs s barevným kontejnerem a žebrováním, 4 kola s disky, vržený stín.
  `dir` se počítá z `pointAt(l, t) → pointAt(l, t+ε)` (překlopení podle směru
  jízdy), `long` přidává delší návěs u vícekusových linek.
- `drawShip` — trup s ponorkou a palubou, řada barevných kontejnerů,
  nástavba s komínem na zádi, **brázda za lodí**.
- Každá linka dostává barvu nákladu z palety `CARGO_COLORS` podle indexu —
  tři linky do tří různých skladů jsou na mapě rozeznatelné.

## 4 · Noc: světla v oknech

Herní čas už měl tint oblohy (α ≤ 0,42, rampa 19–21 a 4–6 h). Stejná křivka
se teď počítá jako `night ∈ [0,1]` v kreslicí smyčce a předává se do
`drawBuildingArt`: `windows()` náhodně rozsvěcí okna (seed × budova, aby
neskákala), `nightGlow` dává halo kolem svítících ploch, `deli` neon a
`refinery` hořák v noci září. Denní scéna je beze změny.

## 5 · Feed světa: `world_events` (backend + UI)

- Tabulka `world_events(id, world_id, sim_hour, kind, text, at)` + index
  `(world_id, id DESC)`; migrace v `0001_init.sql` i `0002_ensure.sql`.
- `events.ts`: `logEvent(d, worldId, kind, text, simHour?)` — volá se
  **uvnitř transakce ticku/akce** (stejná data jako logy), po zápisu prune
  na posledních 400 řádků světa. `listEvents` vrací JSON pro endpoint.
- Zapisují: `npc.ts` (expanze ⬆️/🏗️), `progression.ts` (🔬 výzkum hotový),
  `contracts.ts` (📋 zakázka splněna), `tick.ts` (⭐ level-up firmy —
  `UPDATE … RETURNING xp` pro detekci překročení prahu).
- `GET /api/events?limit=25` v `server.ts`.
- UI: klient polluje po 5 s (spolu s počtem volných zakázek pro badge);
  panel **„📰 Svět se hýbe“** v inspektoru ukazuje posledních 8 událostí
  s relativním časem (`ago()`), prázdný stav má hlášku.

Rozhodnutí: poll místo SSE — události nejsou citlivé na latenci, `stream`
delta protokol zůstává vyhrazený mapě a hodinám (méně pohyblivých částí).

## 6 · Zpětná vazba akcí: toasty (`ToastHost.tsx`)

- `gameAction` v `App.tsx` nově akceptuje `fn` vracející **text úspěchu**;
  akce mapy hlásí: nákup pozemku, stavbu, prodej (`Prodáno 34 ks za 12 450 Kč`),
  upgrade, demolici, najatí silnice, založení linky.
- Modaly (výzkum/zakázky/finance) dostaly volitelné `onToast` — hlásí
  zahájení výzkumu, přijetí/splnění zakázky (`+1 240 Kč · +18 XP`), půjčku,
  splacení, najmutí/propuštění manažera.
- App detekuje **dokončený výzkum** (diff množiny `done` kódů, poll 10 s) a
  **level-up** (diff `level`) → toast + `researchBadge` / `lvlFlash`.
- Vrstva: pravý dolní roh, max 5 toastů, success/info/warn s barevným pruhem,
  mizí po 5/7 s, klik zavře.

## 7 · HUD, ESC, tutoriál

- Badgy v HUD: počet **volných zakázek** (číselný) a **✦ u Výzkumu**, když
  něco doběhlo a hráč to ještě neotevřel (otevření badge zhasne).
- Level chip při level-upu dvakrát zeleně zapulzuje (`lvlFlash`).
- **ESC zavírá modaly** (globální keydown v App).
- Tutoriál terminálu: ukáže se **pokaždé**, když se Terminál otevře —
  dokud hráč neklikne „🔕 Příště už nezobrazovat“ (localStorage
  `ceo.tut.term.v1 = 'off'`; stará hodnota `'done'` se ignoruje → tutoriál se
  vrátí i dřívějším hráčům). Tlačítko ✦ ho otevře kdykoli znovu; když je
  vypnutý, nabízí kartu „🔔 Příště zase zobrazit“.

## 8 · Design: Inter Variable + leštění

- `@fontsource-variable/inter` (self-host, žádné CDN), `--sans` rozšířen o
  `"Inter Variable"`.
- styles.css: scrollbar styling, `::selection`, focus-visible, toasty/feed/
  badgy/flash/tut-foot styly, lehké leštění tlačítek a modalů (shadow-2/3).
  Stávající glass design systém (tokeny `--panel`, `--border`, gradienty)
  zůstává — vlna přidává, nic nepřepisuje.

## 9 · Verifikace

- `npm run typecheck` (api + web) čistý.
- **Art runtime check**: 28 kódů × noc/den × vyrábí/ne × 2 úrovně + staveniště
  = 229 kreseb přes stub-canvas proxy (13 canvas metod) — žádná runtime chyba.
- SSR render check: GameView s feedem/badgema/eventy, ToastHost,
  TerminalTutorial ve vypnutém i zapnutém stavu.
- Smoke **123/123** včetně nové sekce **[18]**: `/api/events` shape, limit,
  řazení a deterministický trigger (výzkum `eff_timber` = 2 herní hodiny
  nastartovaný v [17] doběhne na první tick při rychlosti 4 → research event).
- Audit invariantů PASS i po vlně (events nejsou účetní entita).

## 10 · Co zůstává otevřené

- Sprite atlas / bohatší terénové textury (mechanika hotová, `skinFor` lze
  podměnit).
- Minimap a klávesová kamera (vědomě odložené).
- Zvuky (Fáze F je vyloučila; toasty jsou vizuální náhrada).
- Feed v Terminálu — zatím jen v herním pohledu; data (`api.events`) jsou
  sdílená, přidání je otázka jednoho panelu.

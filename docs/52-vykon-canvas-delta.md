# 52 · Výkon: Canvas 2D renderer a delta protokol

> Fáze E (opt). Hra se na mapě 64×32 sekala — tohle je diagnóza a dvě opravy,
> na kterých se hráč shodl: **Canvas 2D místo SVG DOM** a **SSE delta
> protokol místo stahování celé mapy**.

## 1 · Diagnóza

| problém | proč seká |
|---|---|
| SVG v DOM | 2 048 dlaždic × 10–15 elementů ≈ **25 000 uzlů** — layout a paint celého stromu při každém hoveru, výběru i pollu |
| polling celé mapy | každé 2,5 s ~400 kB JSONu; nové objekty plotů → re-render všech dlaždic (memo comparator pomáhal, ale DOM stejně zůstával) |
| traffic v Reactu | dobře (rAF + refy), ale animoval desítky `<g>` v sekajícím se DOMu |

## 2 · Canvas 2D renderer (`apps/web/src/components/WorldMap.tsx`)

Jeden `<canvas>` místo tisíců elementů. Vrstvy:

1. **Terénní vrstva** — offscreen canvas s diamanty, biomy, detailem
   (stromy/skály/vlny), středovým značením silnic a obrysy vlastnictví.
   Překreslí se **jen když se obsah mapy změní** — porovnává se FNV
   `mapSignature` (typy, vlastníci, budovy), ne reference objektu.
2. **Budovy** — každý snímek, painter's order (x+y), jen v okně pohledu
   (culling inverzní izometrií: `u = x−y`, `v = x+y` z rohů view).
   Animace: blikající okna, **časově animovaný kouř** z komínů, pulzující
   stavová kontrolka.
3. **Doprava** — čárkované čáry tras + náklaďáky/lodě, **jednosměrný okruh**
   (fix ping-pongu z fáze D), rychlost = `dt × clockSpeed` (pauza = stojí).
4. **Výběr/hover** — diamanty nad vším.

Kamera (zoom na kurzor, tažení, ⤢) žije v **refu**, ne ve stavu — pohyb
myši nevyvolá jediný React render. React se překreslí jen při výměně dat
nebo změně tooltipu. Hover tooltip je HTML overlay (`.map-tip`).

Hráčská silnice (budova `road`) se už nekreslí jako šedý hranol, ale jako
plochý asfalt s přerušovaným středovým značením.

## 3 · Delta protokol — SSE (`/api/stream`)

```
event: init    data: {grid, plots[…2048]}     ← při připojení / po resetu světa
event: plots   data: [ …jen změněné pozemky… ] ← diff 1× za sekundu
event: clock   data: {speed, hours, day, hour} ← jen když se pohnou hodiny
```

- Server (`server.ts`): `mapSnapshot()` (sdílený s `/api/map`) +
  `clockState()`; diff smyčka 1×/s porovnává JSON signature pozemků a
  broadcastuje změny všem SSE klientům. Bez klientů se nic nepočítá.
- Klient (`App.tsx`): `EventSource` merguje `plots` do stavu mapy po id,
  `init` nahrazuje mapu celou (a přesynchronizuje vybraný pozemek).
  Rychlý poll (2,5 s) dál obíhá LEHKÉ endpointy (firma, book, questy…);
  celá mapa se stahuje jen při startu, po `init` a **každých 30 s jako
  pojistka** proti ztraceným událostem. Akce (nákup/stavba) volají
  `refreshMap()` okamžitě, takže kliknutí má instantní odezvu.
- `/api/demo/reset` mění `worldId` → diff smyčka pošle všem nový `init`.

**Výsledek:** SSR markup herního pohledu klesl z ~1,4 MB na ~4 kB; v
provozu zmizelo ~25 000 DOM uzlů a 96 % payloadu mapy (posílají se jen
desítky změněných pozemků za tick místo 2 048 každých 2,5 s).

## 4 · Co to znamená pro „hru jako aplikaci“

Renderer je teď engine-agnostický: kreslí do jednoho plátna vlastní smyčkou.
Krok ke desktopové aplikaci (Tauri) je proto levný — stejný kód se zabalí do
nativního okna, a až mapa přeroste desítky tisíc dlaždic nebo přibudou
částicové efekty, vymění se 2D kontext za WebGL (PixiJS) beze změny zbytku
aplikace.

## 5 · Testy

- Smoke sekce 16: SSE vrací `text/event-stream`, nový klient dostane `init`
  s celou mapou, změna rychlosti hodin přijde jako delta `clock` event.
  Celkem **80/80**.
- SSR kontrola: GameView s canvas mapou renderuje bez DOM dlaždic.
- `render:map` přepsán na nezávislý export SVG z dat (kontrola geometrie:
  2 048 polygonů, 0 NaN).

## 6 · Otevřené otázky

- Diff smyčka počítá celý snapshot 1×/s (2048 řádků + BFS) — při větší mapě
  přesunout na change-feed (trigger → NOTIFY) nebo Redis pub/sub.
- SSE je jednosměrné; obousměrné akce (drag-and-drop stavění) chtějí WS.
- PixiJS/WebGL jako další stupeň, až bude obsahově proč (částice, stíny,
  denní cyklus světla).

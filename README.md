# CEO

Textově/UI orientovaný prohlížečový **MMO ekonomický simulátor**. Hráč zakládá firmu, staví
výrobní řetězce, obchoduje na burze řízené výhradně hráči (CLOB) a prodává finální zboží
simulovaným zákazníkům.

Inspirace: **Capital Rift** (hráči řízený order book, live P&L, logistika) a **Sim Companies**
(tick-based výroba, agregovaná retail poptávka, systém odvětví).

> Stav projektu: **Fáze 0–2 hotové (návrh + datový model) a aplikace se dá spustit.**
> Běží API s kompletním schématem, podvojným ledgerem a matching enginem plus webový
> terminál. Viz [Spuštění](#spuštění).

## Spuštění

Bez Dockeru a bez instalovaného Postgresu — databáze běží jako **PGlite**
(skutečný PostgreSQL 18 zkompilovaný do WASM, v procesu API).

```bash
npm install
npm run dev          # API (Fastify, :8080) + web (Vite, :5173) najednou
```

Web otevílej na portu **5173**; `/api` požadavky proxyuje na Fastify, takže prohlížeč
mluví jen s jedním originem. Data jsou defaultně in-memory — každý start je čistý svět,
migrace + seed trvají ~1 s. `PGDATA=./data npm run dev` je uloží na disk.

```bash
npm run dev:api      # jen API
npm run dev:web      # jen web
npm run smoke        # end-to-end test obchodního cyklu (API musí běžet)
npm run db:check     # spustí celou migraci na skutečném PostgreSQL 18 (WASM)
npm run db:validate  # levnější: jen PostgreSQL parser (pglast)
npm run typecheck    # oba workspacy
```

`npm run smoke` přepočítává peníze **nezávisle na implementaci** — hrubou cenu,
maker/taker poplatky, pohyb M2 a pět audit invariantů — takže zachytí rozjetí mezi
matching enginem a ledgerem, ne jen HTTP 200.

### Co je hotové a co je kostra

| | Stav |
|---|---|
| Kompletní DDL (125 statementů) — 26 tabulek, 13 enumů, podvojný ledger, triggery, audit funkce | ✅ běží na skutečném Postgresu |
| Matching engine: CLOB, price-time priority, limit + market (IOC), escrow, maker/taker poplatky, anti-wash, idempotence, rušení příkazů | ✅ end-to-end otestováno |
| Pět audit invariantů včetně makro identity `M2 ≡ ΔM` a hlídače úniku escrow | ✅ |
| Seed ekonomiky z `balance-v0.2.json`: 25 položek, 25 budov, 25 receptů, 288 pozemků, 4 demo firmy, 12 úvodních příkazů | ✅ |
| Webový terminál: order book s hloubkou, zadávání příkazů s odhadem exekuce, P&L firmy, sklad, páska obchodů, stavová lišta invariantů | ✅ |
| Tick engine (výroba, údržba, retail), auth, WebSocket delta protokol, sezóny, Redis/BullMQ, Drizzle | ⬜ zatím ne — polling a demo firmy bez přihlášení |

### Struktura

```
apps/api/src/
  db.ts        PGlite + spouštění migrací + transakční helper
  ledger.ts    podvojný zápis, zůstatky, makro snapshot, audit invariantů
  market.ts    matching engine, order book, escrow, rušení příkazů
  seed.ts      seed světa z balance JSON + demo firmy
  server.ts    Fastify routy
apps/web/src/
  api.ts       typovaný klient (relativní cesty → Vite proxy)
  estimate.ts  odhad exekuce proti booku (stejná logika jako engine)
  components/  Header, ItemsPanel, BookPanel, CompanyPanel, TradeTape, Footer
tools/
  db/check_ddl.mjs      spuštění DDL na skutečném Postgresu, statement po statementu
  api/smoke.mjs         end-to-end test s nezávislým přepočtem peněz
  db/validate_sql.py    parser-level validace (pglast)
  balance/*.py          generátor a ladič ceníku
scripts/dev.mjs         spustí API i web najednou
```

## Dokumentace

| # | Dokument | Obsah | Stav |
|---|---|---|---|
| 00 | [Vize a koncept](docs/00-vize-a-koncept.md) | pilíře, core loop, ekonomické toky, výroba, CLOB trh, retail, anti-inflace, datový model, stack, MVP | ✅ návrh<br>⚠️ 3 sekce překonány |
| 10 | [Ekonomika a core loop](docs/10-ekonomika-core-loop.md) | uzamčená rozhodnutí, real-time tick model, odvození cen, pozemky, retail fill-rate, inflace, sezóny | ✅ hotovo |
| 20 | [Datový model](docs/20-datovy-model.md) | ERD, 3 nezrušitelná pravidla, invarianty, indexy a hot path, escrow, tick, observabilita | ✅ hotovo |
| — | [0001_init.sql](db/migrations/0001_init.sql) | kompletní DDL — 26 tabulek, 125 statementů, podvojný ledger s DB-vynuceným invariantem | ✅ parser **i** skutečný Postgres |
| — | [Balance v0.2](docs/generated/balance-v0.2.md) | *generováno* — ceník 25 položek, 25 budov, úrovně, režie, pozemky, makro projekce, ladící knoflíky | 🤖 auto |
| 99 | [Otevřená rozhodnutí](docs/99-otevrena-rozhodnuti.md) | ADR log — 4 uzamčena, 3 nová z modelových zjištění, 4 otevřená | 🔶 částečně |
| 30 | `docs/30-matching-engine.md` | CLOB specifikace, pseudokód, race conditions, testy | ⬜ |
| 40 | `docs/40-tick-engine.md` | výroba, retail simulace, údržba, lazy evaluation | ⬜ |
| 50 | `docs/50-realtime.md` | SSE/WS, event schéma, coalescing, reconnect | ⬜ |
| 60 | `docs/60-mvp-sprint-plan.md` | rozpad na 2týdenní sprinty s akceptačními kritérii | ⬜ |
| 70 | `docs/70-ekonomicky-simulator.md` | offline balance testing s fake hráči | ⬜ |

## Plánovaný stack

TypeScript end-to-end · modulární monolit · **PostgreSQL 17** (zdroj pravdy, podvojný ledger)
· **Node.js 22 + Fastify + Drizzle** · **Redis 7 + BullMQ** (tick engine, queue, pub/sub)
· **React 19 + Vite + TanStack Query/Table + shadcn/ui + ECharts** · **WebSocket** pro realtime
market data (SSE jako fallback) — změna vůči doc 00 §5, viz ADR-002 a doc 10 §7.

Detail a zdůvodnění: [`docs/00-vize-a-koncept.md` §5](docs/00-vize-a-koncept.md) a
[`docs/10-ekonomika-core-loop.md` §7](docs/10-ekonomika-core-loop.md).

## Nástroje

| Cesta | Účel |
|---|---|
| `tools/balance/generate_v0.py` | Odvodí ceny všech položek zdola nahoru (cost-plus) a vygeneruje balance tabulky + seed JSON. Retuning = změna `m`/`payback`/`q_out` a rerun. |
| `tools/balance/tune.py` | Parametrický sweep makro knoflíků (972 kombinací) proti cílovému CPI driftu. |
| `tools/db/validate_sql.py` | Validuje migrace skutečným PostgreSQL parserem (pglast) + hlásí pasti, které parser propustí. |
| `tools/db/check_ddl.mjs` | **Spustí** celou migraci na PostgreSQL 18 (PGlite/WASM), statement po statementu, a vypíše každou chybu. Odhaluje to, co parser ne: sémantiku, typy, neexistující objekty, `IMMUTABLE` v indexových predikátech. |
| `tools/api/smoke.mjs` | End-to-end test obchodního cyklu proti běžícímu API s nezávislým přepočtem cen, poplatků, M2 a pěti audit invariantů. |
| `seed/balance-v0.2.json` | Výstup generátoru — seed dat pro DB (položky, budovy, recepty, úrovně, pozemky). |

```bash
npm run db:check                                  # migrace na skutečném Postgresu
npm run smoke                                     # end-to-end obchodní cyklus
python3 tools/balance/generate_v0.py              # přegenerovat balance
python3 tools/balance/tune.py --top 12            # sweep makro knoflíků
RETAIL_FILL_TARGET=0.7 HQ_P=1.6 python3 tools/balance/generate_v0.py   # override přes env
pip install pglast && python3 tools/db/validate_sql.py db/migrations/*.sql
```


## Klíčová designová pravidla

1. **Burza je hra.** Order book je jediný zdroj pravdy o cenách — žádná „oficiální" cena.
2. **Zboží vzniká jen těžbou, peníze jen retail prodejem.** Vše ostatní je přenos a v ledgeru
   se musí rovnat nule.
3. **Sklad je ventil.** Výroba běží offline, dokud se nenaplní výstupní sklad — žádné umělé timery.
4. **První zisk do 5 minut.** Pacing křivka je explicitní designový artefakt, ne náhoda.
5. **Sinky škálují superlineárně s bohatstvím**, jinak ekonomiku ovládne oligarchie.
   Páteř musí být **nominální** sinky (nájem, režie, daně, mzdy indexované na CPI) —
   sinky vázané na zisk vypadnou přesně ve chvíli, kdy by měly tlumit (ADR-010).
6. **Cíl je CPI drift, ne růst peněžní zásoby.** `CPI = %ΔM2 − %ΔY`. Rostoucí ekonomika
   *musí* zvyšovat M2, jen aby cenová hladina stála (ADR-009).
7. **Vstupy se kupují na burze, ne za tabulkové ceny.** Jen tak při poklesu cenové hladiny
   klesnou náklady spolu s tržbami a marže přežijí (ADR-011).
8. **F2P, nikdy pay-to-win.** Reálné peníze neinjectují herní měnu.

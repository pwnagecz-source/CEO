# CEO

Textově/UI orientovaný prohlížečový **MMO ekonomický simulátor**. Hráč zakládá firmu, staví
výrobní řetězce, obchoduje na burze řízené výhradně hráči (CLOB) a prodává finální zboží
simulovaným zákazníkům.

Inspirace: **Capital Rift** (hráči řízený order book, live P&L, logistika) a **Sim Companies**
(tick-based výroba, agregovaná retail poptávka, systém odvětví).

> Stav projektu: **Fáze 0 — návrh.** Žádný produkční kód zatím.

## Dokumentace

| # | Dokument | Obsah | Stav |
|---|---|---|---|
| 00 | [Vize a koncept](docs/00-vize-a-koncept.md) | pilíře, core loop, ekonomické toky, výroba, CLOB trh, retail, anti-inflace, datový model, stack, MVP | ✅ návrh<br>⚠️ 3 sekce překonány |
| 10 | [Ekonomika a core loop](docs/10-ekonomika-core-loop.md) | uzamčená rozhodnutí, real-time tick model, odvození cen, pozemky, retail fill-rate, inflace, sezóny | ✅ hotovo |
| 20 | [Datový model](docs/20-datovy-model.md) | ERD, 3 nezrušitelná pravidla, invarianty, indexy a hot path, escrow, tick, observabilita | ✅ hotovo |
| — | [0001_init.sql](db/migrations/0001_init.sql) | kompletní DDL — 26 tabulek, 122 statementů, podvojný ledger s DB-vynuceným invariantem | ✅ validováno |
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
| `seed/balance-v0.2.json` | Výstup generátoru — seed dat pro DB (položky, budovy, recepty, úrovně, pozemky). |

```bash
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

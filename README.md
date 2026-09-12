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
| 00 | [Vize a koncept](docs/00-vize-a-koncept.md) | pilíře, core loop, ekonomické toky, výroba, CLOB trh, retail, anti-inflace, datový model, stack, MVP | ✅ návrh |
| 99 | [Otevřená rozhodnutí](docs/99-otevrena-rozhodnuti.md) | ADR log — 8 rozhodnutí čekajících na potvrzení | 🔶 otevřeno |
| 10 | `docs/10-ekonomika-core-loop.md` | balance spreadsheet, konkrétní čísla, faucets/sinks v $ | ⬜ |
| 20 | `docs/20-datovy-model.md` | kompletní DDL, indexy, constrainty, migrace | ⬜ |
| 30 | `docs/30-matching-engine.md` | CLOB specifikace, pseudokód, race conditions, testy | ⬜ |
| 40 | `docs/40-tick-engine.md` | výroba, retail simulace, údržba, lazy evaluation | ⬜ |
| 50 | `docs/50-realtime.md` | SSE/WS, event schéma, coalescing, reconnect | ⬜ |
| 60 | `docs/60-mvp-sprint-plan.md` | rozpad na 2týdenní sprinty s akceptačními kritérii | ⬜ |
| 70 | `docs/70-ekonomicky-simulator.md` | offline balance testing s fake hráči | ⬜ |

## Plánovaný stack

TypeScript end-to-end · modulární monolit · **PostgreSQL** (zdroj pravdy, podvojný ledger)
· **Node.js + Fastify + Drizzle** · **Redis + BullMQ** (tick engine, queue, pub/sub)
· **React 19 + Vite + TanStack Query/Table + shadcn/ui + ECharts** · **SSE** pro realtime
market data (WS-ready event schéma).

Detail a zdůvodnění: [`docs/00-vize-a-koncept.md` §5](docs/00-vize-a-koncept.md).

## Klíčová designová pravidla

1. **Burza je hra.** Order book je jediný zdroj pravdy o cenách — žádná „oficiální" cena.
2. **Zboží vzniká jen těžbou, peníze jen retail prodejem.** Vše ostatní je přenos a v ledgeru
   se musí rovnat nule.
3. **Sklad je ventil.** Výroba běží offline, dokud se nenaplní výstupní sklad — žádné umělé timery.
4. **První zisk do 5 minut.** Pacing křivka je explicitní designový artefakt, ne náhoda.
5. **Sinky škálují superlineárně s bohatstvím**, jinak ekonomiku ovládne oligarchie.
6. **F2P, nikdy pay-to-win.** Reálné peníze neinjectují herní měnu.

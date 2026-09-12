# Otevřená rozhodnutí (ADR log)

Formát: každé rozhodnutí má stav `OTEVŘENO` / `ROZHODNUTO` / `ODLOŽENO`, doporučení a dopad.
Jakmile se rozhodne, přesune se do `docs/adr/NNN-*.md` s datem a zdůvodněním.

---

## ADR-001 — Prostorovost: mapa a pozemky vs. abstraktní ekonomika
**Stav:** OTEVŘENO
**Otázka:** Má hra mít geografii (pozemky, vzdálenosti, doprava, lokace budov), nebo je
prostor čistě abstraktní (firma = seznam budov)?

| Varianta | Scope | Důsledek pro ekonomiku |
|---|---|---|
| **A. Abstraktní** (Sim Companies) | Malý — žádné mapové UI, žádné pathfinding | Doprava = paušální poplatek. Specializace drží odvětvový bonus. |
| **B. Mřížka pozemků** (limited grid per svět) | Střední — tabulka `plots`, alokace, vzácnost | Pozemky = vzácný zdroj a silný sink. Vzniká „realitní" trh. |
| **C. Reálná mapa** (Capital Rift / OSM) | Obrovský — tile server, geodata, rendering | Logistika a vzdálenost jako plnohodnotná mechanika. Pro sóla nereálné v MVP. |

**Doporučení:** **B** — omezená mřížka pozemků (např. 200 pozemků na svět, dražba). Dává
vzácnost a sink za ~10 % práce varianty C. Varianta A je bezpečná záloha.
**Dopad:** tabulka `plots`, `buildings.plot_id`, modul dopravy, UI mapa.

---

## ADR-002 — Tempo hry a očekávaná doba online
**Stav:** OTEVŘENO
**Otázka:** Jak často má hráč *potřebovat* být online?

| Varianta | Délka prvního cyklu | Typ hráče | Důsledek |
|---|---|---|---|
| **A. Real-time / aktivní** | 30 s – 5 min | hraje 1–2 h v kuse | potřeba real-time tick (1 s), vysoká zátěž, risk burnoutu |
| **B. Hybridní (idle-strategy)** | 2–5 min první, pak 15 min – 4 h | 3–5× denně, 10 min | tick 1 min, offline postup s limitem skladu ✅ |
| **C. Async / dlouhodobý** (Sim Companies) | 4–24 h | 1× denně, 5 min | nízká zátěž, ale slabá retenční křivka na začátku |

**Doporučení:** **B** — viz `docs/00-vize-a-koncept.md` §3.4. Tick 1 min, první cyklus 2–5 min,
max ~12 h v pozdní hře. Offline limit řeší sklad, ne timer.
**Dopad:** granularita ticku, počet BullMQ jobů, délka build times, UX notifikací.

---

## ADR-003 — Trvalý svět vs. sezónní resety
**Stav:** OTEVŘENO
**Otázka:** Jeden permanentní svět, nebo sezóny s resetem?

| Varianta | Anti-inflace | Noví hráči | Retence | Riziko |
|---|---|---|---|---|
| **A. Permanent single world** | Musí se řešit jen sinks (těžké) | Po 6 měsících beznadějně pozadu | Vysoká u veteránů | neřešitelná oligarchie |
| **B. Sezónní (3–6 měs.) + prestige carry-over** | Reset = vyřešeno | Každá sezóna férový start | Peak na začátku sezóny | hráči „ztratí progres" — citlivé |
| **C. Hybrid: permanent core + sezónní ligy** | Částečně | Ligy dávají entry point | Nejlepší z obou | nejvíc kódu |

**Doporučení:** **B**, s *schema podporou od MVP* (`world_id` všude), i kdybychom první reset
spustili až za rok. Zpětná migrace na multi-world je bolestivá a riskuje ztrátu dat.
**Dopad:** `worlds` tabulka, `world_id` FK na companies/orders/trades, prestige systém,
admin tooling pro spuštění světa.

---

## ADR-004 — Zkušenost s technologiemi / preferovaný stack
**Stav:** OTEVŘENO
**Otázka:** Jaký je tvůj silný stack? Sólový vývojář by měl stavět v tom, co zná —
rychlost vývoje je u hry tohoto typu kritičtější než benchmarky.

| Varianta | Stack | Kdy zvolit |
|---|---|---|
| **A. TypeScript monolit** (doporučení) | Node + Fastify + Drizzle + React + PG + Redis | znáš JS/TS; sdílené typy FE↔BE = největší výhra pro sóla |
| **B. Python** | FastAPI/Django + SQLAlchemy + React + PG + Redis | znáš Python; Django admin je hotový backoffice zadarmo |
| **C. Go** | Go + pgx + React + PG + Redis | chceš výkon a jednoduchý deploy (1 binárka); víc kódu pro CRUD |
| **D. Fullstack framework** | Next.js + Drizzle + PG (Neon/Supabase) + Redis | nejrychlejší start; SSR a API v jednom; horší pro WS/dlouhé joby |

**Doporučení:** **A**, ledaže máš výrazně silnější zkušenost s B/C.
**Dopad:** celý `docs/50-*` a implementační fáze.

---

## ADR-005 — Monetizace
**Stav:** OTEVŘENO (v dokumentu jen pravidlo, ne model)
**Pravidlo přijaté v §6:** F2P, reálné peníze **nikdy** přímo neinjectují herní měnu.
**Otázka k doplnění:** kosmetika / QoL předplatné / premium svět / nic na začátku?
**Doporučení:** do MVP nic. Od fáze 3 kosmetika + QoL předplatné (více order slotů,
rychlejší notifikace, detailní analytika) — vše neekonomické.
**Dopad:** tabulka `purchases`, Stripe integrace, `premium_until`.

---

## ADR-006 — Lokalizace a cílová velikost hráčské báze
**Stav:** OTEVŘENO
**Otázka:** CZ-only, EN-only, nebo i18n od začátku? A na kolik hráčů cílíme —
50, 500, nebo 5 000 concurrent?

| Varianta | Důsledek |
|---|---|
| CZ-only | nejrychlejší, ale malá hráčská báze = **řídké order booky = mrtvá ekonomika**. Kritický risk. |
| EN-only | největší trh, žádná i18n režie |
| i18n od MVP | ~15 % práce navíc (stringy do `locales/*.json`, žádné hardcode), otevírá CZ+EN+DE |

**Doporučení:** **i18n struktura od MVP, obsah nejdřív EN** (s CZ jako druhým).
Důvod: hráči řízená burza **vyžaduje kritickou masu**. Sim Companies má ~25 000 DAU;
Capital Rift ~4 000 hráčů. Pod ~200 aktivních hráčů bude order book na většině komodit
prázdný a hra se bude cítit mrtvá i při skvělém kódu. NPC market maker (§3.5) to tlumí,
ale nenahradí.

**Dopad:** `packages/shared/locales/`, i18n runtime, formátování měny/čísel, SEO obsah.

---

## ADR-007 — Úroveň realismu účetnictví
**Stav:** ROZHODNUTO (předběžně) — k potvrzení
**Rozhodnutí:** Plné podvojné účetnictví (§4), ale **bez** GAAP/IFRS reportů
(Simunomics je dělá; my ne). Stačí: P&L, rozvaha, cashflow, per-budova P&L.
**Důvod:** invariant `SUM=0` je nejlepší debugging nástroj, jaký v ekonomické hře můžeš mít.
**Dopad:** `accounts` + `journal_entries`, noční audit job.

---

## ADR-008 — Granularita kvality zboží v MVP
**Stav:** ROZHODNUTO (předběžně) — k potvrzení
**Rozhodnutí:** Sloupec `quality_tier` v DB **od MVP**, produkce pouze tieru 1, UI skryté.
**Důvod:** kvalita segmentuje order book a brání závodu ke dnu (§3.3). Zpětné přidání do
`inventory` + `market_orders` + `trades` je migrace přes miliony řádků.
**Dopad:** primary klíče a unique indexy obsahují `quality_tier` od začátku.

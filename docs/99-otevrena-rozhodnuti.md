# Otevřená rozhodnutí (ADR log)

Formát: každé rozhodnutí má stav `OTEVŘENO` / `ROZHODNUTO` / `ODLOŽENO`, doporučení a dopad.
Jakmile se rozhodne, přesune se do `docs/adr/NNN-*.md` s datem a zdůvodněním.

---

## ADR-001 — Prostorovost: mapa a pozemky vs. abstraktní ekonomika
**Stav:** ✅ ROZHODNUTO 2026-09-12 → **B) Omezená mřížka pozemků**
**Rozhodnutí:** 288 pozemků na svět (mřížka 24×12), 7 typů, depositní pozemky gates těžbu.
**Důsledek:** nová ekonomická vrstva — dražby, nájem, daň z nemovitosti, adjacency, sekundární
trh s půdou. Doprava v MVP = paušál podle manhattan vzdálenosti (žádné pathfinding).
**Detail:** `docs/10-ekonomika-core-loop.md` §4.
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
**Stav:** ✅ ROZHODNUTO 2026-09-12 → **A) Real-time / aktivní sezení**
**Rozhodnutí:** hráč hraje 1–2 h v kuse; první výrobní cyklus 90 s; burza je živá.
**Důsledky (dva, oba mění architekturu):**
1. **Globální 1s tick NE.** Server settle 1 min, klient interpoluje progress bary lokálně
   na 60 fps. „Real-time" je vlastnost UX, ne simulace — viz doc 10 §2.
2. **Obrací doporučení transportu SSE → WebSocket** (ADR-004 vstup se změnil: vyšší
   concurrent, subscription churn, latence zápisu je gameplay). Viz doc 10 §7.
**Detail:** `docs/10-ekonomika-core-loop.md` §2, §7.
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
**Stav:** ✅ ROZHODNUTO 2026-09-12 → **B) Sezónní světy + prestige carry-over**
**Rozhodnutí:** sezóna 120 dní; přecházejí Legacy Points, jméno, kosmetika a archiv.
Nepřechází hotovost, budovy, inventář, objednávky.
**Důsledek:** `world_id` na `companies`, `market_orders`, `trades`, `plots` od první migrace.
**⚠️ Potvrzeno modelovým důkazem, ne jen intuicí:** sweep 972 konfigurací ukázal, že
uvnitř jedné rostoucí sezóny NELZE držet CPI v pásmu 1–4 %/měs laděním sinků — systém je
bistabilní (hyperinflace, nebo kolaps). Sezónní reset je tedy **nosný anti-inflační
mechanismus**, ne kosmetika. Viz `docs/10-ekonomika-core-loop.md` §6.
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
**Stav:** ✅ ROZHODNUTO 2026-09-12 → **A) TypeScript monolit**
**Rozhodnutí:** Node 22 + Fastify + Drizzle + React 19 + Vite + PostgreSQL 17 + Redis 7
+ BullMQ, pnpm workspaces + Turborepo, Zod pro sdílená schémata, ECharts pro grafy.
**Změna vůči doc 00 §5:** real-time transport **WebSocket** (primární) + SSE (fallback),
ne SSE-only. Důvod v doc 10 §7.
**Detail:** `docs/00-vize-a-koncept.md` §5, `docs/10-ekonomika-core-loop.md` §7.
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

---

## ADR-009 — Cílová makro metrika: CPI drift, ne ΔM/M2
**Stav:** ✅ ROZHODNUTO 2026-09-12 (na základě modelového zjištění)
**Rozhodnutí:** Cílová metrika je **CPI drift = %ΔM2 − %ΔY** v pásmu **1–4 %/měsíc**,
ne růst peněžní zásoby `ΔM/M2`.
**Důvod:** z kvantitativní rovnice `M·V = P·Y` plyne, že rostoucí ekonomika musí zvyšovat
M2 jen aby udržela cenovou hladinu. Původní cíl `ΔM/M2 = 2–4 %` (v doc 00 §3.2) by trestal
zdravý růst. **Doc 00 §3.2 je tímto překonán.**
**Dopad:** `daily_snapshots` musí ukládat i Laspeyres index reálného výstupu Y.

---

## ADR-010 — Páteř anti-inflace musí být nominální sinky
**Stav:** ✅ ROZHODNUTO 2026-09-12 (na základě modelového zjištění)
**Rozhodnutí:** Anti-inflační zátěž nesou **nominální, na zisku nezávislé sinky** — nájem,
korporátní režie, daň z nemovitosti, daň z bohatství a **mzdy indexované na CPI**.
Capex a výzkum jsou doplněk, ne páteř.
**Důvod:** sinky vázané na zisk (`capex = max(0, profit) × disposal`) se samy vyradí přesně
ve chvíli, kdy by měly tlumit — když komprese marží srazí zisk k nule.
**Dopad:** korporátní režie = 60 % fixní složka + 40 % z hrubé marže (čistě fixní způsobuje
bankrotovou kaskádu, čistě plovoucí netvoří tlak).

---

## ADR-011 — Statický model neumí najít rovnováhu; nutný agent-based simulátor
**Stav:** ✅ ROZHODNUTO 2026-09-12
**Rozhodnutí:** `tools/balance/generate_v0.py` slouží k **odvození konzistentních cen**
(cost-plus zdola nahoru) a k řádovému makro odhadu. **Nehledá rovnováhu a nemůže.**
Rovnováhu musí ověřit agent-based simulátor s endogenní tvorbou cen (`docs/70-*`).
**Důvod:** model používá `fill_rate` jako proxy za cenovou adjustaci, ale `fill_rate`
snižuje tržby, aniž by snižoval náklady. V reálném order booku klesá *cena* a s ní
nominální tržby **i nominální náklady na vstupy** současně → marže v poměrovém vyjádření
přežijí. To statický model nezachytí.
**Důsledek pro návrh:** je to argument **PRO** hluboký CLOB a **PROTI** NPC výkupu za fixní
cenu v pozdní hře. NPC market maker se musí vypínat, jakmile to hráčská likvidita dovolí.
**Priorita:** `docs/70-ekonomicky-simulator.md` jde NAHORU — z P2 na **P1**, protože bez
něj nelze ekonomiku validovat před spuštěním.

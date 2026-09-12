import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError, api,
  type Audit, type Book, type CatalogRow, type Clock, type CodexInput, type CodexRecipe,
  type Company, type CompanySummary, type Item, type Macro, type MapData, type MapPlot,
  type HistoryPoint, type OpenOrder, type PlaceOrderResult, type QuestState, type RoadQuote,
  type RouteMode, type RouteQuoteResult, type Trade, type TransportRoute,
} from './api'
import CodexView from './components/CodexView'
import ContractsView from './components/ContractsView'
import FinanceView from './components/FinanceView'
import GameView from './components/GameView'
import ResearchView from './components/ResearchView'
import SetupScreen from './components/SetupScreen'
import TerminalView from './components/TerminalView'

const POLL_MS = 2500
const DEFAULT_ITEM = 'log'

/**
 * Stav aplikace se drží v jednom místě a polluje se.
 *
 * Záměrně NE WebSocket: delta protokol s 250 ms koalescencí a 60fps
 * interpolací na klientu (doc 00, real-time ADR-002) přijde s produkčním
 * tickem. Pro ověření ekonomiky je polling dostatečný a hlavně debugovatelný —
 * každý refresh je kompletní snímek, ne sekvence delt, kterou by šlo ztratit.
 *
 * Tok hry: při prvním vstupu běží PRŮVODCE ZALOŽENÍ FIRMY (jméno → odvětví →
 * pozemek → stavba). Ten je jediná věc, kterou nový hráč musí pochopit;
 * zbytek ekonomiky se odemyká postupně v herním pohledu a v Terminálu.
 */
export default function App() {
  const [fatal, setFatal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [health, setHealth] = useState<{
    worldId: number; engine: string; version?: string; startingCapital: number
  } | null>(null)
  const [macro, setMacro] = useState<Macro | null>(null)
  const [audit, setAudit] = useState<Audit | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [catalog, setCatalog] = useState<CatalogRow[]>([])
  const [fees, setFees] = useState({ maker: 0.005, taker: 0.025 })
  const [companies, setCompanies] = useState<CompanySummary[]>([])
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [company, setCompany] = useState<Company | null>(null)
  const [orders, setOrders] = useState<OpenOrder[]>([])
  const [itemCode, setItemCode] = useState(DEFAULT_ITEM)
  const [map, setMap] = useState<MapData | null>(null)
  const [quests, setQuests] = useState<QuestState | null>(null)
  const [clock, setClock] = useState<Clock | null>(null)
  const [codex, setCodex] = useState<{ recipes: CodexRecipe[]; inputs: CodexInput[] } | null>(null)
  const [roadQuote, setRoadQuote] = useState<RoadQuote | null>(null)
  const [selectedPlot, setSelectedPlot] = useState<MapPlot | null>(null)
  // Cargo: hráčské dopravní trasy + rozpracovaná trasa (odkaz → cíl)
  const [routes, setRoutes] = useState<TransportRoute[]>([])
  const [routeFrom, setRouteFrom] = useState<MapPlot | null>(null)
  const [routeQuote, setRouteQuote] = useState<RouteQuoteResult | null>(null)
  const [routeQuoteErr, setRouteQuoteErr] = useState<string | null>(null)
  // Výchozí pohled je HRA. Terminál (expertní) je na jedno kliknutí, ale není to
  // první věc, kterou nový hráč uvidí.
  const [mode, setMode] = useState<'game' | 'terminal' | 'codex'>('game')
  const [modal, setModal] = useState<null | 'research' | 'contracts' | 'finance'>(null)
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [book, setBook] = useState<Book | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Akce ve hře (nákup pozemku, stavba) mají vlastní stav: text „co se děje“
  // a chybovou hlášku, kterou ukazuje inspektor.
  const [actBusy, setActBusy] = useState<string | null>(null)
  const [actErr, setActErr] = useState<string | null>(null)
  const [setup, setSetup] = useState(true)

  // Ref, aby interval nevolal stale closure a aby se při ručním refresh
  // nezdvojil požadavek.
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const [h, m, a, it, cos, tr, cat, ck, cx] = await Promise.all([
        api.health(), api.macro(), api.audit(), api.items(), api.companies(), api.trades(),
        api.catalog(), api.clock(), api.codex(),
      ])
      setHealth({
        worldId: h.worldId, engine: h.engine, version: h.version,
        startingCapital: h.startingCapital,
      })
      setMacro(m)
      setAudit(a)
      setItems(it.items)
      setFees(it.fees)
      setCompanies(cos.companies)
      setTrades(tr.trades)
      setCatalog(cat.buildings)
      setClock(ck)
      setCodex(cx)
      setFatal(null)

      const cid = companyId ?? cos.companies[0]?.id ?? null
      if (cid) {
        setCompanyId(cid)
        const [co, oo, qs, rt] = await Promise.all([
          api.company(cid), api.orders(cid), api.quests(cid), api.routes(cid),
        ])
        setCompany(co)
        setOrders(oo.orders)
        setQuests(qs)
        setRoutes(rt.routes)
      } else {
        setQuests(null)
        setRoutes([])
      }

      const code = it.items.some((x) => x.code === itemCode) ? itemCode : DEFAULT_ITEM
      setItemCode(code)
      setBook(await api.book(code))

      setLastSync(new Date())
      setError(null)
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : String(e))
      // API nedostupné (startuje / spadlo) → řekni to rovnou, nezobrazuj prázdný shell
      if (e instanceof TypeError) setFatal(msg)
      else setError(msg)
    } finally {
      inFlight.current = false
    }
  }, [companyId, itemCode])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  /** Celá mapa najednou — při startu, po resetu světa a jako pojistka. */
  async function refreshMap() {
    try { setMap(await api.map()) } catch { /* SSE/poll to spraví */ }
  }

  /**
   * Delta protokol (SSE): server posílá jen pozemky, které se změnily,
   * a hodiny. Celá mapa se stahuje jen na začátku, po `init` (nový/reset
   * světa) a každých 30 s jako pojistka proti ztraceným událostem.
   */
  useEffect(() => {
    void refreshMap()
    const safety = setInterval(() => void refreshMap(), 30_000)
    if (typeof EventSource === 'undefined') return () => clearInterval(safety)
    const es = new EventSource('/api/stream')
    const applyInit = (data: string) => {
      try {
        const m = JSON.parse(data) as MapData
        setMap(m)
        setSelectedPlot((prev) => (prev ? m.plots.find((x) => x.id === prev.id) ?? null : prev))
      } catch { /* neplatný payload ignorujeme */ }
    }
    const applyPlots = (data: string) => {
      try {
        const changed = JSON.parse(data) as MapPlot[]
        const idx = new Map(changed.map((c) => [c.id, c]))
        setMap((prev) => (prev
          ? { ...prev, plots: prev.plots.map((p) => idx.get(p.id) ?? p) }
          : prev))
        setSelectedPlot((prev) => (prev ? idx.get(prev.id) ?? prev : prev))
      } catch { /* neplatný payload ignorujeme */ }
    }
    const onInit = (e: Event) => applyInit((e as MessageEvent).data as string)
    const onPlots = (e: Event) => applyPlots((e as MessageEvent).data as string)
    const onClock = (e: Event) => {
      try { setClock(JSON.parse((e as MessageEvent).data as string) as Clock) }
      catch { /* ignore */ }
    }
    es.addEventListener('init', onInit)
    es.addEventListener('plots', onPlots)
    es.addEventListener('clock', onClock)
    // onerror netřeba řešit: EventSource se reconnectuje sám a server po
    // znovu-připojení pošle čerstvý init.
    return () => { es.close(); clearInterval(safety) }
  }, [])

  /** Přepne položku okamžitě, bez čekání na další poll. */
  async function selectItem(code: string) {
    setItemCode(code)
    try { setBook(await api.book(code)) } catch { /* poll to spraví */ }
  }

  async function selectCompany(id: string) {
    setCompanyId(id)
    // Singleplayer bez auth: vybrat firmu = hrát za ni. Claim řekne serveru,
    // aby ji NPC mozek vynechával (jinak by soupeř hrál za tebe).
    void api.claimCompany(id).catch(() => { /* nevadí — svět běží dál */ })
    try {
      const [co, oo] = await Promise.all([api.company(id), api.orders(id)])
      setCompany(co)
      setOrders(oo.orders)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Historie ceny pro sparkline v Terminálu (mění se s výběrem položky).
  useEffect(() => {
    let alive = true
    void api.priceHistory(itemCode, 96)
      .then((r) => { if (alive) setHistory(r.history) })
      .catch(() => { if (alive) setHistory([]) })
    return () => { alive = false }
  }, [itemCode, mode])

  /** Společný obal akcí ve hře: stavový text, chyba, refresh světa. */
  async function gameAction(label: string, fn: () => Promise<void>) {
    setActBusy(label); setActErr(null)
    try {
      await fn()
      await Promise.all([refresh(), refreshMap()])
    } catch (e) {
      setActErr(e instanceof ApiError ? e.message : (e instanceof Error ? e.message : String(e)))
    } finally {
      setActBusy(null)
    }
  }

  const buyPlot = (p: MapPlot) => void gameAction('Nakupuji pozemek…', async () => {
    if (!companyId) throw new ApiError(400, null, 'Nejdřív založ firmu')
    await api.buyPlot(p.id, Number(companyId))
  })

  const buildAt = (p: MapPlot, code: string) => void gameAction('Stavím…', async () => {
    if (!companyId) throw new ApiError(400, null, 'Nejdřív založ firmu')
    await api.build(p.id, Number(companyId), code)
  })

  const quickSell = (itemCode: string) => void gameAction('Prodávám…', async () => {
    if (!companyId) throw new ApiError(400, null, 'Nejdřív založ firmu')
    await api.quickSell(companyId, itemCode)
  })

  const upgrade = (buildingId: string) => void gameAction('Přestavuji…', async () => {
    if (!companyId) throw new ApiError(400, null, 'Nejdřív založ firmu')
    await api.upgradeBuilding(buildingId, companyId)
  })

  const demolish = (buildingId: string) => void gameAction('Bourám…', async () => {
    if (!companyId) throw new ApiError(400, null, 'Nejdřív založ firmu')
    await api.demolishBuilding(buildingId, companyId)
    setSelectedPlot(null)
  })

  const hireRoad = (p: MapPlot) => void gameAction('Stavební firma pokládá silnici…', async () => {
    if (!companyId) throw new ApiError(400, null, 'Nejdřív založ firmu')
    await api.hireRoad(p.id, companyId)
  })

  const createTransportRoute = (to: MapPlot, mode: RouteMode, vehicles: number) =>
    void gameAction('Vozový park vyráží…', async () => {
      if (!companyId || !routeFrom) throw new ApiError(400, null, 'Nejdřív vyber odkud')
      await api.createRoute(companyId, routeFrom.id, to.id, mode, vehicles)
      setRouteFrom(null)
      setRouteQuote(null)
    })

  const removeRoute = (id: string) => void gameAction('Ruším trasu…', async () => {
    if (!companyId) throw new ApiError(400, null, 'Nejdřív založ firmu')
    await api.deleteRoute(id, companyId)
  })

  async function setSpeed(speed: number) {
    try {
      await api.setClock(speed)
      setClock(await api.clock())
    } catch (e) {
      setActErr(e instanceof ApiError ? e.message : String(e))
    }
  }

  // Nabídka cargo trasy: když mám rozpracovaný odkaz a vybraný cíl (moje budova).
  useEffect(() => {
    let alive = true
    setRouteQuote(null)
    setRouteQuoteErr(null)
    if (!routeFrom || !companyId || !selectedPlot
        || selectedPlot.id === routeFrom.id || selectedPlot.owner_id !== companyId
        || !selectedPlot.b_id) {
      return () => { alive = false }
    }
    api.routeQuote(companyId, routeFrom.id, selectedPlot.id)
      .then((q) => { if (alive) setRouteQuote(q) })
      .catch((e) => {
        if (alive) setRouteQuoteErr(e instanceof ApiError ? e.message : String(e))
      })
    return () => { alive = false }
  }, [routeFrom, selectedPlot, companyId])

  // Cena napojení: dopočítávám jen když má smysl (vlastní nenapojená budova).
  useEffect(() => {
    let alive = true
    const p = selectedPlot
    if (!p || !companyId || p.owner_id !== companyId || !p.b_id || p.connected) {
      setRoadQuote(null)
      return () => { alive = false }
    }
    api.roadQuote(p.id, companyId)
      .then((q) => { if (alive) setRoadQuote(q) })
      .catch(() => { if (alive) setRoadQuote(null) })
    return () => { alive = false }
  }, [selectedPlot, companyId])

  async function place(p: {
    side: 'buy' | 'sell'; qty: number; priceLimit: number | null
    orderType: 'limit' | 'market'
  }): Promise<PlaceOrderResult | null> {
    if (!companyId) return null
    setBusy(true)
    try {
      // Idempotency key posíláme pokaždé: kdyby uživatel dvojklikl nebo spadla
      // síť po odeslání, server vrátí stejný výsledek a nevznikne druhý příkaz.
      const r = await api.placeOrder({
        companyId: Number(companyId),
        itemCode,
        side: p.side,
        qty: p.qty,
        priceLimit: p.priceLimit,
        orderType: p.orderType,
        idempotencyKey: crypto.randomUUID(),
      })
      await refresh()
      return r
    } finally {
      setBusy(false)
    }
  }

  async function cancel(orderId: number) {
    if (!companyId) return
    setBusy(true)
    try {
      await api.cancelOrder(orderId, Number(companyId))
      await refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    setBusy(true)
    try {
      await api.reset()
      setSelectedPlot(null)
      await Promise.all([refresh(), refreshMap()])
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (fatal) {
    return (
      <div className="fatal">
        <p>API není dostupné.</p>
        <p className="dim">Spusť <code>npm run dev</code> (nebo <code>npm run dev:api</code>) v kořeni repozitáře.</p>
        <p className="dim">{fatal}</p>
        <button className="ghost" onClick={() => void refresh()}>Zkusit znovu</button>
      </div>
    )
  }

  // ── PRŮVODCE ZALOŽENÍ FIRMY (první obrazovka hry) ─────────────────────────
  if (setup && map && catalog.length > 0) {
    return (
      <SetupScreen
        startingCapital={health?.startingCapital ?? 0}
        plots={map.plots}
        catalog={catalog}
        onSkip={companies.length > 0
          ? () => { void selectCompany(companies[0].id); setSetup(false) }
          : undefined}
        onDone={(id) => { void selectCompany(String(id)); setSetup(false); setMode('game') }}
      />
    )
  }

  // ── HERNÍ POHLED (výchozí) ───────────────────────────────────────────────
  if (mode === 'game') {
    return (
      <>
      <GameView
        map={map}
        catalog={catalog}
        company={company}
        companies={companies}
        companyId={companyId}
        onSelectCompany={(id) => void selectCompany(id)}
        macro={macro}
        audit={audit}
        selectedPlot={selectedPlot}
        onSelectPlot={setSelectedPlot}
        onBuy={buyPlot}
        onBuild={buildAt}
        onNewCompany={() => setSetup(true)}
        onOpenTerminal={() => setMode('terminal')}
        onOpenResearch={() => setModal('research')}
        onOpenContracts={() => setModal('contracts')}
        onOpenFinance={() => setModal('finance')}
        onUpgrade={upgrade}
        onDemolish={demolish}
        onQuickSell={quickSell}
        onHireRoad={hireRoad}
        onOpenCodex={() => setMode('codex')}
        onSpeed={(sp) => void setSpeed(sp)}
        quests={quests}
        clock={clock}
        roadQuote={roadQuote}
        routes={routes}
        routeFrom={routeFrom}
        routeQuote={routeQuote}
        routeQuoteErr={routeQuoteErr}
        onRouteFrom={(p) => setRouteFrom(p)}
        onCreateRoute={createTransportRoute}
        onDeleteRoute={removeRoute}
        busy={actBusy}
        err={actErr}
      />
      {modal === 'research' && companyId && (
        <ResearchView companyId={companyId} onClose={() => setModal(null)}
          onChanged={() => { void refresh(); void refreshMap() }} />
      )}
      {modal === 'contracts' && companyId && (
        <ContractsView companyId={companyId} onClose={() => setModal(null)}
          onChanged={() => { void refresh(); void refreshMap() }} />
      )}
      {modal === 'finance' && companyId && (
        <FinanceView companyId={companyId} onClose={() => setModal(null)}
          onChanged={() => { void refresh(); void refreshMap() }} />
      )}
      </>
    )
  }

  // ── KNIHA (kodex) ────────────────────────────────────────────────────────
  if (mode === 'codex') {
    return (
      <CodexView
        recipes={codex?.recipes ?? []}
        inputs={codex?.inputs ?? []}
        catalog={catalog}
        onBack={() => setMode('game')}
      />
    )
  }

  // ── EXPERTNÍ TERMINÁL (obchodování) ──────────────────────────────────────
  return (
    <TerminalView
      macro={macro}
      audit={audit}
      health={health}
      items={items}
      itemCode={itemCode}
      onSelectItem={(c) => void selectItem(c)}
      book={book}
      fees={fees}
      companies={companies}
      companyId={companyId}
      onSelectCompany={(id) => void selectCompany(id)}
      company={company}
      orders={orders}
      trades={trades}
      busy={busy}
      history={history}
      onPlace={place}
      onCancel={(id) => void cancel(id)}
      onRefresh={() => void refresh()}
      onReset={() => void reset()}
      onOpenGame={() => setMode('game')}
      lastSync={lastSync}
      error={error}
    />
  )
}

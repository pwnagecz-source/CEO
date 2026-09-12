import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError, api,
  type Audit, type Book, type CatalogRow, type Company, type CompanySummary, type Item,
  type Macro, type MapData, type MapPlot, type OpenOrder, type PlaceOrderResult,
  type QuestState, type Trade,
} from './api'
import GameView from './components/GameView'
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
  const [selectedPlot, setSelectedPlot] = useState<MapPlot | null>(null)
  // Výchozí pohled je HRA. Terminál (expertní) je na jedno kliknutí, ale není to
  // první věc, kterou nový hráč uvidí.
  const [mode, setMode] = useState<'game' | 'terminal'>('game')
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
      const [h, m, a, it, cos, tr, mp, cat] = await Promise.all([
        api.health(), api.macro(), api.audit(), api.items(), api.companies(), api.trades(),
        api.map(), api.catalog(),
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
      setMap(mp)
      setCatalog(cat.buildings)
      setFatal(null)

      const cid = companyId ?? cos.companies[0]?.id ?? null
      if (cid) {
        setCompanyId(cid)
        const [co, oo, qs] = await Promise.all([
          api.company(cid), api.orders(cid), api.quests(cid),
        ])
        setCompany(co)
        setOrders(oo.orders)
        setQuests(qs)
      } else {
        setQuests(null)
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

  /** Přepne položku okamžitě, bez čekání na další poll. */
  async function selectItem(code: string) {
    setItemCode(code)
    try { setBook(await api.book(code)) } catch { /* poll to spraví */ }
  }

  async function selectCompany(id: string) {
    setCompanyId(id)
    try {
      const [co, oo] = await Promise.all([api.company(id), api.orders(id)])
      setCompany(co)
      setOrders(oo.orders)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Společný obal akcí ve hře: stavový text, chyba, refresh světa. */
  async function gameAction(label: string, fn: () => Promise<void>) {
    setActBusy(label); setActErr(null)
    try {
      await fn()
      await refresh()
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
      await refresh()
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
        onQuickSell={quickSell}
        quests={quests}
        busy={actBusy}
        err={actErr}
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

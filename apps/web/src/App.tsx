import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError, api,
  type Audit, type Book, type Company, type CompanySummary, type Item,
  type Macro, type MapData, type MapPlot, type OpenOrder, type PlaceOrderResult, type Trade,
} from './api'
import BookPanel from './components/BookPanel'
import GameView from './components/GameView'
import CompanyPanel from './components/CompanyPanel'
import Footer from './components/Footer'
import Header from './components/Header'
import ItemsPanel from './components/ItemsPanel'
import TradeTape from './components/TradeTape'

const POLL_MS = 2500
const DEFAULT_ITEM = 'log'

/**
 * Stav aplikace se drží v jednom místě a polluje se.
 *
 * Záměrně NE WebSocket: delta protokol s 250 ms koalescencí a 60fps
 * interpolací na klientu (doc 00, real-time ADR-002) přijde s produkčním
 * tickem. Pro ověření ekonomiky je polling dostatečný a hlavně debugovatelný —
 * každý refresh je kompletní snímek, ne sekvence delt, kterou by šlo ztratit.
 */
export default function App() {
  const [fatal, setFatal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [health, setHealth] = useState<{ worldId: number; engine: string; version?: string } | null>(null)
  const [macro, setMacro] = useState<Macro | null>(null)
  const [audit, setAudit] = useState<Audit | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [fees, setFees] = useState({ maker: 0.005, taker: 0.025 })
  const [companies, setCompanies] = useState<CompanySummary[]>([])
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [company, setCompany] = useState<Company | null>(null)
  const [orders, setOrders] = useState<OpenOrder[]>([])
  const [itemCode, setItemCode] = useState(DEFAULT_ITEM)
  const [map, setMap] = useState<MapData | null>(null)
  const [selectedPlot, setSelectedPlot] = useState<MapPlot | null>(null)
  // Výchozí pohled je HRA. Terminál (expertní) je na jedno kliknutí, ale není to
  // první věc, kterou nový hráč uvidí.
  const [mode, setMode] = useState<'game' | 'terminal'>('game')
  const [book, setBook] = useState<Book | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Ref, aby interval nevolal stale closure a aby se při ručním refresh
  // nezdvojil požadavek.
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const [h, m, a, it, cos, tr, mp] = await Promise.all([
        api.health(), api.macro(), api.audit(), api.items(), api.companies(), api.trades(),
        api.map(),
      ])
      setHealth({ worldId: h.worldId, engine: h.engine, version: h.version })
      setMacro(m)
      setAudit(a)
      setItems(it.items)
      setFees(it.fees)
      setCompanies(cos.companies)
      setTrades(tr.trades)
      setMap(mp)
      setFatal(null)

      const cid = companyId ?? cos.companies[0]?.id ?? null
      if (cid) {
        setCompanyId(cid)
        const [co, oo] = await Promise.all([api.company(cid), api.orders(cid)])
        setCompany(co)
        setOrders(oo.orders)
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

  const available = book && company
    ? (company.inventory.find((r) => r.item === book.item.code)?.available ?? 0)
    : 0

  // ── HERNÍ POHLED (výchozí) ───────────────────────────────────────────────
  if (mode === 'game') {
    return (
      <GameView
        map={map}
        company={company}
        companies={companies}
        companyId={companyId}
        onSelectCompany={(id) => void selectCompany(id)}
        macro={macro}
        audit={audit}
        selectedPlot={selectedPlot}
        onSelectPlot={setSelectedPlot}
        onOpenTerminal={() => setMode('terminal')}
      />
    )
  }

  // ── EXPERTNÍ TERMINÁL ────────────────────────────────────────────────────
  return (
    <div className="app">
      <Header
        macro={macro}
        audit={audit}
        worldId={health?.worldId ?? null}
        engine={health?.engine ?? null}
        version={health?.version ?? null}
        onRefresh={() => void refresh()}
        onReset={() => void reset()}
        onOpenGame={() => setMode('game')}
        busy={busy}
      />

      <div className="main">
        <div className="col">
          <section className="panel">
            <h2>
              Položky
              <span className="hint">{items.length} · klikni pro book</span>
            </h2>
            <div className="body" style={{ padding: 0 }}>
              <ItemsPanel items={items} selected={itemCode} onSelect={(c) => void selectItem(c)} />
            </div>
          </section>
        </div>

        <div className="col">
          <section className="panel">
            <BookPanel
              book={book}
              fees={fees}
              cash={company?.cash ?? 0}
              escrow={company?.escrow ?? 0}
              available={available}
              companyLabel={company?.name ?? '—'}
              busy={busy}
              onPlace={place}
            />
          </section>
          <section className="panel">
            <TradeTape trades={trades} />
          </section>
        </div>

        <div className="col">
          <section className="panel">
            <CompanyPanel
              companies={companies}
              selectedId={companyId}
              onSelect={(id) => void selectCompany(id)}
              company={company}
              orders={orders}
              busy={busy}
              onCancel={(id) => void cancel(id)}
            />
          </section>
        </div>
      </div>

      <Footer audit={audit} fees={fees} lastSync={lastSync} error={error} />
    </div>
  )
}

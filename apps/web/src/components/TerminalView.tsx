import { useMemo, useState } from 'react'
import type {
  Audit, Book, Company, CompanySummary, HistoryPoint, Item, Macro, OpenOrder,
  PlaceOrderResult, Trade,
} from '../api'
import { ago, money, price, qty } from '../fmt'
import BookPanel from './BookPanel'
import Footer from './Footer'
import Header from './Header'
import TerminalTutorial, { TUT_STEPS } from './TerminalTutorial'
import TradeTape from './TradeTape'

const TUT_KEY = 'ceo.tut.term.v1'

/** Mini graf vývoje ceny (mid po herních hodinách) — data z /api/market/:code/history. */
function PriceSpark({ history }: { history: HistoryPoint[] }) {
  const pts = history
    .map((h) => h.mid ?? h.last)
    .filter((v): v is number => v !== null)
  if (pts.length < 2) return null
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1
  const W = 240
  const H = 40
  const xy = pts.map((v, i) =>
    `${((i / (pts.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / span) * (H - 8)).toFixed(1)}`)
  const up = pts[pts.length - 1]! >= pts[0]!
  return (
    <div className="spark">
      <div className="spark__head">
        <span className="dim">historie ceny · {pts.length} herních hodin</span>
        <span className={up ? 'pos' : 'neg'}>
          {up ? '▲' : '▼'} {price(pts[pts.length - 1])}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="spark__svg">
        <polyline points={xy.join(' ')} fill="none"
          stroke={up ? '#3fb950' : '#f85149'} strokeWidth="1.6" />
      </svg>
    </div>
  )
}

type Props = {
  macro: Macro | null
  audit: Audit | null
  health: { worldId: number; engine: string; version?: string } | null
  items: Item[]
  itemCode: string
  onSelectItem: (code: string) => void
  book: Book | null
  fees: { maker: number; taker: number }
  companies: CompanySummary[]
  companyId: string | null
  onSelectCompany: (id: string) => void
  company: Company | null
  orders: OpenOrder[]
  trades: Trade[]
  busy: boolean
  history: HistoryPoint[]
  onPlace: (p: {
    side: 'buy' | 'sell'; qty: number; priceLimit: number | null
    orderType: 'limit' | 'market'
  }) => Promise<PlaceOrderResult | null>
  onCancel: (orderId: number) => void
  onRefresh: () => void
  onReset: () => void
  onOpenGame: () => void
  lastSync: Date | null
  error: string | null
}

const CAT_LABEL: Record<string, string> = {
  raw: 'suroviny', intermediate: 'polotovary', component: 'komponenty',
  final: 'finální', utility: 'utility',
}

const CAT_ORDER = ['raw', 'intermediate', 'component', 'final', 'utility']

/**
 * Expertní terminál — zúžen na to, k čemu slouží: OBCHODOVÁNÍ.
 *
 * Firma, sklad, budovy a pozemky žijí v herním pohledu (mapa + inspektor),
 * takže tady zůstává jen trh, kniha příkazů, tvoje příkazy a páska obchodů.
 * To je ta „hluboká“ vrstva ekonomiky pro hráče, kteří chtějí vidět bid/ask.
 */
export default function TerminalView({
  macro, audit, health, items, itemCode, onSelectItem, book, fees, companies, companyId,
  onSelectCompany, company, orders, trades, busy, history, onPlace, onCancel, onRefresh,
  onReset, onOpenGame, lastSync, error,
}: Props) {
  const [filter, setFilter] = useState('')

  // Tutoriál: poprvé automaticky (localStorage), jinak tlačítkem ✦.
  const [tut, setTut] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(TUT_KEY) === 'done' ? null : 0
  })
  const tutFinish = () => {
    setTut(null)
    if (typeof window !== 'undefined') window.localStorage.setItem(TUT_KEY, 'done')
  }
  const tutTarget = tut !== null ? TUT_STEPS[tut]?.target ?? null : null

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q
      ? items.filter((i) => i.name.toLowerCase().includes(q) || i.code.includes(q))
      : items
    return CAT_ORDER
      .map((cat) => ({ cat, rows: list.filter((i) => i.category === cat) }))
      .filter((g) => g.rows.length > 0)
  }, [items, filter])

  const available = book && company
    ? (company.inventory.find((r) => r.item === book.item.code)?.available ?? 0)
    : 0

  return (
    <div className="app">
      <Header
        macro={macro}
        audit={audit}
        worldId={health?.worldId ?? null}
        engine={health?.engine ?? null}
        version={health?.version ?? null}
        onRefresh={onRefresh}
        onReset={onReset}
        onOpenGame={onOpenGame}
        busy={busy}
      />

      <div className="term">
        <button className="ghost tut-reopen" title="Znovu otevřít průvodce terminálem"
          onClick={() => setTut(0)}>
          ✦ Tutoriál
        </button>
        {tut !== null && (
          <TerminalTutorial step={tut} onStep={setTut} onFinish={tutFinish} />
        )}
        {/* ── trh ─────────────────────────────────────────────────────────── */}
        <section data-tut="market"
          className={'panel term__market' + (tutTarget === 'market' ? ' tut-focus' : '')}>
          <h2>Trh<span className="hint">{items.length} položek</span></h2>
          <div className="body">
            <input
              className="term__search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Hledat položku…"
            />
            <div className="mkt">
              {grouped.map((g) => (
                <div key={g.cat} className="mkt__group">
                  <div className="mkt__cat">{CAT_LABEL[g.cat] ?? g.cat}</div>
                  {g.rows.map((it) => (
                    <button
                      key={it.id}
                      className={'mkt__row' + (it.code === itemCode ? ' is-sel' : '')}
                      onClick={() => onSelectItem(it.code)}
                    >
                      <span className="mkt__name">
                        {it.name}
                        {it.is_retail_product && <i className="tag-retail">retail</i>}
                      </span>
                      <span className="mkt__bid">{price(it.best_bid)}</span>
                      <span className="mkt__ask">{price(it.best_ask)}</span>
                    </button>
                  ))}
                </div>
              ))}
              {grouped.length === 0 && <div className="empty">nic nenalezeno</div>}
            </div>
          </div>
        </section>

        {/* ── kniha + formulář ────────────────────────────────────────────── */}
        <section data-tut="book"
          className={'panel term__book' + (tutTarget === 'book' ? ' tut-focus' : '')}>
          <PriceSpark history={history} />
          <BookPanel
            book={book}
            fees={fees}
            cash={company?.cash ?? 0}
            escrow={company?.escrow ?? 0}
            available={available}
            companyLabel={company?.name ?? '—'}
            busy={busy}
            onPlace={onPlace}
          />
        </section>

        {/* ── tvoje firma + příkazy + páska ───────────────────────────────── */}
        <div data-tut="side" className={'term__side' + (tutTarget === 'side' ? ' tut-focus' : '')}>
          <section className="panel">
            <h2>
              Tvoje firma
              <select
                className="term__co"
                value={companyId ?? ''}
                onChange={(e) => onSelectCompany(e.target.value)}
              >
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </h2>
            <div className="body">
              <div className="strip">
                <span>hotovost<b className="money">{money(company?.cash ?? 0)}</b></span>
                <span>v escrow<b>{money(company?.escrow ?? 0)}</b></span>
                <span>sklad<b>{money(company?.inventoryValue ?? 0)}</b></span>
              </div>
              <div className="chips">
                {(company?.inventory ?? []).length === 0 &&
                  <span className="dim">prázdný sklad</span>}
                {(company?.inventory ?? []).map((r) => (
                  <button key={`${r.item}-${r.quality_tier}`} className="chip"
                    title={`${r.name}: volné ${qty(r.available)}, rezervováno ${qty(r.reserved)}, hodnota ${money(r.value)}`}
                    onClick={() => onSelectItem(r.item)}>
                    {r.name} <b>{qty(r.available)}</b>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Moje příkazy<span className="hint">{orders.length}</span></h2>
            <div className="body">
              {orders.length === 0 && <div className="empty">žádné otevřené příkazy</div>}
              <div className="ords">
                {orders.map((o) => (
                  <div key={o.id} className="ord">
                    <span className={`ord__side ${o.side === 'buy' ? 'bid' : 'ask'}`}>
                      {o.side === 'buy' ? 'koupit' : 'prodat'}
                    </span>
                    <button className="ord__item" onClick={() => onSelectItem(o.item)}>
                      {o.item}
                    </button>
                    <span className="ord__px">{price(o.price_limit)}</span>
                    <span className="ord__qty">{qty(o.qty - o.qty_filled)}/{qty(o.qty)}</span>
                    <span className="ord__ago faint" title={o.created_at}>{ago(o.created_at)}</span>
                    <button className="x" disabled={busy} onClick={() => onCancel(Number(o.id))}
                      title="Zrušit a uvolnit escrow / rezervaci">✕</button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <TradeTape trades={trades} />
          </section>
        </div>
      </div>

      <Footer audit={audit} fees={fees} lastSync={lastSync} error={error} />
    </div>
  )
}

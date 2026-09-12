import { useEffect, useMemo, useState } from 'react'
import type { Book, PlaceOrderResult } from '../api'
import { estimateFill } from '../estimate'
import { money, pct, price, qty } from '../fmt'

type Props = {
  book: Book | null
  fees: { maker: number; taker: number }
  cash: number
  escrow: number
  available: number
  companyLabel: string
  busy: boolean
  onPlace: (p: {
    side: 'buy' | 'sell'; qty: number; priceLimit: number | null
    orderType: 'limit' | 'market'
  }) => Promise<PlaceOrderResult | null>
}

type Msg = { kind: 'ok' | 'err'; text: string; fills?: string[] } | null

const FEE_MIN = 0.01

/** Order book + zadání příkazu. */
export default function BookPanel({
  book, fees, cash, escrow, available, companyLabel, busy, onPlace,
}: Props) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit')
  const [qtyIn, setQtyIn] = useState('100')
  const [priceIn, setPriceIn] = useState('')
  const [msg, setMsg] = useState<Msg>(null)

  // Když uživatel přepne položku, nabídni cenu z booku — jinak by musel hádat.
  useEffect(() => {
    if (!book) return
    setPriceIn(String(side === 'buy' ? (book.bestAsk ?? book.mid ?? '') : (book.bestBid ?? book.mid ?? '')))
    setQtyIn((q) => (Number(q) > 0 ? q : '100'))
    setMsg(null)
    // záměrně jen při změně položky, ne při každém přepnutí strany
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.item.code])

  const q = Number(qtyIn)
  const limit = priceIn.trim() === '' ? null : Number(priceIn)
  const effLimit = orderType === 'market' ? null : limit

  const est = useMemo(() => {
    if (!book || !(q > 0)) return null
    return estimateFill(book, side, q, effLimit, fees.taker, FEE_MIN)
  }, [book, side, q, effLimit, fees.taker])

  // Nekřížící limitní příkaz zůstane v booku → platí se maker sazba z notionalu.
  const rests = orderType === 'limit' && (est === null || est.filled <= 0) && effLimit !== null
  const notional = rests && effLimit !== null ? q * effLimit : (est?.gross ?? 0)
  const estFee = rests ? Math.max(FEE_MIN, notional * fees.maker) : (est?.fee ?? 0)
  const estTotal = notional + estFee

  const maxDepth = Math.max(
    1,
    ...(book?.bids ?? []).map((l) => l.total),
    ...(book?.asks ?? []).map((l) => l.total),
  )

  // Kontrola pokrytí dřív, než to odmítne DB (accounts_no_overdraft).
  let blocker: string | null = null
  if (side === 'buy' && estTotal > cash + 1e-9) {
    blocker = `nedostatek hotovosti: potřeba ${money(estTotal)}, k dispozici ${money(cash)}`
  } else if (side === 'sell' && q > available + 1e-9) {
    blocker = `nedostatek zboží: volných ${qty(available)} ${book?.item.code ?? ''}, zadáno ${qty(q)}`
  } else if (orderType === 'limit' && (limit === null || !(limit > 0))) {
    blocker = 'limitní příkaz potřebuje kladnou cenu'
  } else if (!(q > 0)) {
    blocker = 'zadej množství'
  } else if (book && q < book.item.minLot) {
    blocker = `minimální lot je ${qty(book.item.minLot)}`
  }

  async function submit() {
    setMsg(null)
    let r: PlaceOrderResult | null
    try {
      r = await onPlace({ side, qty: q, priceLimit: effLimit, orderType })
    } catch (e) {
      // Sem dopadne i odmítnutí přímo z databáze (overdraft, nedostatek zásob,
      // nevyrovnaný ledger). To není „500 internal“ — to je herní pravidlo,
      // které hráči patří ukázat doslova.
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!r) {
      setMsg({ kind: 'err', text: 'příkaz se nepodařilo zadat (detail viz log serveru)' })
      return
    }
    if (r.fills.length > 0) {
      setMsg({
        kind: 'ok',
        text: `#${r.orderId} ${r.status.toUpperCase()} · zobchodováno ${qty(r.qtyFilled)} ` +
              `průměrně za ${price(r.avgPrice)} · poplatky ${money(r.totalFees)}`,
        fills: r.fills.map((f) =>
          `${qty(f.qty)} × ${price(f.price)} = ${money(f.gross)} ` +
          `(kupující ${money(f.feeBuyer)} / prodávající ${money(f.feeSeller)}) → protistrana #${f.counterparty}`),
      })
    } else {
      setMsg({
        kind: 'ok',
        text: `#${r.orderId} ${r.status.toUpperCase()} · čeká v booku ` +
              `· zablokováno ${money(r.stillLocked)}`,
      })
    }
  }

  return (
    <>
      <h2>
        Order book — {book ? `${book.item.name} (${book.item.code})` : '…'}
        {book && <span className="hint">tier {book.qualityTier} · {book.item.category}</span>}
        <span className="spacer" />
        {book && <span className="hint">poslední: {price(book.lastPrice)} · TWAP 30d: {price(book.twap30d)}</span>}
      </h2>

      <div className="body">
        <div className="book">
          <div className="side">
            <h3>Bidy — poptávka</h3>
            {(book?.bids.length ?? 0) === 0 && <div className="empty">nikdo nenakupuje</div>}
            {(book?.bids ?? []).slice(0, 12).map((l) => (
              <div className="lvl b" key={`b${l.price}`}>
                <div className="bar" style={{ width: `${(l.total / maxDepth) * 100}%` }} />
                <span className="p">{price(l.price)}</span>
                <span className="q">{qty(l.qty)}</span>
                <span className="t">{l.orders}× / {qty(l.total)}</span>
              </div>
            ))}
          </div>
          <div className="side">
            <h3>Asky — nabídka</h3>
            {(book?.asks.length ?? 0) === 0 && <div className="empty">nikdo neprodává</div>}
            {(book?.asks ?? []).slice(0, 12).map((l) => (
              <div className="lvl a" key={`a${l.price}`}>
                <div className="bar" style={{ width: `${(l.total / maxDepth) * 100}%`, right: 0, left: 'auto' }} />
                <span className="p">{price(l.price)}</span>
                <span className="q">{qty(l.qty)}</span>
                <span className="t">{l.orders}× / {qty(l.total)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="spread-row">
          <span>bid <b className="bid num">{price(book?.bestBid)}</b></span>
          <span>mid <b className="num">{price(book?.mid)}</b></span>
          <span>ask <b className="ask num">{price(book?.bestAsk)}</b></span>
          <span>spread <b className="num">{price(book?.spread)}{book?.bestBid && book?.spread
            ? ` (${pct(book.spread / book.bestBid, 1)})` : ''}</b></span>
        </div>

        <div className="form">
          <div className="field">
            <label>Strana</label>
            <div className="seg">
              <button
                className={side === 'buy' ? 'on-buy' : ''}
                onClick={() => { setSide('buy'); setPriceIn(String(book?.bestAsk ?? book?.mid ?? '')) }}
              >Koupit</button>
              <button
                className={side === 'sell' ? 'on-sell' : ''}
                onClick={() => { setSide('sell'); setPriceIn(String(book?.bestBid ?? book?.mid ?? '')) }}
              >Prodat</button>
            </div>
          </div>

          <div className="field">
            <label>Typ příkazu</label>
            <div className="seg">
              <button
                className={orderType === 'limit' ? 'on-buy' : ''}
                onClick={() => setOrderType('limit')}
              >Limit</button>
              <button
                className={orderType === 'market' ? 'on-sell' : ''}
                onClick={() => setOrderType('market')}
                title="Immediate-or-cancel: smete book a zbytek se zruší"
              >Market (IOC)</button>
            </div>
          </div>

          <div className="field">
            <label>Množství {book ? `(min. lot ${qty(book.item.minLot)})` : ''}</label>
            <input
              type="number" min={0} step={book?.item.minLot ?? 1}
              value={qtyIn} onChange={(e) => setQtyIn(e.target.value)}
            />
          </div>

          <div className="field">
            <label>
              {orderType === 'market' ? 'Cena (tržní)' : `Cena (tick ${price(book?.item.tickSize ?? 0.001)})`}
            </label>
            <input
              type="number" min={0} step={book?.item.tickSize ?? 0.001}
              value={priceIn} disabled={orderType === 'market'}
              onChange={(e) => setPriceIn(e.target.value)}
              placeholder={orderType === 'market' ? 'smete book' : ''}
            />
          </div>

          <div className="estimate">
            <span>odhad exekuce: <b>{est && est.filled > 0 ? `${qty(est.filled)} z ${qty(q)}` : (rests ? 'zůstane v booku' : 'nic')}</b></span>
            <span>prům. cena: <b>{price(est?.avgPrice ?? effLimit)}</b></span>
            <span>hladin booku: <b>{rests ? 0 : (est?.levels ?? 0)}</b></span>
            <span>hrubě: <b>{money(notional)}</b></span>
            <span>poplatek ({rests ? `maker ${pct(fees.maker, 1)}` : `taker ${pct(fees.taker, 1)}`}): <b>{money(estFee)}</b></span>
            <span>celkem: <b>{money(estTotal)}</b></span>
          </div>

          {msg && (
            <div className={`msg ${msg.kind}`}>
              <div className="ttl">{msg.text}</div>
              {msg.fills && msg.fills.length > 0 && (
                <ul>{msg.fills.map((f, i) => <li key={i}>{f}</li>)}</ul>
              )}
            </div>
          )}

          <div className="actions">
            <button
              className={`primary ${side}`}
              disabled={busy || blocker !== null}
              onClick={submit}
            >
              {side === 'buy' ? 'Koupit' : 'Prodat'} {qty(q > 0 ? q : 0)} {book?.item.code ?? ''}
            </button>
          </div>

          {blocker && <div className="msg err"><div className="ttl">{blocker}</div></div>}

          <div className="estimate" style={{ gridColumn: '1 / -1' }}>
            <span>{companyLabel}: cash <b className="num">{money(cash)}</b></span>
            <span>v escrow <b className="num">{money(escrow)}</b></span>
            <span>volné zboží <b className="num">{qty(available)}</b></span>
          </div>
        </div>
      </div>
    </>
  )
}

import type { Company, CompanySummary, OpenOrder } from '../api'
import { ago, compact, money, price, qty } from '../fmt'

type Props = {
  companies: CompanySummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  company: Company | null
  orders: OpenOrder[]
  busy: boolean
  onCancel: (orderId: number) => void
}

const PLOT_LABEL: Record<string, string> = {
  industrial: 'průmysl', commercial: 'komerce', forest: 'les', mine: 'důl',
  water: 'voda', utility: 'utility', civic: 'občanská',
}

/**
 * Panel jedné firmy: rozvaha, sklad, budovy a otevřené příkazy.
 *
 * `ledgerCash` je zůstatek čtený z podvojného ledgeru, `cash` je součet účtů
 * přes JOIN — kdyby se lišily, někde je leak. UI je vypisuje vedle sebe jako
 * lacinou kontrolu navíc (DB to hlídá fn_audit_balance_drift()).
 */
export default function CompanyPanel({
  companies, selectedId, onSelect, company, orders, busy, onCancel,
}: Props) {
  const drift = company ? Math.abs(company.cash - company.ledgerCash) : 0

  return (
    <>
      <h2>
        Firma
        <select
          value={selectedId ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          style={{ marginLeft: 'auto', width: 'auto', padding: '2px 6px', fontSize: 11.5 }}
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.industry}
            </option>
          ))}
        </select>
      </h2>

      {!company && <div className="empty">načítám…</div>}

      {company && (
        <div className="body">
          <div className="estimate" style={{ marginBottom: 10 }}>
            <span>hotovost <b>{money(company.cash)}</b></span>
            <span>v escrow <b>{money(company.escrow)}</b></span>
            <span>hodnota skladu <b>{money(company.inventoryValue)}</b></span>
            <span>
              čistá pozice <b>{money(company.cash + company.escrow + company.inventoryValue)}</b>
            </span>
            <span>
              ledger vs. účty{' '}
              <b className={drift > 0.000001 ? 'ask' : 'bid'}>
                {drift > 0.000001 ? `DRIFT ${money(drift)}` : 'sedí'}
              </b>
            </span>
          </div>

          <h3 style={{ margin: '4px 0 2px', fontSize: 10, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
            Sklad
          </h3>
          <table>
            <thead>
              <tr>
                <th>Položka</th><th>Množství</th><th>Rezervováno</th>
                <th>Volné</th><th>Mid</th><th>Hodnota</th>
              </tr>
            </thead>
            <tbody>
              {company.inventory.length === 0 && (
                <tr><td className="name dim" colSpan={6}>prázdný sklad</td></tr>
              )}
              {company.inventory.map((r) => (
                <tr key={`${r.item}-${r.quality_tier}`}>
                  <td className="name">
                    {r.name}<span className="tier-pill">T{r.tier}</span>
                    {r.quality_tier !== 1 && <span className="tier-pill">q{r.quality_tier}</span>}
                  </td>
                  <td>{qty(r.quantity)}</td>
                  <td className={r.reserved > 0 ? 'warn' : 'faint'} style={{ color: r.reserved > 0 ? 'var(--warn)' : undefined }}>
                    {qty(r.reserved)}
                  </td>
                  <td>{qty(r.available)}</td>
                  <td className="faint">{price(r.mid_price)}</td>
                  <td>{money(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ margin: '12px 0 2px', fontSize: 10, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
            Budovy a pozemky ({company.plots.length} / 288)
          </h3>
          <table>
            <thead>
              <tr>
                <th>Budova</th><th>Pozemek</th><th>Lvl</th>
                <th>Průchodnost</th><th>Údržba/h</th><th>Výstup</th>
              </tr>
            </thead>
            <tbody>
              {company.buildings.map((b) => (
                <tr key={b.id}>
                  <td className="name">{b.name}</td>
                  <td className="faint" title={`${PLOT_LABEL[b.plot] ?? b.plot} [${b.x}, ${b.y}]`}>
                    [{b.x},{b.y}]
                  </td>
                  <td>{b.level}</td>
                  <td>{qty(b.throughput)}</td>
                  <td className="ask">{money(b.upkeep)}</td>
                  <td className="dim">{b.output_item ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ margin: '12px 0 2px', fontSize: 10, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
            Otevřené příkazy ({orders.length})
          </h3>
          <table>
            <thead>
              <tr>
                <th>Položka</th><th>Strana</th><th>Cena</th>
                <th>Zbývá</th><th>Zadáno</th><th />
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr><td className="name dim" colSpan={6}>žádné otevřené příkazy</td></tr>
              )}
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="name">{o.item}</td>
                  <td className={o.side === 'buy' ? 'bid' : 'ask'}>
                    {o.side === 'buy' ? 'buy' : 'sell'}
                  </td>
                  <td>{price(o.price_limit)}</td>
                  <td>{qty(o.qty - o.qty_filled)}</td>
                  <td className="faint" title={o.created_at}>{ago(o.created_at)}</td>
                  <td>
                    <button className="x" disabled={busy} onClick={() => onCancel(Number(o.id))}
                            title="Zrušit a uvolnit escrow / rezervaci">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="body faint" style={{ fontSize: 11 }}>
        Svět má {compact(companies.length)} demo firem, 288 pozemků v mřížce 24×12
        (ADR-001) a 25 položek. Peníze vznikají jen retail prodejem NPC a státními
        zakázkami, zanikají jen poplatky, daněmi, mzdami a údržbou.
      </div>
    </>
  )
}

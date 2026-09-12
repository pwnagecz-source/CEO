import type { Item } from '../api'
import { pct, price } from '../fmt'

type Props = {
  items: Item[]
  selected: string
  onSelect: (code: string) => void
}

const CAT_LABEL: Record<string, string> = {
  raw: 'surovina',
  intermediate: 'polotovar',
  component: 'komponent',
  final: 'finální',
  utility: 'utilita',
}

/**
 * Přehled trhu. Tohle je hlavní obrazovka hry: každá položka ukazuje reálný
 * bid/ask z CLOBu. Není tu žádná NPC cena — když nikdo neprodává dřevo,
 * dřevo není (ADR-011: hluboký CLOB, žádné fixní NPC výkupy).
 */
export default function ItemsPanel({ items, selected, onSelect }: Props) {
  if (items.length === 0) return <div className="empty">načítám položky…</div>

  return (
    <table>
      <thead>
        <tr>
          <th>Položka</th>
          <th>Bid</th>
          <th>Ask</th>
          <th>Spread</th>
          <th>Posl.</th>
          <th title="Referenční cena z balančního modelu, ne z booku">Ref.</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => {
          const spreadPct = it.best_bid && it.best_ask
            ? (it.best_ask - it.best_bid) / ((it.best_ask + it.best_bid) / 2)
            : null
          return (
            <tr
              key={it.id}
              className={`clickable${it.code === selected ? ' sel' : ''}`}
              onClick={() => onSelect(it.code)}
              title={`${it.name} · ${CAT_LABEL[it.category] ?? it.category} · tier ${it.tier}`}
            >
              <td className="name">
                {it.name}
                <span className="tier-pill">T{it.tier}</span>
                {it.is_retail_product && <span className="tier-pill" title="Prodává se NPC zákazníkům — faucet peněz">retail</span>}
              </td>
              <td className="bid">{price(it.best_bid)}</td>
              <td className="ask">{price(it.best_ask)}</td>
              <td className={spreadPct !== null && spreadPct > 0.15 ? 'ask' : 'faint'}>
                {spreadPct === null ? '—' : pct(spreadPct, 1)}
              </td>
              <td>{price(it.last_price)}</td>
              <td className="faint">{price(it.base_price)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

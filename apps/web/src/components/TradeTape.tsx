import type { Trade } from '../api'
import { ago, money, price, qty } from '../fmt'

type Props = { trades: Trade[] }

/**
 * Páska obchodů. Každý řádek je append-only záznam z tabulky `trades` —
 * stejná data, ze kterých se počítá TWAP a CPI koš.
 */
export default function TradeTape({ trades }: Props) {
  return (
    <>
      <h2>
        Páska obchodů
        <span className="hint">{trades.length} posledních</span>
      </h2>
      <div className="body" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Čas</th><th>Položka</th><th>Cena</th>
              <th>Množství</th><th>Hrubě</th><th>Kupující → Prodávající</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && (
              <tr>
                <td className="name dim" colSpan={6}>
                  zatím žádný obchod — zkus poslat market příkaz proti asku
                </td>
              </tr>
            )}
            {trades.map((t) => (
              <tr key={t.id}>
                <td className="faint" title={t.executed_at}>{ago(t.executed_at)}</td>
                <td className="name">{t.item}{t.quality_tier !== 1 && <span className="tier-pill">q{t.quality_tier}</span>}</td>
                <td>{price(t.price)}</td>
                <td>{qty(t.qty)}</td>
                <td>{money(t.gross)}</td>
                <td className="name dim">{t.buyer} → {t.seller}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

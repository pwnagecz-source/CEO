import type { Book, BookLevel } from './api'

export type Estimate = {
  /** Kolik by se skutečně zobchodovalo proti aktuálnímu booku. */
  filled: number
  gross: number
  avgPrice: number | null
  fee: number
  /** Kolik hladin booku by příkaz prošel. */
  levels: number
  /** Vyplnilo by se celé zadané množství? */
  complete: boolean
  /** Odhad „proč ne“ — chybí protistrana, nebo je cena mimo limit. */
  reason: 'ok' | 'no_liquidity' | 'price_out_of_limit' | 'partial'
}

/**
 * Odhad exekuce proti aktuálnímu booku — stejná logika jako matching engine
 * (price-time priority, cena MAKERA), jen na straně klienta a bez exekuce.
 *
 * Slouží dvěma účelům: ukázat hráči dopad příkazu dřív, než ho odešle (hlavně
 * u market orderů, které mohou projet několik hladin), a odhalit, že zadaná
 * cena limitu vůbec nekříží book.
 *
 * Nepočítá s anti-wash filtrem — vlastní příkazy firmy v booku by ve skutečnosti
 * přeskočil, takže odhad může být mírně optimistický.
 */
export function estimateFill(
  book: Book,
  side: 'buy' | 'sell',
  qty: number,
  priceLimit: number | null,
  feeRate: number,
  feeMin: number,
): Estimate {
  const empty: Estimate = {
    filled: 0, gross: 0, avgPrice: null, fee: 0, levels: 0, complete: false,
    reason: 'no_liquidity',
  }
  if (!(qty > 0)) return empty

  // buy sbírá asky od nejnižšího, sell bidy od nejvyššího — book je seřazený
  const levels: BookLevel[] = side === 'buy' ? book.asks : book.bids
  if (levels.length === 0) return empty

  let need = qty
  let gross = 0
  let used = 0

  for (const lvl of levels) {
    if (need <= 1e-9) break
    // limitní příkaz nesmí nakoupit dráž / prodat levněji, než je jeho limit
    if (priceLimit !== null) {
      if (side === 'buy' && lvl.price > priceLimit) break
      if (side === 'sell' && lvl.price < priceLimit) break
    }
    const take = Math.min(need, lvl.qty)
    gross += take * lvl.price
    need -= take
    used += 1
  }

  const filled = qty - need
  if (filled <= 1e-9) {
    return {
      ...empty,
      reason: priceLimit === null ? 'no_liquidity' : 'price_out_of_limit',
    }
  }

  return {
    filled,
    gross,
    avgPrice: gross / filled,
    fee: Math.max(feeMin, gross * feeRate),
    levels: used,
    complete: need <= 1e-9,
    reason: need <= 1e-9 ? 'ok' : 'partial',
  }
}

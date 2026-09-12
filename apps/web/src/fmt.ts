/** Formátování čísel. Peníze a množství mají jinou přesnost — v ekonomické hře
 *  je „0.115“ a „0.12“ rozdíl, takže žádné agresivní zaokrouhlování. */

const nf = (min: number, max: number) =>
  new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: min, maximumFractionDigits: max })

export const money = (x: number | null | undefined): string =>
  x == null || Number.isNaN(x) ? '—' : nf(2, 2).format(x)

/** Cena za kus — až 4 desetinná místa (tick_size bývá 0.001 a méně). */
export const price = (x: number | null | undefined): string =>
  x == null || Number.isNaN(x) ? '—' : nf(4, 4).format(x)

export const qty = (x: number | null | undefined): string =>
  x == null || Number.isNaN(x) ? '—' : nf(0, 2).format(x)

export const compact = (x: number | null | undefined): string => {
  if (x == null || Number.isNaN(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1e9) return `${nf(2, 2).format(x / 1e9)} mld`
  if (a >= 1e6) return `${nf(2, 2).format(x / 1e6)} mil`
  if (a >= 1e4) return nf(0, 0).format(x)
  return nf(2, 2).format(x)
}

export const pct = (x: number | null | undefined, digits = 2): string =>
  x == null || Number.isNaN(x) ? '—' : `${nf(digits, digits).format(x * 100)} %`

export const ago = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'teď'
  if (s < 60) return `před ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `před ${m} min`
  return new Date(iso).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
}

export const clock = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString('cs-CZ', { hour12: false }) : '—'

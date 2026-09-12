/**
 * Art direction izometrické mapy.
 *
 * Cíl je „diorama“ ve stylu Stronghold Crusaders / Capital Rift: čitelný terén,
 * budovy jako izometrické hranoly s nasvícenými stěnami, žádné nahodilé barvy.
 *
 * Důležité pravidlo z první vizuální kontroly: **biom musí být čitelný i na
 * nevlastněných dlaždicích.** Kdyby volné pozemky byly jednotně šedé, mapa by
 * vypadala jako prázdná plocha a les/vida/důl by zmizely. Proto volné dlaždice
 * berou stejnou barvu biomu, jen ztmavenou — vlastnictví se pozná podle obrysu
 * a plného jasu, ne podle toho, že by se změnil biom.
 */

export type Terrain = { fill: string; edge: string; label: string }

/** Plné (vlastněné) barvy biomů. Záměrně sytější, aby mapa působila jako krajina. */
export const TERRAIN: Record<string, Terrain> = {
  forest:     { fill: '#3a5c3d', edge: '#54804f', label: 'les' },
  mine:       { fill: '#5c4f42', edge: '#7a6855', label: 'důl / lom' },
  water:      { fill: '#2e5d80', edge: '#4a81a8', label: 'voda' },
  utility:    { fill: '#4a5058', edge: '#656d78', label: 'energetika' },
  industrial: { fill: '#51564c', edge: '#6d7365', label: 'průmysl' },
  commercial: { fill: '#5c5340', edge: '#7d7055', label: 'komerce' },
  civic:      { fill: '#544c60', edge: '#716782', label: 'občanské' },
}

export const FALLBACK_TERRAIN: Terrain = { fill: '#3a3f47', edge: '#4d545e', label: 'terén' }

/** Ztmavení hex barvy (0..1). Používáme pro nevlastněné dlaždice. */
export function shade(hex: string, f: number): string {
  const n = hex.replace('#', '')
  const ch = (i: number) => Math.max(0, Math.min(255, Math.round(parseInt(n.slice(i, i + 2), 16) * f)))
  return `#${[0, 2, 4].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Barva dlaždice. Vlastněná = plný jas; volná = stejný biom ztmavený, aby svět
 * vypadal jako krajina a ne jako šedá tabule.
 */
export function terrainFor(type: string, owned: boolean): Terrain {
  const base = TERRAIN[type] ?? FALLBACK_TERRAIN
  if (owned) return base
  return { fill: shade(base.fill, 0.5), edge: shade(base.edge, 0.45), label: base.label }
}

/** Barvy budov podle odvětví — hráč pozná obor na první pohled. */
export type BuildingSkin = { wall: string; wallDark: string; roof: string; glow?: string }

export const INDUSTRY_SKIN: Record<string, BuildingSkin> = {
  timber:     { wall: '#a07c4e', wallDark: '#7c5f3a', roof: '#c09a68' },
  metallurgy: { wall: '#7d8492', wallDark: '#5f6570', roof: '#9aa2b0', glow: '#ff9d5c' },
  food:       { wall: '#b09c56', wallDark: '#8a7a42', roof: '#d3bc74' },
  energy:     { wall: '#69798a', wallDark: '#505c69', roof: '#8ba0b4', glow: '#ffd45e' },
}

export const DEFAULT_SKIN: BuildingSkin = { wall: '#8a8e97', wallDark: '#6b6f78', roof: '#a8aeb9' }

/** Retail dostane výkladec (markýzu) — to je ten „obchod“ z Capital Rift. */
export const RETAIL_SKIN: BuildingSkin = { wall: '#b06459', wallDark: '#8a4d45', roof: '#e0937f', glow: '#ffd45e' }

export function skinFor(industry: string | null, retail: boolean | null): BuildingSkin {
  if (retail) return RETAIL_SKIN
  return (industry && INDUSTRY_SKIN[industry]) || DEFAULT_SKIN
}

/** Stav budovy → vizuální akcent. */
export const STATUS_GLOW: Record<string, string> = {
  producing: '#35d07f',
  construction: '#ffb84e',
  starved: '#ff6b6b',
  full: '#4ea8ff',
  idle: '#8794a8',
  paused: '#5d6878',
}

/**
 * Art direction izometrické mapy.
 *
 * Cíl je „diorama“ ve stylu Stronghold Crusaders / Capital Rift: čitelný terén,
 * budovy jako izometrické hranoly s nasvícenými stěnami, žádné nahodilé barvy.
 *
 * Důležité pravidlo z první vizuální kontroly: **biom musí být čitelný i na
 * nevlastněných dlaždicích.** Kdyby volné pozemky byly jednotně šedé, mapa by
 * vypadala jako prázdná plocha a les/voda/důl by zmizely. Proto volné dlaždice
 * berou stejnou barvu biomu, jen ztmavenou — vlastnictví se pozná podle obrysu
 * a plného jasu, ne podle toho, že by se změnil biom.
 *
 * Paleta ladí s design systémem v `styles.css` (tmavá modř pozadí, azurové a
 * fialové akcenty, smaragdová = „v pořádku / vyrábí“, korálová = problém).
 */

export type Terrain = { fill: string; edge: string; label: string }

/** Plné (vlastněné) barvy biomů. Záměrně sytější, aby mapa působila jako krajina. */
export const TERRAIN: Record<string, Terrain> = {
  forest:     { fill: '#3d7a4f', edge: '#5cab6c', label: 'les' },
  mine:       { fill: '#7d6247', edge: '#a88259', label: 'důl / lom' },
  water:      { fill: '#2f6f9c', edge: '#4d99c9', label: 'voda' },
  utility:    { fill: '#6a5c96', edge: '#8f7fc4', label: 'energetika' },
  industrial: { fill: '#59626f', edge: '#7c8794', label: 'průmysl' },
  commercial: { fill: '#a08346', edge: '#cba85f', label: 'komerce' },
  civic:      { fill: '#5d6b8a', edge: '#8291b3', label: 'občanské' },
}

export const FALLBACK_TERRAIN: Terrain = { fill: '#3d4450', edge: '#545c6a', label: 'terén' }

/** Ztmavení / zesvětlení hex barvy (0..1). Používáme pro nevlastněné dlaždice. */
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
  return { fill: shade(base.fill, 0.55), edge: shade(base.edge, 0.5), label: base.label }
}

/** Barvy budov podle odvětví — hráč pozná obor na první pohled. */
export type BuildingSkin = { wall: string; wallDark: string; roof: string; glow?: string }

export const INDUSTRY_SKIN: Record<string, BuildingSkin> = {
  agriculture:  { wall: '#b8a05a', wallDark: '#8e7a42', roof: '#d9c078' },
  mining:       { wall: '#8a7358', wallDark: '#6a5843', roof: '#a98f6e', glow: '#ffc266' },
  timber:       { wall: '#a37c4d', wallDark: '#7d5e39', roof: '#c69d68' },
  energy:       { wall: '#6b7f95', wallDark: '#515f70', roof: '#8ea7bf', glow: '#ffd45e' },
  construction: { wall: '#9a9384', wallDark: '#767063', roof: '#bdb4a2' },
  food:         { wall: '#c08a63', wallDark: '#96694a', roof: '#e0ab80', glow: '#ffd45e' },
  metallurgy:   { wall: '#7f8794', wallDark: '#60666f', roof: '#9da6b3', glow: '#ff9d5c' },
  textiles:     { wall: '#9a7fa8', wallDark: '#77607f', roof: '#bd9ecb' },
  manufacturing:{ wall: '#7d8a9c', wallDark: '#5e697a', roof: '#a0aec2', glow: '#58a6ff' },
  electronics:  { wall: '#5f8f9c', wallDark: '#476d78', roof: '#7fb3c0', glow: '#58a6ff' },
}

export const DEFAULT_SKIN: BuildingSkin = { wall: '#8d929c', wallDark: '#6c717b', roof: '#abb1bc' }

/** Retail dostane výkladec (markýzu) — to je ten „obchod“ z Capital Rift. */
export const RETAIL_SKIN: BuildingSkin = { wall: '#b8655a', wallDark: '#8e4c43', roof: '#e79883', glow: '#ffd45e' }

export function skinFor(industry: string | null, retail: boolean | null): BuildingSkin {
  if (retail) return RETAIL_SKIN
  return (industry && INDUSTRY_SKIN[industry]) || DEFAULT_SKIN
}

/** Stav budovy → vizuální akcent (stejné barvy jako badge v HUD). */
export const STATUS_GLOW: Record<string, string> = {
  producing: '#3ddc97',
  construction: '#ffc266',
  starved: '#ff6b7d',
  full: '#58a6ff',
  idle: '#93a1bd',
  paused: '#61708c',
}

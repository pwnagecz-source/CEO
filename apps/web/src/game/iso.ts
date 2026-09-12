/**
 * Izometrická projekce (2:1 diamond), stejný princip jako Stronghold Crusaders
 * nebo mapa Capital Rift — akorát místo předrenderovaných spritů kreslíme
 * vektorově, takže mapa je ostrá v každém zoomu a každá dlaždice je klikací.
 */

export const TILE_W = 64
export const TILE_H = 32
/** Výška jedné „úrovně“ budovy v px. */
export const FLOOR_H = 14

export type Pt = { x: number; y: number }

/** Střed dlaždice (x, y) v izometrických souřadnicích. */
export function tileCenter(x: number, y: number): Pt {
  return {
    x: ((x - y) * TILE_W) / 2,
    y: ((x + y) * TILE_H) / 2,
  }
}

/** Kosočtverec dlaždice se středem v (cx, cy). */
export function diamond(cx: number, cy: number, w = TILE_W, h = TILE_H): string {
  return [
    `${cx},${cy - h / 2}`,
    `${cx + w / 2},${cy}`,
    `${cx},${cy + h / 2}`,
    `${cx - w / 2},${cy}`,
  ].join(' ')
}

/** Posun bodu „nahoru“ o výšku (v izometrii = jen −y). */
export const up = (p: Pt, h: number): Pt => ({ x: p.x, y: p.y - h })

/** Hrany kosočtverce jako body, pro stavění stěn budov. */
export function diamondPoints(cx: number, cy: number, w = TILE_W, h = TILE_H) {
  return {
    top: { x: cx, y: cy - h / 2 },
    right: { x: cx + w / 2, y: cy },
    bottom: { x: cx, y: cy + h / 2 },
    left: { x: cx - w / 2, y: cy },
  }
}

export function poly(pts: Pt[]): string {
  return pts.map((p) => `${p.x},${p.y}`).join(' ')
}

/**
 * Obal celé mřížky (viewBox). Počítá s tím, že budovy trčí nahoru, takže
 * přidává rezervu nad horní hranou.
 */
export function gridBounds(w: number, h: number, maxHeight = 90) {
  const xs: number[] = []
  const ys: number[] = []
  for (const [gx, gy] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
    const c = tileCenter(gx, gy)
    xs.push(c.x - TILE_W / 2, c.x + TILE_W / 2)
    ys.push(c.y - TILE_H / 2, c.y + TILE_H / 2)
  }
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    x: minX - 8,
    y: minY - maxHeight - 8,
    width: maxX - minX + 16,
    height: maxY - minY + maxHeight + 16,
  }
}

/**
 * Barva firmy odvozená deterministicky z id, aby měl každý hráč stabilní
 * barvu napříč mapou, legendou i order bookem.
 */
const OWNER_PALETTE = [
  '#4ea8ff', '#35d07f', '#ffb84e', '#ff6b9d', '#b48cff', '#3fd6c8', '#ff8f5e', '#9adf4e',
]
export function ownerColor(ownerId: string | null): string {
  if (!ownerId) return 'transparent'
  let h = 0
  for (let i = 0; i < ownerId.length; i++) h = (h * 31 + ownerId.charCodeAt(i)) >>> 0
  return OWNER_PALETTE[h % OWNER_PALETTE.length] ?? '#4ea8ff'
}

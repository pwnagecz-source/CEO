/**
 * Izometrická mapa světa — Canvas 2D renderer.
 *
 * Proč canvas a ne SVG: svět má 2 048+ dlaždic a každá měla v DOM ~10–15
 * elementů (terén, detail, obrys, budova, okna…). To je ~25 000 uzlů, které
 * prohlížeč musí layoutovat a malovat — mapa se při každém pollu a hoveru
 * sekala. Canvas je JEDEN element:
 *
 *   - **terénní vrstva** se předrenderuje do offscreen canvasu a překreslí
 *     se, JEN když se obsah mapy skutečně změní (porovnává se signature),
 *   - **budovy, doprava a výběr** se malují každým snímkem, ale jen v
 *     viditelném okně (viewport culling inverzní izometrií),
 *   - React se překresluje jen při výměně dat, ne při pohybu kamery —
 *     zoom/pan žijí v refu a rAF smyčce.
 *
 * Painter's algorithm zůstává: budovy se kreslí seřazené podle hloubky (x+y).
 * Ovládání: kolečko = zoom na kurzor, tažení = posun, dvojklik / ⤢ = celý svět.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MapData, MapPlot, TransportRoute } from '../api'
import {
  FLOOR_H, TILE_H, TILE_W, gridBounds, ownerColor, tileCenter, type Pt,
} from '../game/iso'
import { STATUS_GLOW, shade, skinFor, terrainFor } from '../game/art'
import { drawBuildingArt, drawConstructionArt } from '../game/buildingArt'

type Props = {
  map: MapData | null
  myCompanyId: string | null
  selectedPlotId: string | null
  onSelectPlot: (plot: MapPlot | null) => void
  /** rychlost herních hodin (0 = pauza → doprava stojí) */
  clockSpeed: number
  /** Herní hodina (0–23) pro denní/noční nádech scény. */
  hourOfDay?: number
  /** hráčem založené cargo trasy — jen po nich něco jezdí */
  routes: TransportRoute[]
}

/** Deterministický „náhodný“ detail terénu (stromy, skály) — stabilní mezi rendery. */
function hash2(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 974634) >>> 0
  h = (h ^ (h >> 13)) * 1274126177 >>> 0
  return ((h ^ (h >> 16)) >>> 0) / 4294967295
}

/* ── canvas pomůcky ─────────────────────────────────────────────────────── */

function polyPath(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
}

function fillPoly(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string, alpha = 1) {
  if (alpha < 1) { ctx.globalAlpha = alpha }
  polyPath(ctx, pts)
  ctx.fillStyle = fill
  ctx.fill()
  if (alpha < 1) { ctx.globalAlpha = 1 }
}

function strokePoly(ctx: CanvasRenderingContext2D, pts: Pt[], stroke: string, width: number, alpha = 1) {
  if (alpha < 1) { ctx.globalAlpha = alpha }
  polyPath(ctx, pts)
  ctx.strokeStyle = stroke
  ctx.lineWidth = width
  ctx.stroke()
  if (alpha < 1) { ctx.globalAlpha = 1 }
}

function diamondPts(cx: number, cy: number, w = TILE_W, h = TILE_H): Pt[] {
  return [
    { x: cx, y: cy - h / 2 }, { x: cx + w / 2, y: cy },
    { x: cx, y: cy + h / 2 }, { x: cx - w / 2, y: cy },
  ]
}

/* ── terén (kreslí se do offscreen vrstvy) ──────────────────────────────── */

function drawTerrainDetail(ctx: CanvasRenderingContext2D, plot: MapPlot, c: Pt) {
  const t = plot.type
  if (t === 'forest') {
    for (let i = 0; i < 3; i++) {
      const ox = (hash2(plot.x, plot.y, i + 5) - 0.5) * (TILE_W * 0.5)
      const oy = (hash2(plot.x, plot.y, i + 11) - 0.5) * (TILE_H * 0.5)
      const h = 9 + hash2(plot.x, plot.y, i + 13) * 6
      const tx = c.x + ox
      const ty = c.y + oy
      ctx.fillStyle = '#4a3a26'
      ctx.fillRect(tx - 0.8, ty - h * 0.35, 1.6, h * 0.4)
      fillPoly(ctx, [
        { x: tx, y: ty - h }, { x: tx + 4.5, y: ty - h * 0.3 }, { x: tx - 4.5, y: ty - h * 0.3 },
      ], '#2c5236')
      fillPoly(ctx, [
        { x: tx, y: ty - h * 0.78 }, { x: tx + 3.6, y: ty - h * 0.12 }, { x: tx - 3.6, y: ty - h * 0.12 },
      ], '#3d7a4f')
    }
    return
  }
  if (t === 'mine') {
    for (let i = 0; i < 3; i++) {
      const ox = (hash2(plot.x, plot.y, i + 3) - 0.5) * (TILE_W * 0.45)
      const oy = (hash2(plot.x, plot.y, i + 9) - 0.5) * (TILE_H * 0.45)
      const r = 2 + hash2(plot.x, plot.y, i + 21) * 2.5
      fillPoly(ctx, [
        { x: c.x + ox - r, y: c.y + oy }, { x: c.x + ox, y: c.y + oy - r * 1.2 },
        { x: c.x + ox + r, y: c.y + oy }, { x: c.x + ox, y: c.y + oy + r * 0.5 },
      ], '#6b6157')
    }
    return
  }
  if (t === 'water') {
    ctx.globalAlpha = 0.5
    ctx.strokeStyle = '#8fc4e8'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(c.x - 12, c.y)
    ctx.quadraticCurveTo(c.x - 6, c.y - 3, c.x, c.y)
    ctx.quadraticCurveTo(c.x + 6, c.y + 3, c.x + 12, c.y)
    ctx.stroke()
    ctx.strokeStyle = '#6ea3c9'
    ctx.lineWidth = 0.8
    ctx.beginPath()
    ctx.moveTo(c.x - 8, c.y + 6)
    ctx.quadraticCurveTo(c.x - 3, c.y + 3.5, c.x + 2, c.y + 6)
    ctx.stroke()
    ctx.globalAlpha = 1
    return
  }
  if (t === 'commercial' || t === 'civic') {
    ctx.globalAlpha = 0.12
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(c.x, c.y, 1.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
    return
  }
  if (t === 'industrial' || t === 'utility') {
    if (hash2(plot.x, plot.y, 41) > 0.55) return
    ctx.globalAlpha = 0.5
    for (let i = 0; i < 2; i++) {
      const ox = (hash2(plot.x, plot.y, i + 51) - 0.5) * TILE_W * 0.5
      const oy = (hash2(plot.x, plot.y, i + 61) - 0.5) * TILE_H * 0.5
      ctx.fillStyle = t === 'utility' ? '#b9a8e8' : '#8a9384'
      ctx.beginPath()
      ctx.arc(c.x + ox, c.y + oy, 0.9, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
}

/**
 * Silniční dlaždice: asfalt se štěrkovou bankou a středovým značením, které
 * respektuje křižovatky. `roadSet` obsahuje "x,y" všech silničních dlaždic —
 * hrana bez sousední silnice dostane štěrk, osa se čáruje jen tam, kudy se
 * skutečně jezdí (NE-SW nebo NW-SE), křižovatka zůstává bez čar.
 */
function drawTileBase(
  ctx: CanvasRenderingContext2D, plot: MapPlot, myCompanyId: string | null,
  roadSet: Set<string>,
) {
  const c = tileCenter(plot.x, plot.y)
  const owned = plot.owner_id !== null
  // Hráčská silnice (budova road) je plochý asfalt, ne hranol — terén pod ní
  // zůstává, ale vizuálně vládne silnice.
  const isRoad = plot.type === 'road' || plot.b_code === 'road'
  const terr = isRoad
    ? terrainFor('road', owned)
    : terrainFor(plot.type, owned)

  if (isRoad) {
    const g = diamondPts(c.x, c.y)   // [top, right, bottom, left]
    // asfalt s jemným šumem
    fillPoly(ctx, g, shade('#2b2e34', 0.96 + hash2(plot.x, plot.y, 31) * 0.08))
    for (let i = 0; i < 7; i++) {
      const sx = c.x + (hash2(plot.x, plot.y, 70 + i) - 0.5) * (TILE_W - 12)
      const sy = c.y + (hash2(plot.x, plot.y, 90 + i) - 0.5) * (TILE_H - 8)
      ctx.globalAlpha = 0.1 + hash2(plot.x, plot.y, 110 + i) * 0.12
      ctx.fillStyle = i % 2 ? '#4a4e56' : '#1b1e23'
      ctx.fillRect(sx, sy, 1.4, 1)
    }
    ctx.globalAlpha = 1
    // štěrková banka jen na hranách BEZ napojení
    const nNE = roadSet.has(`${plot.x + 1},${plot.y - 1}`)
    const nSE = roadSet.has(`${plot.x + 1},${plot.y}`)
    const nSW = roadSet.has(`${plot.x},${plot.y + 1}`)
    const nNW = roadSet.has(`${plot.x - 1},${plot.y}`)
    const edges: [Pt, Pt, boolean][] = [
      [g[0], g[1], nNE], [g[1], g[2], nSE], [g[2], g[3], nSW], [g[3], g[0], nNW],
    ]
    for (const [a, b, hasN] of edges) {
      if (hasN) continue
      plineEdge(ctx, a, b, '#6b6157', 2.2, 0.9)
      plineEdge(ctx, lerpPt(a, b, 0.06), lerpPt(b, a, 0.06), '#3a3d43', 1, 0.7)
    }
    // středové značení podle osy průjezdu
    const axisA = nNE || nSW    // NE–SW
    const axisB = nNW || nSE    // NW–SE
    ctx.strokeStyle = '#c9cdd4'
    ctx.globalAlpha = 0.3
    ctx.lineWidth = 1.2
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    if (axisA && !axisB) {
      ctx.moveTo((g[2].x + g[3].x) / 2, (g[2].y + g[3].y) / 2)
      ctx.lineTo((g[0].x + g[1].x) / 2, (g[0].y + g[1].y) / 2)
    } else if (axisB && !axisA) {
      ctx.moveTo((g[3].x + g[0].x) / 2, (g[3].y + g[0].y) / 2)
      ctx.lineTo((g[1].x + g[2].x) / 2, (g[1].y + g[2].y) / 2)
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  } else {
    fillPoly(ctx, diamondPts(c.x, c.y), shade(terr.fill, 0.94 + hash2(plot.x, plot.y, 31) * 0.12))
    strokePoly(ctx, diamondPts(c.x, c.y, TILE_W - 6, TILE_H - 3), '#ffffff', 0.6, 0.055)
    // nasvícená horní hrana
    ctx.beginPath()
    ctx.moveTo(c.x - TILE_W / 2, c.y)
    ctx.lineTo(c.x, c.y - TILE_H / 2)
    ctx.lineTo(c.x + TILE_W / 2, c.y)
    ctx.strokeStyle = terr.edge
    ctx.lineWidth = 1
    ctx.stroke()
    drawTerrainDetail(ctx, plot, c)
  }

  if (owned) {
    const isMine = plot.owner_id === myCompanyId
    strokePoly(ctx, diamondPts(c.x, c.y, TILE_W - 4, TILE_H - 2),
      ownerColor(plot.owner_id), isMine ? 1.6 : 1, isMine ? 0.95 : 0.5)
  }
}

function plineEdge(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string, w: number, alpha: number) {
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.strokeStyle = color
  ctx.lineWidth = w
  ctx.stroke()
  ctx.globalAlpha = 1
}

const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/* ── budovy (animované → kreslí se každý snímek) ────────────────────────── */

/**
 * Stín + varianta budovy z buildingArt + stavová kontrolka a úrovně.
 * `night` (0..1) rozsvěcuje okna a neony — stejná křivka jako tint oblohy.
 */
function drawBuilding(
  ctx: CanvasRenderingContext2D, plot: MapPlot, c: Pt, now: number, night: number,
) {
  // silnice jako budova už je vyřešená v terénní vrstvě
  if (plot.b_code === 'road') return

  const skin = skinFor(plot.b_industry, plot.b_retail)
  const level = plot.b_level ?? 1
  const producing = plot.b_status === 'producing'
  const glow = plot.b_status ? STATUS_GLOW[plot.b_status] : undefined

  // vržený stín
  fillPoly(ctx, diamondPts(c.x + 3, c.y + 3, TILE_W - 14, TILE_H - 8), '#000', 0.24)

  if (plot.b_status === 'construction') {
    drawConstructionArt(ctx, c, now)
  } else {
    drawBuildingArt({
      ctx, c, now, level, producing, night, skin,
      seed: hash2(plot.x, plot.y, 17),
    }, plot.b_code)
  }

  // stavová kontrolka (producing pulzuje)
  const hgt = Math.min(68, 18 + (plot.b_tier ?? 1) * 8 + (level - 1) * FLOOR_H * 0.6)
  if (glow) {
    const r = 2.4 + (producing ? Math.sin(now / 300) * 0.9 : 0)
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(c.x, c.y - hgt - 4, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // úrovně jako tečky na střeše
  if (level > 1) {
    const dots = Math.min(5, level - 1)
    ctx.fillStyle = '#ffffffcc'
    for (let i = 0; i < dots; i++) {
      ctx.beginPath()
      ctx.arc(c.x - 8 + i * 4, c.y - hgt + 2, 1.3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/* ── doprava: jezdí jen po hráčem založených trasách ────────────────────── */

const CARGO_COLORS = ['#c0453c', '#4f83d8', '#3ddc97', '#ffc266', '#b06459', '#8b7bff']

type Lane = {
  pts: Pt[]; cum: number[]; len: number; kind: 'truck' | 'ship'
  vehicles: number; color: string
}

function laneFrom(
  path: { x: number; y: number }[], kind: 'truck' | 'ship', vehicles: number, color: string,
): Lane | null {
  const pts = path.map((t) => tileCenter(t.x, t.y))
  if (pts.length < 2) return null
  const cum = [0]
  let len = 0
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    cum.push(len)
  }
  if (len < 1) return null
  return { pts, cum, len, kind, vehicles, color }
}

function pointAt(lane: Lane, t: number): Pt {
  const d = t * lane.len
  let i = 1
  while (i < lane.cum.length - 1 && lane.cum[i] < d) i++
  const seg = lane.cum[i] - lane.cum[i - 1] || 1
  const f = (d - lane.cum[i - 1]) / seg
  const a = lane.pts[i - 1]; const b = lane.pts[i]
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

/** Světová rychlost vozidla v px/ms (při 1×) — lodě jsou pomalejší než auta. */
const PX_PER_MS = { truck: 0.045, ship: 0.02 } as const

/**
 * Tahač s návěsem: kabina vpředu, barevný kontejner vzadu, kola a stín.
 * `dir` překlopí kresbu podle směru jízdy (vpravo/vlevo), `long` přidá druhý
 * návěs u vícekusových vozových parků.
 */
function drawTruck(
  ctx: CanvasRenderingContext2D, x: number, y: number,
  dir: 1 | -1, cargo: string, long: boolean,
) {
  ctx.save()
  ctx.translate(x, y - 2)
  ctx.scale(dir, 1)
  // stín
  ctx.globalAlpha = 0.3
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.ellipse(-1, 2, long ? 11 : 8.5, 3.2, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1

  const trailerLen = long ? 13 : 10
  // návěs: pravá bočnice (světlo), čelo, střecha
  fillPoly(ctx, [
    { x: -trailerLen, y: -1.5 }, { x: 1, y: 2.5 }, { x: 1, y: -4.5 }, { x: -trailerLen, y: -8.5 },
  ], shade(cargo, 0.78))
  fillPoly(ctx, [
    { x: 1, y: 2.5 }, { x: 4, y: 1 }, { x: 4, y: -6 }, { x: 1, y: -4.5 },
  ], cargo)
  fillPoly(ctx, [
    { x: -trailerLen, y: -8.5 }, { x: 1, y: -4.5 }, { x: 4, y: -6 }, { x: -trailerLen + 3, y: -10 },
  ], shade(cargo, 1.22))
  // žebrování kontejneru
  ctx.strokeStyle = '#00000030'
  ctx.lineWidth = 0.6
  for (let i = 1; i < 4; i++) {
    const t = i / 4
    const bx = -trailerLen + t * (trailerLen + 1)
    const by = -1.5 + t * 4
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.lineTo(bx, by - 7)
    ctx.stroke()
  }
  // kabina
  fillPoly(ctx, [
    { x: 4, y: 1 }, { x: 8.5, y: -1.2 }, { x: 8.5, y: -6.4 }, { x: 4, y: -4.2 },
  ], '#3f4a5a')
  fillPoly(ctx, [
    { x: 8.5, y: -1.2 }, { x: 10.5, y: -2.2 }, { x: 10.5, y: -7 }, { x: 8.5, y: -6.4 },
  ], '#55637a')
  fillPoly(ctx, [
    { x: 4, y: -4.2 }, { x: 8.5, y: -6.4 }, { x: 10.5, y: -7 }, { x: 6, y: -4.9 },
  ], '#74869f')
  // okno kabiny
  fillPoly(ctx, [
    { x: 8.7, y: -3.1 }, { x: 10.2, y: -3.8 }, { x: 10.2, y: -6.2 }, { x: 8.7, y: -5.6 },
  ], '#9fd4ff', 0.9)
  // světlo
  ctx.fillStyle = '#ffe9a8'
  ctx.fillRect(10.1, -2.4, 1.2, 1)
  // kola
  ctx.fillStyle = '#14181f'
  for (const wx of [-trailerLen + 2.5, -3.5, 5.5, 8.8]) {
    ctx.beginPath()
    ctx.ellipse(wx, wx < 0 ? 0.4 - wx * 0.0 : 0.2, 1.5, 0.95, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#5d636d'
  for (const wx of [-trailerLen + 2.5, -3.5, 5.5, 8.8]) {
    ctx.beginPath()
    ctx.ellipse(wx, wx < 0 ? 0.4 : 0.2, 0.7, 0.42, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Nákladní loď: trup s ponorkou, řada kontejnerů, nástavba na zádi, brázda. */
function drawShip(
  ctx: CanvasRenderingContext2D, x: number, y: number, dir: 1 | -1, cargo: string,
) {
  ctx.save()
  ctx.translate(x, y - 2)
  ctx.scale(dir, 1)
  // brázda za zádí
  ctx.strokeStyle = '#9fc7e8'
  ctx.globalAlpha = 0.4
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(-16, 2)
  ctx.quadraticCurveTo(-11, 5.5, -5, 4.5)
  ctx.stroke()
  ctx.globalAlpha = 0.22
  ctx.beginPath()
  ctx.moveTo(-19, 4.4)
  ctx.quadraticCurveTo(-13, 7.5, -6, 6.4)
  ctx.stroke()
  ctx.globalAlpha = 1
  // stín
  ctx.globalAlpha = 0.22
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.ellipse(0, 2.5, 13, 4, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
  // trup
  fillPoly(ctx, [
    { x: -12, y: -1 }, { x: 0, y: 4.5 }, { x: 0, y: 0.5 }, { x: -12, y: -5 },
  ], '#232c3a')
  fillPoly(ctx, [
    { x: 0, y: 4.5 }, { x: 12, y: -1.5 }, { x: 12, y: -5.5 }, { x: 0, y: 0.5 },
  ], '#35435a')
  fillPoly(ctx, [
    { x: -12, y: -5 }, { x: 0, y: 0.5 }, { x: 12, y: -5.5 }, { x: 0, y: -11 },
  ], '#485872')
  // ponorka (červená linka)
  plineHull(ctx, [{ x: -12, y: -1.4 }, { x: 0, y: 4.1 }, { x: 12, y: -1.9 }], '#b06459', 1.2)
  // paluba
  fillPoly(ctx, [
    { x: -10, y: -5.4 }, { x: 0, y: -0.6 }, { x: 10, y: -5.8 }, { x: 0, y: -10.4 },
  ], '#5a6a85')
  // kontejnery (2 řady)
  const rows: [number, number, string][] = [
    [-4.5, -6.2, cargo], [-0.5, -8.1, shade(cargo, 1.25)],
    [3.5, -10, shade(cargo, 0.8)], [-2.5, -4.2, '#e8c07a'], [1.5, -6.1, '#5a8f9c'],
  ]
  for (const [dx, dy, col] of rows) {
    fillPoly(ctx, [
      { x: dx - 2, y: dy + 2 }, { x: dx, y: dy + 3 }, { x: dx, y: dy + 0.6 }, { x: dx - 2, y: dy - 0.4 },
    ], shade(col, 0.8))
    fillPoly(ctx, [
      { x: dx, y: dy + 3 }, { x: dx + 2, y: dy + 2 }, { x: dx + 2, y: dy - 0.4 }, { x: dx, y: dy + 0.6 },
    ], col)
    fillPoly(ctx, [
      { x: dx - 2, y: dy - 0.4 }, { x: dx, y: dy + 0.6 }, { x: dx + 2, y: dy - 0.4 }, { x: dx, y: dy - 1.4 },
    ], shade(col, 1.3))
  }
  // nástavba na zádi
  fillPoly(ctx, [
    { x: -11, y: -5.6 }, { x: -8, y: -4.2 }, { x: -8, y: -8.6 }, { x: -11, y: -10 },
  ], '#8fa2bd')
  fillPoly(ctx, [
    { x: -8, y: -4.2 }, { x: -5.6, y: -5.4 }, { x: -5.6, y: -9.8 }, { x: -8, y: -8.6 },
  ], '#b9c8dd')
  fillPoly(ctx, [
    { x: -11, y: -10 }, { x: -8, y: -8.6 }, { x: -5.6, y: -9.8 }, { x: -8.6, y: -11.2 },
  ], '#d7e2f0')
  ctx.fillStyle = '#3f4a5a'
  ctx.fillRect(-9.4, -12.6, 1.4, 2.6)                      // komín
  ctx.restore()
}

function plineHull(ctx: CanvasRenderingContext2D, pts: Pt[], color: string, w: number) {
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.strokeStyle = color
  ctx.lineWidth = w
  ctx.stroke()
}

/* ── signature obsahu mapy (offscreen vrstva se překreslí jen při změně) ── */

function mapSignature(map: MapData, myCompanyId: string | null): string {
  let h = 0x811c9dc5
  const mix = (n: number) => { h = Math.imul(h ^ (n | 0), 0x01000193) }
  const mixStr = (s: string | null) => {
    if (s === null) { mix(1); return }
    mix(2)
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i))
  }
  mixStr(myCompanyId)
  mix(map.grid.w); mix(map.grid.h)
  for (const p of map.plots) {
    mix(p.x); mix(p.y); mixStr(p.type); mixStr(p.owner_id)
    mixStr(p.b_id); mixStr(p.b_code)
  }
  return String(h >>> 0)
}

/* ── komponenta ─────────────────────────────────────────────────────────── */

const TERR_PAD = 48

type View = { x: number; y: number; w: number }

export default function WorldMap({
  map, myCompanyId, selectedPlotId, onSelectPlot, clockSpeed, hourOfDay = 12, routes,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const bounds = useMemo(
    () => (map ? gridBounds(map.grid.w, map.grid.h) : gridBounds(40, 20)),
    [map],
  )

  /** Seřazené dlaždice pro painter's algorithm budov. */
  const ordered = useMemo(
    () => (map ? [...map.plots].sort((a, b) => (a.x + a.y) - (b.x + b.y) || a.x - b.x) : []),
    [map],
  )
  const byPos = useMemo(() => {
    const m = new Map<string, MapPlot>()
    if (map) for (const p of map.plots) m.set(`${p.x},${p.y}`, p)
    return m
  }, [map])

  // Stav, který nepotřebuje React render: kamera, hover, hodinová rychlost.
  const viewRef = useRef<View>({ x: bounds.x, y: bounds.y, w: bounds.width })
  const fittedRef = useRef(false)
  const hoverRef = useRef<string | null>(null)
  const speedRef = useRef(clockSpeed)
  speedRef.current = clockSpeed
  const hourRef = useRef(hourOfDay)
  hourRef.current = hourOfDay
  const mapRef = useRef(map)
  mapRef.current = map
  const orderedRef = useRef(ordered)
  orderedRef.current = ordered
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  const selRef = useRef(selectedPlotId)
  selRef.current = selectedPlotId
  const routesRef = useRef(routes)
  routesRef.current = routes
  const sizeRef = useRef({ w: 0, h: 0 })
  const [cssSize, setCssSize] = useState({ w: 0, h: 0 })
  sizeRef.current = cssSize
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const mouseRef = useRef({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: number } | null>(null)

  // offscreen terén
  const terrainRef = useRef<HTMLCanvasElement | null>(null)
  const terrOriginRef = useRef({ x: 0, y: 0 })
  const sigRef = useRef('')

  const lanes = useMemo(() => {
    const out: Lane[] = []
    for (const r of routes) {
      if (r.status !== 'active') continue
      const l = laneFrom(r.path, r.mode, r.vehicles,
        CARGO_COLORS[out.length % CARGO_COLORS.length])
      if (l) out.push(l)
    }
    return out
  }, [routes])
  const lanesRef = useRef(lanes)
  lanesRef.current = lanes

  /* velikost plátna podle kontejneru */
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setCssSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) })
    })
    ro.observe(el)
    const r0 = el.getBoundingClientRect()
    setCssSize({ w: Math.max(1, r0.width), h: Math.max(1, r0.height) })
    return () => ro.disconnect()
  }, [])

  /** Kamera: výška pohledu je odvozená z poměru stran plátna. */
  const viewH = (v: View) => v.w * (sizeRef.current.h / Math.max(1, sizeRef.current.w))

  function fitView() {
    const b = boundsRef.current
    const aspect = sizeRef.current.h / Math.max(1, sizeRef.current.w)
    const w = Math.max(b.width + 32, (b.height + 32) / Math.max(0.01, aspect))
    viewRef.current = { x: b.x - 16 - (w - b.width) / 2, y: b.y - 16, w }
  }

  // první fit, až známe velikost; a re-fit při změně světa (reset / jiná mapa)
  useEffect(() => {
    if (sizeRef.current.w > 0) fitView()
    fittedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.x, bounds.y, bounds.width, bounds.height, cssSize.w > 0])

  function zoomAt(factor: number, anchor?: Pt) {
    const b = boundsRef.current
    const v = viewRef.current
    const minW = b.width / 12
    const maxW = b.width * 1.1
    const nw = Math.min(maxW, Math.max(minW, v.w * factor))
    const f = nw / v.w
    if (f === 1) return
    const ax = anchor ? anchor.x : v.x + v.w / 2
    const ay = anchor ? anchor.y : v.y + viewH(v) / 2
    viewRef.current = { x: ax - (ax - v.x) * f, y: ay - (ay - v.y) * f, w: nw }
  }

  /** Bod myši (CSS px v rámci plátna) → světové souřadnice. */
  function toWorld(px: number, py: number): Pt {
    const v = viewRef.current
    const scale = sizeRef.current.w / v.w
    return { x: v.x + px / scale, y: v.y + py / scale }
  }

  /** Světové souřadnice → dlaždice (inverzní izometrie). */
  function tileAt(w: Pt): MapPlot | null {
    const fx = (w.y / (TILE_H / 2) + w.x / (TILE_W / 2)) / 2
    const fy = (w.y / (TILE_H / 2) - w.x / (TILE_W / 2)) / 2
    return byPos.get(`${Math.round(fx)},${Math.round(fy)}`) ?? null
  }

  function updateHover(clientX: number, clientY: number) {
    const cv = canvasRef.current
    if (!cv) return
    const r = cv.getBoundingClientRect()
    const px = clientX - r.left
    const py = clientY - r.top
    mouseRef.current = { x: px, y: py }
    const plot = tileAt(toWorld(px, py))
    const id = plot?.id ?? null
    if (id !== hoverRef.current) {
      hoverRef.current = id
      if (!plot) { setTip(null); return }
      const owned = plot.owner_id !== null
      const terr = terrainFor(plot.type, owned).label
      const isMine = owned && plot.owner_id === myCompanyId
      const lines = [`[${plot.x}, ${plot.y}] ${terr}` +
        (owned ? ` · ${plot.owner_name}${isMine ? ' (ty)' : ''}` : ' · volný pozemek')]
      if (plot.b_name) lines.push(`${plot.b_name} · lvl ${plot.b_level} · ${plot.b_status}`)
      setTip({ x: px, y: py, text: lines.join('\n') })
    } else if (id) {
      setTip((t) => (t ? { ...t, x: px, y: py } : t))
    }
  }

  /* kolečko = zoom na kurzor (native listener: React wheel je pasivní) */
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const r = cv.getBoundingClientRect()
      const w = toWorld(e.clientX - r.left, e.clientY - r.top)
      zoomAt(e.deltaY > 0 ? 1.16 : 1 / 1.16, w)
    }
    cv.addEventListener('wheel', handler, { passive: false })
    return () => cv.removeEventListener('wheel', handler)
  })

  /* ── TERÉNNÍ VRSTVA: překreslí se jen když se obsah mapy změní ───────── */
  useEffect(() => {
    if (!map) return
    const sig = mapSignature(map, myCompanyId)
    if (sig === sigRef.current && terrainRef.current) return
    sigRef.current = sig
    let cv = terrainRef.current
    if (!cv) {
      cv = document.createElement('canvas')
      terrainRef.current = cv
    }
    cv.width = Math.ceil(bounds.width + TERR_PAD * 2)
    cv.height = Math.ceil(bounds.height + TERR_PAD * 2)
    terrOriginRef.current = { x: bounds.x - TERR_PAD, y: bounds.y - TERR_PAD }
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.save()
    ctx.translate(TERR_PAD - bounds.x, TERR_PAD - bounds.y)
    const roadSet = new Set<string>()
    for (const p of map.plots) {
      if (p.type === 'road' || p.b_code === 'road') roadSet.add(`${p.x},${p.y}`)
    }
    for (const p of map.plots) drawTileBase(ctx, p, myCompanyId, roadSet)
    ctx.restore()
  }, [map, myCompanyId, bounds])

  /* ── HLAVNÍ SMYČKA ───────────────────────────────────────────────────── */
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    let raf = 0
    let last = performance.now()
    let clock = 0

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const dt = Math.min(64, now - last)
      last = now
      clock += dt * speedRef.current    // 0 = pauza → doprava stojí

      const css = sizeRef.current
      if (css.w < 2 || css.h < 2) return
      const dpr = Math.min(2, typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1)
      const pw = Math.round(css.w * dpr)
      const ph = Math.round(css.h * dpr)
      if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph }

      const m = mapRef.current
      const v = viewRef.current
      const scale = css.w / v.w
      const vh = v.w * (css.h / css.w)

      // pozadí (obdoba dřívějšího skyfade)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const sky = ctx.createLinearGradient(0, 0, 0, css.h)
      sky.addColorStop(0, '#16233a')
      sky.addColorStop(0.55, '#0d1524')
      sky.addColorStop(1, '#080d16')
      ctx.fillStyle = sky
      ctx.fillRect(0, 0, css.w, css.h)
      if (!m) return

      // světová transformace
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, -v.x * scale * dpr, -v.y * scale * dpr)

      // 1) terén z offscreen vrstvy
      const terr = terrainRef.current
      if (terr) ctx.drawImage(terr, terrOriginRef.current.x, terrOriginRef.current.y)

      // viditelné okno v mřížce (culling)
      const umin = v.x / (TILE_W / 2)
      const umax = (v.x + v.w) / (TILE_W / 2)
      const vmin = (v.y - 140) / (TILE_H / 2)
      const vmax = (v.y + vh) / (TILE_H / 2)
      const x0 = Math.floor((umin + vmin) / 2) - 2
      const x1 = Math.ceil((umax + vmax) / 2) + 2
      const y0 = Math.floor((vmin - umax) / 2) - 2
      const y1 = Math.ceil((vmax - umin) / 2) + 2
      const inView = (p: MapPlot) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1

      // 2) cargo trasy: čárkovaná čára + vozidla (jednosměrný okruh)
      for (const l of lanesRef.current) {
        ctx.beginPath()
        ctx.moveTo(l.pts[0].x, l.pts[0].y)
        for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i].x, l.pts[i].y)
        ctx.strokeStyle = l.kind === 'ship' ? '#7fb2e5' : '#e8c07a'
        ctx.globalAlpha = 0.34
        ctx.lineWidth = 2
        ctx.setLineDash([6, 5])
        ctx.lineCap = 'round'
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
      }
      for (const l of lanesRef.current) {
        for (let i = 0; i < l.vehicles; i++) {
          const t = ((clock * PX_PER_MS[l.kind]) / l.len + i / l.vehicles) % 1
          const p = pointAt(l, t)
          const p2 = pointAt(l, (t + 0.004) % 1)
          const dir = p2.x >= p.x ? 1 : -1
          if (l.kind === 'ship') drawShip(ctx, p.x, p.y, dir, l.color)
          else drawTruck(ctx, p.x, p.y, dir, l.color, l.vehicles > 1)
        }
      }

      // 3) budovy (painter's order, jen viditelné); v noci svítí okna a neony
      const hb = hourRef.current
      let nightF = 0
      if (hb >= 21 || hb < 4) nightF = 1
      else if (hb >= 19) nightF = (hb - 19) / 2
      else if (hb < 6) nightF = (6 - hb) / 2
      for (const p of orderedRef.current) {
        if (!p.b_id || !inView(p)) continue
        drawBuilding(ctx, p, tileCenter(p.x, p.y), now, nightF)
      }

      // 4) výběr a hover
      const sel = selRef.current
      const hov = hoverRef.current
      if (sel || hov) {
        for (const p of orderedRef.current) {
          if (p.id !== sel && p.id !== hov) continue
          const c = tileCenter(p.x, p.y)
          const isSel = p.id === sel
          fillPoly(ctx, diamondPts(c.x, c.y), isSel ? '#58a6ff' : '#ffffff', isSel ? 0.15 : 0.05)
          strokePoly(ctx, diamondPts(c.x, c.y), isSel ? '#58a6ff' : '#ffffff66', isSel ? 1.8 : 1)
        }
      }

      // 5) denní/noční nádech (screen-space): noc 21–4, soumrak 19–21 a 4–6.
      const h = hourRef.current
      let night = 0
      if (h >= 21 || h < 4) night = 1
      else if (h >= 19) night = (h - 19) / 2
      else if (h < 6) night = (6 - h) / 2
      if (night > 0.02) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.fillStyle = `rgba(9,12,38,${(0.42 * night).toFixed(3)})`
        ctx.fillRect(0, 0, css.w, css.h)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  /* ── JSX: canvas + overlay ovládání ──────────────────────────────────── */
  if (!map) return <div className="empty">načítám mapu světa…</div>

  return (
    <div className="map-stage" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="worldmap-canvas"
        role="img"
        aria-label="Izometrická mapa světa"
        onDoubleClick={() => fitView()}
        onPointerDown={(e) => {
          const v = viewRef.current
          drag.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: 0 }
          e.currentTarget.setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) {
            const scale = sizeRef.current.w / viewRef.current.w
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy))
            viewRef.current = { ...viewRef.current, x: d.vx - dx / scale, y: d.vy - dy / scale }
          } else {
            updateHover(e.clientX, e.clientY)
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          if (d && d.moved < 5) {
            const r = canvasRef.current?.getBoundingClientRect()
            if (r) {
              const plot = tileAt(toWorld(e.clientX - r.left, e.clientY - r.top))
              onSelectPlot(plot)
            }
          }
        }}
        onPointerLeave={() => {
          drag.current = null
          hoverRef.current = null
          setTip(null)
        }}
      />

      {tip && (
        <div className="map-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          {tip.text.split('\n').map((l) => <div key={l}>{l}</div>)}
        </div>
      )}

      <div className="map-tools">
        <button className="map-tool" title="Přiblížit" onClick={() => zoomAt(1 / 1.4)}>＋</button>
        <button className="map-tool" title="Oddálit" onClick={() => zoomAt(1.4)}>−</button>
        <button className="map-tool" title="Celý svět (nebo dvojklik na mapu)" onClick={() => fitView()}>⤢</button>
      </div>
    </div>
  )
}

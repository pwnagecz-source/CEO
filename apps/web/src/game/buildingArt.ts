/**
 * Fáze F+ — PROCEDURÁLNÍ UMĚNÍ BUDOV.
 *
 * Každý typ budovy má vlastní siluetu, aby mapa byla čitelná na pohled:
 * důl má těžní věž, rafinerie nádrže a hořák, pila hromadu klád a pilový list,
 * solár panely, farma pruhy polí a silo, přístav gantry jeřáb a kontejnery,
 * deli markýzu a neon. Vše se kreslí z primitiv (krabice, válce, stanové
 * střechy, komíny, kouř, hromady, panely…) — žádné obrázky, žádná assets.
 *
 * Zásady:
 *   • deterministické — per-plot `seed` (hash) dělá drobné variace, ale stejný
 *     vstup = stejný výstup (offscreen terén se nesmí „třást“),
 *   • levné — budova je ~30–70 canvas operací, kreslí se per-frame jen
 *     v otevřeném viewportu,
 *   • animace jen tam, kde něco znamenají: kouř = vyrábí, plamen = rafinerie
 *     běží, pumpa = ropná věž těží, okna svítí v noci a při výrobě.
 *
 * Staveniště (`construction`) má vlastní kresbu: jeřáb, oplocení, hromady
 * materiálu — hráč hned vidí, že se něco děje, i bez tooltipu.
 */
import type { BuildingSkin } from './art'
import { shade } from './art'
import { TILE_H, TILE_W, up, type Pt } from './iso'

/** Diamant jako POLE bodů [top, right, bottom, left] (indexovatelné). */
function dia(cx: number, cy: number, w: number, h: number): Pt[] {
  return [
    { x: cx, y: cy - h / 2 }, { x: cx + w / 2, y: cy },
    { x: cx, y: cy + h / 2 }, { x: cx - w / 2, y: cy },
  ]
}

type Ctx = CanvasRenderingContext2D

export type ArtOpts = {
  ctx: Ctx
  /** střed dlaždice ve světových souřadnicích */
  c: Pt
  now: number
  level: number
  producing: boolean
  /** 0..1 intenzita noci (pro svítící okna/neony) */
  night: number
  skin: BuildingSkin
  seed: number
}

/* ── canvas pomocníci ───────────────────────────────────────────────────── */

function poly(ctx: Ctx, pts: Pt[], fill: string, alpha = 1) {
  if (alpha < 1) ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  if (alpha < 1) ctx.globalAlpha = 1
}

function pline(ctx: Ctx, pts: Pt[], color: string, w = 1, alpha = 1) {
  if (alpha < 1) ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.strokeStyle = color
  ctx.lineWidth = w
  ctx.stroke()
  if (alpha < 1) ctx.globalAlpha = 1
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

type Box = { g: Pt[]; top: Pt[]; ht: number; cx: number; cy: number }

/**
 * Izometrická krabice: levá stěna tmavá, pravá světlá, plochá střecha.
 * `w`,`h` = rozměry půdorysného diamantu (px), `ht` = výška stěn.
 */
function box(ctx: Ctx, cx: number, cy: number, w: number, h: number, ht: number,
             wallDark: string, wall: string, roof: string): Box {
  const g = dia(cx, cy, w, h)
  poly(ctx, [g[3], g[2], up(g[2], ht), up(g[3], ht)], wallDark)   // levá stěna
  poly(ctx, [g[2], g[1], up(g[1], ht), up(g[2], ht)], wall)       // pravá stěna
  const top = [up(g[0], ht), up(g[1], ht), up(g[2], ht), up(g[3], ht)]
  poly(ctx, top, roof)
  pline(ctx, top, '#00000040', 0.6)
  return { g, top, ht, cx, cy }
}

/** Stanová střecha nad krabicí (vrchol nad středem). */
function hipRoof(ctx: Ctx, b: Box, ridge: number, color: string) {
  const apex = { x: b.cx, y: b.cy - b.ht - ridge }
  const t = b.top
  poly(ctx, [t[3], t[0], apex], shade(color, 1.08))
  poly(ctx, [t[0], t[1], apex], shade(color, 0.92))
  poly(ctx, [t[1], t[2], apex], shade(color, 0.8))
  poly(ctx, [t[2], t[3], apex], shade(color, 0.7))
}

/** Pilová (šedová) střecha — zubatý pás nad plochou střechou. */
function sawRoof(ctx: Ctx, b: Box, n: number, color: string) {
  const y = b.cy - b.ht
  for (let i = 0; i < n; i++) {
    const x = b.cx - (n - 1) * 7 + i * 14
    poly(ctx, [{ x: x - 6, y }, { x: x + 6, y }, { x: x + 6, y: y - 7 }], color)
    poly(ctx, [{ x: x - 6, y }, { x: x + 6, y: y - 7 }, { x: x - 6, y: y - 3 }], shade(color, 1.25), 0.9)
  }
}

/** Válec (silo, nádrž, komín). x,y = střed podstavy. */
function cylinder(ctx: Ctx, x: number, y: number, r: number, ht: number,
                  side: string, top: string) {
  ctx.fillStyle = side
  ctx.fillRect(x - r, y - ht, r * 2, ht)
  ctx.beginPath()
  ctx.ellipse(x, y, r, r * 0.42, 0, 0, Math.PI)
  ctx.fill()
  ctx.fillStyle = shade(side, 1.22)
  ctx.fillRect(x - r, y - ht, r * 0.55, ht)          // odlesk
  ctx.fillStyle = top
  ctx.beginPath()
  ctx.ellipse(x, y - ht, r, r * 0.42, 0, 0, Math.PI * 2)
  ctx.fill()
}

/** Komín + volitelný kouř (jen když vyrábí). */
function chimney(ctx: Ctx, x: number, y: number, ht: number, r: number,
                 color: string, now: number, smoking: boolean, seed = 0,
                 smokeColor = '#c9cdd4') {
  ctx.fillStyle = color
  ctx.fillRect(x - r, y - ht, r * 2, ht)
  ctx.fillStyle = shade(color, 1.25)
  ctx.fillRect(x - r, y - ht, r * 0.7, ht)
  ctx.fillStyle = shade(color, 0.7)
  ctx.fillRect(x - r - 0.5, y - ht - 1.5, r * 2 + 1, 2.5)
  if (smoking) smoke(ctx, x, y - ht - 2, now, seed, smokeColor)
}

function smoke(ctx: Ctx, x: number, y: number, now: number, seed: number,
               color = '#c9cdd4', count = 3) {
  for (let i = 0; i < count; i++) {
    const prog = ((now / 2200) + i / count + seed) % 1
    const r = 1.8 + prog * 3
    ctx.globalAlpha = 0.45 * (1 - prog)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x - 1 + prog * 5 + i * 1.3, y - prog * 17, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/** Hromada sypkého materiálu (ruda, písek, struska, obilí). */
function pile(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, color: string) {
  poly(ctx, [
    { x: cx - rx, y: cy }, { x: cx - rx * 0.35, y: cy - ry },
    { x: cx + rx * 0.4, y: cy - ry * 0.85 }, { x: cx + rx, y: cy },
    { x: cx, y: cy + ry * 0.45 },
  ], color)
  poly(ctx, [
    { x: cx - rx * 0.35, y: cy - ry }, { x: cx + rx * 0.4, y: cy - ry * 0.85 },
    { x: cx, y: cy + ry * 0.45 },
  ], shade(color, 1.18), 0.8)
}

/** Bedna/krabice (materiál, zboží). */
function crate(ctx: Ctx, x: number, y: number, s: number, color: string) {
  poly(ctx, [{ x: x - s, y }, { x, y: y + s * 0.5 }, { x, y: y - s * 0.6 }, { x: x - s, y: y - s }], shade(color, 0.8))
  poly(ctx, [{ x, y: y + s * 0.5 }, { x: x + s, y }, { x: x + s, y: y - s }, { x, y: y - s * 0.6 }], color)
  poly(ctx, [{ x: x - s, y: y - s }, { x, y: y - s * 0.6 }, { x: x + s, y: y - s }, { x, y: y - s * 1.4 }], shade(color, 1.2))
}

/** Okna v pravé stěně: řádky × sloupce; svítí při výrobě/noci. */
function windows(ctx: Ctx, b: Box, rows: number, cols: number, lit: boolean,
                 seed = 0, glassDark = '#232a35', glassLit = '#ffe9a8') {
  const g = b.g
  for (let r = 0; r < rows; r++) {
    const y0 = b.ht - 6 - r * 8
    if (y0 < 4) break
    for (let i = 0; i < cols; i++) {
      const t0 = 0.14 + (i / cols) * 0.72
      const t1 = t0 + (0.62 / cols)
      const on = lit || ((seed * 97 + r * 7 + i * 13) % 10) / 10 < 0.5
      poly(ctx, [
        up(lerp(g[2], g[1], t0), y0), up(lerp(g[2], g[1], t1), y0),
        up(lerp(g[2], g[1], t1), y0 + 4), up(lerp(g[2], g[1], t0), y0 + 4),
      ], on ? glassLit : glassDark, on ? 0.95 : 0.9)
    }
  }
}

/** Noční dosvit oken — teplá záře kolem budovy (jen když night > 0). */
function nightGlow(ctx: Ctx, x: number, y: number, r: number, night: number,
                   color = '#ffd27a') {
  if (night <= 0.05) return
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r)
  grad.addColorStop(0, color)
  grad.addColorStop(1, 'transparent')
  ctx.globalAlpha = 0.28 * night
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
}

/** Markýza přes pravou stěnu (retail). */
function awning(ctx: Ctx, b: Box, frac: number, c1: string, c2: string) {
  const g = b.g
  const y = b.ht * frac
  poly(ctx, [up(g[2], y), up(g[1], y), up(g[1], y + 5), up(g[2], y + 5)], c1)
  poly(ctx, [up(g[2], y), up(g[1], y), up(g[1], y + 2.4), up(g[2], y + 2.4)], c2)
}

/** Pruhy polí přes celou dlaždici. */
function fieldRows(ctx: Ctx, c: Pt, base: string, row: string, n: number) {
  const g = dia(c.x, c.y, TILE_W - 10, TILE_H - 5)
  poly(ctx, g, base)
  for (let i = 0; i < n; i++) {
    const t0 = i / n
    const t1 = t0 + 0.5 / n
    poly(ctx, [
      lerp(g[3], g[0], t0), lerp(g[2], g[1], t0),
      lerp(g[2], g[1], t1), lerp(g[3], g[0], t1),
    ], row, 0.85)
  }
}

/* ── specifické prvky ───────────────────────────────────────────────────── */

function solarField(ctx: Ctx, c: Pt) {
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 3; i++) {
      const x = c.x - 18 + i * 13 + r * 6
      const y = c.y - 2 + r * 8
      poly(ctx, [
        { x, y }, { x: x + 10, y: y - 3 }, { x: x + 10, y: y - 8 }, { x, y: y - 5 },
      ], '#1d3a6e')
      poly(ctx, [
        { x, y: y - 5 }, { x: x + 10, y: y - 8 }, { x: x + 9, y: y - 8.6 }, { x: x - 1, y: y - 5.6 },
      ], '#4f83d8', 0.9)
      ctx.fillStyle = '#8a9384'
      ctx.fillRect(x + 4, y - 4, 1.2, 4)
    }
  }
  box(ctx, c.x + 16, c.y + 6, 10, 5, 6, '#4a4f58', '#5d636d', '#6d747e')
}

function headframe(ctx: Ctx, x: number, y: number, h: number, color: string) {
  // těžní věž: dvě šikmé nohy + příčky + kolo
  pline(ctx, [{ x: x - 7, y }, { x: x - 1.5, y: y - h }], color, 2)
  pline(ctx, [{ x: x + 7, y }, { x: x + 1.5, y: y - h }], color, 2)
  for (let i = 1; i < 4; i++) {
    const t = i / 4
    const w = 7 - t * 5.5
    pline(ctx, [{ x: x - w, y: y - h * t }, { x: x + w, y: y - h * t }], color, 1)
  }
  ctx.strokeStyle = shade(color, 1.3)
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.arc(x, y - h - 3, 3.2, 0, Math.PI * 2)
  ctx.stroke()
}

function derrick(ctx: Ctx, x: number, y: number, h: number, color: string) {
  pline(ctx, [{ x: x - 6, y }, { x: x - 1, y: y - h }], color, 1.8)
  pline(ctx, [{ x: x + 6, y }, { x: x + 1, y: y - h }], color, 1.8)
  for (let i = 0; i < 4; i++) {
    const t0 = i / 4
    const t1 = (i + 1) / 4
    const w0 = 6 - t0 * 5
    const w1 = 6 - t1 * 5
    pline(ctx, [{ x: x - w0, y: y - h * t0 }, { x: x + w1, y: y - h * t1 }], color, 0.9)
    pline(ctx, [{ x: x + w0, y: y - h * t0 }, { x: x - w1, y: y - h * t1 }], color, 0.9)
  }
}

/** Houpací těžební pumpa (kovboj) — kývá se, jen když vyrábí. */
function pumpjack(ctx: Ctx, x: number, y: number, now: number, producing: boolean) {
  const ang = producing ? Math.sin(now / 700) * 0.32 : 0.12
  ctx.save()
  ctx.translate(x, y - 10)
  ctx.fillStyle = '#b3452f'
  ctx.fillRect(-1.4, 0, 2.8, 10)                     // stojan
  ctx.rotate(ang)
  ctx.fillStyle = '#8e3a28'
  ctx.fillRect(-11, -1.4, 22, 2.8)                   // trámec
  ctx.fillStyle = '#5d636d'
  ctx.beginPath()
  ctx.arc(-10, 0, 2.4, 0, Math.PI * 2)               // hlava
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = '#5d636d'                        // táhlo k zemi
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x - 10 + Math.sin(ang) * 2, y - 10 + Math.cos(ang) * 1)
  ctx.lineTo(x - 10, y + 2)
  ctx.stroke()
}

function flareStack(ctx: Ctx, x: number, y: number, h: number, now: number, live: boolean) {
  ctx.fillStyle = '#7d848f'
  ctx.fillRect(x - 1.2, y - h, 2.4, h)
  if (!live) return
  const fl = 2.6 + Math.sin(now / 130) * 1.1 + Math.sin(now / 61) * 0.5
  const grad = ctx.createRadialGradient(x, y - h - fl * 0.6, 0, x, y - h - fl * 0.6, fl * 2.2)
  grad.addColorStop(0, '#ffe9a8')
  grad.addColorStop(0.4, '#ff9d45')
  grad.addColorStop(1, 'transparent')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(x, y - h - fl * 0.6, fl * 2.2, 0, Math.PI * 2)
  ctx.fill()
  poly(ctx, [
    { x: x - 1.6, y: y - h }, { x: x, y: y - h - fl * 1.7 }, { x: x + 1.6, y: y - h },
  ], '#ffb35c')
}

function waterTower(ctx: Ctx, x: number, y: number, h: number, r: number, color: string) {
  for (let i = -1; i <= 1; i++) {
    pline(ctx, [{ x: x + i * r * 0.7, y }, { x: x + i * r * 0.4, y: y - h }], '#5d636d', 1.4)
  }
  cylinder(ctx, x, y - h + 4, r, 8, color, shade(color, 1.25))
  poly(ctx, [
    { x: x - r, y: y - h - 4 }, { x: x, y: y - h - 9 }, { x: x + r, y: y - h - 4 },
  ], shade(color, 0.75))
}

function gantryCrane(ctx: Ctx, x: number, y: number, h: number, color: string,
                     now: number, trolley: number) {
  // portálový jeřáb: dvě nohy + příčník + vozík s hákem
  pline(ctx, [{ x: x - 12, y: y + 4 }, { x: x - 9, y: y - h }], color, 2)
  pline(ctx, [{ x: x + 2, y: y + 8 }, { x: x - 1, y: y - h + 3 }], color, 2)
  pline(ctx, [{ x: x - 11, y: y - h + 2 }, { x: x + 6, y: y - h + 8 }], color, 2.4)
  const tx = x - 11 + ((Math.sin(now / 2600) + 1) / 2) * 15 * trolley
  const ty = y - h + 2 + (tx - (x - 11)) * 0.35
  ctx.fillStyle = shade(color, 0.8)
  ctx.fillRect(tx - 1.6, ty - 1, 3.2, 3)
  pline(ctx, [{ x: tx, y: ty + 2 }, { x: tx, y: ty + 9 }], '#93a1bd', 0.8)
  ctx.fillStyle = '#93a1bd'
  ctx.fillRect(tx - 1.4, ty + 9, 2.8, 2.4)
}

function towerCrane(ctx: Ctx, x: number, y: number, h: number, now: number) {
  const color = '#ffc266'
  pline(ctx, [{ x, y }, { x, y: y - h }], color, 2.2)                   // stožár
  for (let i = 0; i < 5; i++) {                                          // mřížování
    const yy = y - (i / 5) * h
    pline(ctx, [{ x: x - 2.4, y: yy }, { x: x + 2.4, y: yy - h / 10 }], shade(color, 0.85), 0.8)
  }
  const jib = 20
  pline(ctx, [{ x: x - 7, y: y - h + 2 }, { x: x + jib, y: y - h - 2 }], color, 2)  // rameno
  pline(ctx, [{ x, y: y - h }, { x: x + jib * 0.6, y: y - h - 1 }], shade(color, 1.1), 0.9)
  pline(ctx, [{ x, y: y - h }, { x: x - 7, y: y - h + 2 }], shade(color, 1.1), 0.9)
  const swing = Math.sin(now / 1800) * 3
  const hx = x + jib * 0.7 + swing
  pline(ctx, [{ x: hx, y: y - h - 1.4 }, { x: hx, y: y - h + 14 }], '#c9cdd4', 0.7) // lanko
  ctx.fillStyle = '#8a9384'
  ctx.fillRect(hx - 2, y - h + 14, 4, 3)                                 // hák/břemeno
  poly(ctx, [{ x: x - 9, y: y - h + 1 }, { x: x - 5, y: y - h + 1 },
             { x: x - 5, y: y - h + 4 }, { x: x - 9, y: y - h + 4 }], '#5d636d')  // protizávaží
}

function gear(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = color
  for (let i = 0; i < 8; i++) {
    ctx.rotate((Math.PI * 2) / 8)
    ctx.fillRect(r - 0.6, -1, 2.2, 2)
  }
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#14181f'
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.38, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function dish(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.ellipse(x, y, r, r * 0.75, -0.5, 0.4, Math.PI * 1.4)
  ctx.fill()
  pline(ctx, [{ x, y }, { x: x + r * 0.7, y: y - r * 0.7 }], color, 1)
  ctx.beginPath()
  ctx.arc(x + r * 0.7, y - r * 0.7, 1, 0, Math.PI * 2)
  ctx.fill()
}

function neonSign(ctx: Ctx, x: number, y: number, w: number, hgt: number,
                  color: string, night: number, on: boolean) {
  ctx.fillStyle = '#2a2d33'
  ctx.fillRect(x - w / 2, y - hgt - 9, w, 7)
  if (on || night > 0.3) {
    ctx.globalAlpha = 0.35 + night * 0.5
    ctx.fillStyle = color
    ctx.fillRect(x - w / 2 + 1, y - hgt - 8, w - 2, 5)
    ctx.globalAlpha = 1
    nightGlow(ctx, x, y - hgt - 5, w * 1.4, Math.max(night, on ? 0.35 : 0), color)
  } else {
    ctx.fillStyle = shade(color, 0.6)
    ctx.fillRect(x - w / 2 + 1, y - hgt - 8, w - 2, 5)
  }
}

/* ── hlavní dispatch podle kódu budovy ──────────────────────────────────── */

const W = TILE_W - 14   // základní šířka půdorysu
const H = TILE_H - 7

export function drawBuildingArt(o: ArtOpts, code: string | null): void {
  const { ctx, c, now, level, producing, night, skin, seed } = o
  const lit = producing || night > 0.4
  const grow = Math.min(24, (level - 1) * 7)   // vyšší úroveň = vyšší budova

  switch (code) {
    /* ── SUROVINY ─────────────────────────────────────────────────────── */
    case 'logging_camp': {
      const b = box(ctx, c.x - 4, c.y, W * 0.62, H * 0.62, 13 + grow * 0.3, '#6e4f35', '#8a6544', '#5d4229')
      hipRoof(ctx, b, 7, '#4a3320')
      windows(ctx, b, 1, 2, lit, seed, '#2a2118', '#ffd98a')
      // hromada klád
      for (let i = 0; i < 3; i++) {
        cylinder(ctx, c.x + 14, c.y + 5 - i * 3.4, 6.5, 2.6, '#7c5a3a', '#a3804f')
      }
      pile(ctx, c.x + 12, c.y + 8, 7, 3, '#6b4d31')
      break
    }
    case 'iron_mine': {
      box(ctx, c.x + 8, c.y + 4, W * 0.5, H * 0.5, 9, '#5c5148', '#75695d', '#8a7c6d')
      headframe(ctx, c.x - 6, c.y + 2, 34 + grow, '#8e7154')
      pile(ctx, c.x + 14, c.y + 8, 8, 4.5, '#8a5a3b')       // hromada rudy
      crate(ctx, c.x - 16, c.y + 8, 3.4, '#5d636d')         // vozík
      ctx.fillStyle = '#3f4a5a'
      ctx.beginPath(); ctx.arc(c.x - 17.4, c.y + 10, 1.2, 0, Math.PI * 2)
      ctx.arc(c.x - 14.6, c.y + 10, 1.2, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 'quarry': {
      // terasovitá jáma
      poly(ctx, dia(c.x, c.y, TILE_W - 12, TILE_H - 6), '#5c5148')
      poly(ctx, dia(c.x, c.y + 1, TILE_W - 26, TILE_H - 13), '#4a423b')
      poly(ctx, dia(c.x, c.y + 2, TILE_W - 38, TILE_H - 19), '#38322c')
      pline(ctx, [{ x: c.x - 8, y: c.y + 1 }, { x: c.x + 4, y: c.y + 7 }], '#6b6157', 1.4)
      pile(ctx, c.x + 16, c.y + 6, 6, 3.4, '#7d746a')
      pline(ctx, [{ x: c.x - 18, y: c.y - 2 }, { x: c.x - 18, y: c.y - 16 }], '#ffc266', 1.6)
      pline(ctx, [{ x: c.x - 19, y: c.y - 15 }, { x: c.x - 7, y: c.y - 12 }], '#ffc266', 1.4)
      pline(ctx, [{ x: c.x - 9, y: c.y - 12 }, { x: c.x - 9, y: c.y - 7 }], '#c9cdd4', 0.7)
      break
    }
    case 'oil_rig': {
      derrick(ctx, c.x - 4, c.y, 36 + grow, '#93a1bd')
      pumpjack(ctx, c.x + 14, c.y + 6, now, producing)
      cylinder(ctx, c.x - 18, c.y + 6, 4.4, 9, '#5d636d', '#7d848f')
      cylinder(ctx, c.x - 12, c.y + 9, 3.6, 7.5, '#4a4f58', '#6d747e')
      break
    }
    case 'solar_plant': {
      solarField(ctx, c)
      if (producing) {
        ctx.globalAlpha = 0.18 + Math.sin(now / 900) * 0.05
        poly(ctx, dia(c.x, c.y, TILE_W - 12, TILE_H - 6), '#7fb2e5')
        ctx.globalAlpha = 1
      }
      break
    }
    case 'grain_farm': {
      fieldRows(ctx, c, '#8a7135', '#c9a84c', 5)
      const b = box(ctx, c.x - 10, c.y - 2, W * 0.4, H * 0.45, 10, '#8e4c43', '#b06459', '#7a3f37')
      hipRoof(ctx, b, 5, '#5d322c')
      cylinder(ctx, c.x + 12, c.y + 2, 4.2, 17 + grow * 0.5, '#b9c8dd', '#d7e2f0')
      pile(ctx, c.x + 2, c.y + 9, 6, 3, '#c9a84c')
      break
    }
    case 'cotton_farm': {
      fieldRows(ctx, c, '#5d7a4a', '#7d9c62', 5)
      ctx.fillStyle = '#e8e4d8'                             // bavlněné tečky
      for (let i = 0; i < 7; i++) {
        const px = c.x - 20 + ((seed * 137 + i * 53) % 40)
        const py = c.y - 4 + ((seed * 91 + i * 37) % 12)
        ctx.beginPath(); ctx.arc(px, py, 1.1, 0, Math.PI * 2); ctx.fill()
      }
      const b = box(ctx, c.x - 10, c.y - 2, W * 0.4, H * 0.45, 10, '#7a4a3f', '#96604f', '#6b3f35')
      hipRoof(ctx, b, 5, '#4f2c25')
      cylinder(ctx, c.x + 13, c.y + 3, 3.4, 10, '#8a9384', '#a8b0a0')
      break
    }
    /* ── PRŮMYSL ──────────────────────────────────────────────────────── */
    case 'sawmill': {
      const b = box(ctx, c.x - 2, c.y, W * 0.85, H * 0.85, 13 + grow * 0.4,
        shade(skin.wallDark, 0.9), skin.wall, skin.roof)
      sawRoof(ctx, b, 3, shade(skin.roof, 0.85))
      // pilový kotouč
      ctx.strokeStyle = '#c9cdd4'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.arc(c.x + 18, c.y + 2, 5.5, 0, Math.PI * 2)
      ctx.stroke()
      if (producing) {
        ctx.save()
        ctx.translate(c.x + 18, c.y + 2)
        ctx.rotate(now / 90)
        ctx.strokeStyle = '#e8ecf2'
        ctx.lineWidth = 0.7
        for (let i = 0; i < 4; i++) {
          ctx.rotate(Math.PI / 2)
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(5, 0); ctx.stroke()
        }
        ctx.restore()
      }
      for (let i = 0; i < 3; i++) cylinder(ctx, c.x - 18, c.y + 7 - i * 3, 5.5, 2.4, '#7c5a3a', '#a3804f')
      break
    }
    case 'cement_kiln': {
      // rotační pec: ležatý válec na podpěrách
      ctx.fillStyle = '#7d848f'
      ctx.save()
      ctx.translate(c.x - 4, c.y - 8)
      ctx.fillRect(-18, -5, 36, 10)
      ctx.fillStyle = '#93a1bd'
      ctx.fillRect(-18, -5, 36, 3)
      ctx.restore()
      for (const dx of [-14, 8]) {
        poly(ctx, [{ x: c.x - 4 + dx - 2.5, y: c.y + 2 }, { x: c.x - 4 + dx + 2.5, y: c.y + 2 },
                   { x: c.x - 4 + dx + 1.5, y: c.y - 8 }, { x: c.x - 4 + dx - 1.5, y: c.y - 8 }], '#5d636d')
      }
      poly(ctx, [{ x: c.x - 26, y: c.y - 8 }, { x: c.x - 20, y: c.y - 8 },
                 { x: c.x - 21.5, y: c.y - 16 }, { x: c.x - 24.5, y: c.y - 16 }], '#6d747e') // násypka
      chimney(ctx, c.x + 18, c.y - 2, 27 + grow, 2.4, '#8e4c43', now, producing, seed, '#b8a894')
      pile(ctx, c.x + 10, c.y + 8, 7, 3.4, '#9a918a')
      break
    }
    case 'flour_mill': {
      const b = box(ctx, c.x - 6, c.y, W * 0.42, H * 0.5, 34 + grow, '#8a7c6d', '#a89a89', '#75695d')
      windows(ctx, b, 4, 1, lit, seed)
      hipRoof(ctx, b, 6, '#5c5148')
      box(ctx, c.x + 10, c.y + 5, W * 0.5, H * 0.5, 10, '#75695d', '#8a7c6d', '#9a8c7d')
      cylinder(ctx, c.x + 16, c.y - 1, 3.8, 18, '#b9c8dd', '#d7e2f0')
      pile(ctx, c.x + 2, c.y + 9, 4.5, 2.4, '#d8cba8')       // pytle
      break
    }
    case 'glass_works': {
      const b = box(ctx, c.x - 2, c.y, W * 0.8, H * 0.8, 15 + grow * 0.4,
        shade(skin.wallDark, 0.92), skin.wall, skin.roof)
      // pec: oranžová zář v pravé stěně
      const flick = producing ? 0.75 + Math.sin(now / 160) * 0.2 : 0.18
      poly(ctx, [
        up(lerp(b.g[2], b.g[1], 0.3), 3), up(lerp(b.g[2], b.g[1], 0.62), 3),
        up(lerp(b.g[2], b.g[1], 0.62), 10), up(lerp(b.g[2], b.g[1], 0.3), 10),
      ], '#ff8c45', flick)
      nightGlow(ctx, c.x + 8, c.y - 6, 16, producing ? Math.max(night, 0.4) : night * 0.5, '#ff8c45')
      chimney(ctx, c.x - 16, c.y - 3, 31 + grow, 2.6, '#75695d', now, producing, seed)
      pile(ctx, c.x + 16, c.y + 7, 6.5, 3, '#d8cba8')       // písek
      break
    }
    case 'refinery': {
      cylinder(ctx, c.x - 14, c.y + 5, 6, 11, '#8a9384', '#a8b0a0')
      cylinder(ctx, c.x - 3, c.y + 8, 5, 9, '#7d848f', '#93a1bd')
      cylinder(ctx, c.x - 12, c.y - 3, 3.2, 26 + grow, '#93a1bd', '#b9c8dd')  // kolona
      ctx.fillStyle = '#5d636d'                                               // potrubí
      ctx.fillRect(c.x - 12, c.y - 6, 16, 1.4)
      ctx.fillRect(c.x - 4, c.y - 6, 1.4, 10)
      flareStack(ctx, c.x + 16, c.y - 2, 32, now, producing)
      box(ctx, c.x + 8, c.y + 8, W * 0.34, H * 0.4, 8, '#5d636d', '#7d848f', '#93a1bd')
      break
    }
    case 'smelter': {
      const b = box(ctx, c.x - 2, c.y + 2, W * 0.82, H * 0.82, 16 + grow * 0.4,
        '#4a423b', '#5c5148', '#38322c')
      sawRoof(ctx, b, 2, '#4a423b')
      chimney(ctx, c.x - 15, c.y - 4, 26 + grow, 2.8, '#8e4c43', now, producing, seed)
      chimney(ctx, c.x + 12, c.y - 3, 20, 2.2, '#7a3f37', now, producing, seed + 0.4)
      const flick = producing ? 0.8 + Math.sin(now / 140) * 0.18 : 0.15      // ústí pece
      poly(ctx, [
        up(lerp(b.g[2], b.g[1], 0.36), 2), up(lerp(b.g[2], b.g[1], 0.6), 2),
        up(lerp(b.g[2], b.g[1], 0.6), 8), up(lerp(b.g[2], b.g[1], 0.36), 8),
      ], '#ff6b35', flick)
      pile(ctx, c.x + 17, c.y + 8, 6, 3, '#3f4a5a')         // struska
      break
    }
    case 'steel_mill': {
      const b = box(ctx, c.x - 3, c.y + 1, W * 0.92, H * 0.92, 20 + grow * 0.5,
        '#4a4f58', '#5d636d', '#3f444c')
      sawRoof(ctx, b, 4, '#4a4f58')
      chimney(ctx, c.x - 18, c.y - 4, 30 + grow, 2.6, '#5d636d', now, producing, seed)
      chimney(ctx, c.x - 10, c.y - 6, 24, 2.2, '#6d747e', now, producing, seed + 0.3)
      chimney(ctx, c.x + 14, c.y - 4, 21, 2.2, '#6d747e', now, producing, seed + 0.6)
      // žhnoucí ingoty
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = producing ? '#ff8c45' : '#7a4a3f'
        ctx.fillRect(c.x + 10 + i * 4, c.y + 6 - i * 2, 3.4, 2)
      }
      pline(ctx, [{ x: c.x - 8, y: c.y + 8 }, { x: c.x + 8, y: c.y + 2 }], '#3f4a5a', 2) // dopravník
      break
    }
    case 'textile_mill': {
      const b = box(ctx, c.x - 4, c.y, W * 0.72, H * 0.72, 26 + grow,
        '#8e4c43', '#b06459', '#7a3f37')
      windows(ctx, b, 3, 3, lit, seed, '#2a2118', '#ffe9a8')
      hipRoof(ctx, b, 5, '#5d322c')
      chimney(ctx, c.x + 14, c.y + 2, 24 + grow, 2.4, '#75695d', now, producing, seed)
      waterTower(ctx, c.x - 16, c.y + 5, 12, 4.4, '#8a6544')
      for (let i = 0; i < 3; i++)                            // role látky
        cylinder(ctx, c.x + 6 + i * 4, c.y + 10, 2, 3.4, ['#c0453c', '#4f83d8', '#e8e4d8'][i]!, '#fff')
      break
    }
    case 'electronics_lab': {
      const b = box(ctx, c.x - 3, c.y, W * 0.74, H * 0.74, 17 + grow * 0.4,
        '#8d929c', '#b6bcc7', '#c9cdd4')
      // skleněná fasáda
      poly(ctx, [
        up(lerp(b.g[2], b.g[1], 0.1), 3), up(lerp(b.g[2], b.g[1], 0.9), 3),
        up(lerp(b.g[2], b.g[1], 0.9), 12), up(lerp(b.g[2], b.g[1], 0.1), 12),
      ], '#4f83d8', 0.55)
      nightGlow(ctx, c.x + 6, c.y - 8, 18, night, '#7fb2e5')
      dish(ctx, c.x - 12, c.y - 17 - grow * 0.4, 4, '#b9c8dd')
      ctx.fillStyle = '#5d636d'                               // střešní klimatizace
      ctx.fillRect(c.x + 4, c.y - 19 - grow * 0.4, 5, 3)
      neonSign(ctx, c.x - 3, c.y, W * 0.4, 17 + grow * 0.4, '#4f83d8', night, producing)
      break
    }
    case 'nail_press': {
      const b = box(ctx, c.x - 4, c.y, W * 0.58, H * 0.62, 12 + grow * 0.3,
        shade(skin.wallDark, 0.95), skin.wall, skin.roof)
      windows(ctx, b, 1, 2, lit, seed)
      for (let i = 0; i < 2; i++) {                           // cívky drátu
        ctx.strokeStyle = '#93a1bd'
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.arc(c.x + 12 + i * 6, c.y + 6 - i * 3, 3.4, 0, Math.PI * 2)
        ctx.stroke()
      }
      crate(ctx, c.x + 10, c.y + 11, 3, '#8a6544')
      break
    }
    case 'wire_draw': {
      const b = box(ctx, c.x - 3, c.y, W * 0.66, H * 0.7, 14 + grow * 0.3,
        shade(skin.wallDark, 0.95), skin.wall, skin.roof)
      windows(ctx, b, 1, 3, lit, seed)
      for (let i = 0; i < 3; i++) {                           // kabelové bubny
        cylinder(ctx, c.x + 12 + i * 5, c.y + 8 - i * 2.5, 2.6, 4.6, '#6e4f35', '#8a6544')
      }
      pline(ctx, [{ x: c.x + 12, y: c.y + 3 }, { x: c.x + 22, y: c.y - 1 }], '#c9cdd4', 0.6)
      break
    }
    case 'appliance_plant': {
      const b = box(ctx, c.x - 3, c.y, W * 0.88, H * 0.88, 15 + grow * 0.4,
        '#7d848f', '#93a1bd', '#a8b0a0')
      // nakládací docky
      for (let i = 0; i < 3; i++) {
        const t = 0.2 + i * 0.28
        poly(ctx, [
          up(lerp(b.g[2], b.g[1], t), 1), up(lerp(b.g[2], b.g[1], t + 0.16), 1),
          up(lerp(b.g[2], b.g[1], t + 0.16), 9), up(lerp(b.g[2], b.g[1], t), 9),
        ], '#4a4f58')
        pline(ctx, [up(lerp(b.g[2], b.g[1], t + 0.08), 2), up(lerp(b.g[2], b.g[1], t + 0.08), 8)],
          '#c9cdd4', 0.6, 0.4)
      }
      windows(ctx, b, 2, 2, lit, seed)
      crate(ctx, c.x + 16, c.y + 8, 3.6, '#e8e4d8')
      crate(ctx, c.x + 12, c.y + 11, 3, '#d8cba8')
      ctx.fillStyle = '#6d747e'
      ctx.fillRect(c.x - 8, c.y - 17 - grow * 0.4, 6, 2.6)    // střešní jednotka
      break
    }
    case 'bakery': {
      const b = box(ctx, c.x - 5, c.y, W * 0.56, H * 0.6, 12 + grow * 0.25,
        '#b8a88d', '#d8cba8', '#a89878')
      hipRoof(ctx, b, 7, '#b06459')
      windows(ctx, b, 1, 2, true, seed, '#3a2c1a', '#ffd98a')
      awning(ctx, b, 0.5, '#e79883', '#c0453c')
      chimney(ctx, c.x - 12, c.y - 6, 17, 1.8, '#8e4c43', now, producing, seed, '#e8e4d8')
      pile(ctx, c.x + 13, c.y + 7, 4.6, 2.4, '#c9a84c')       // pečivo v koši
      nightGlow(ctx, c.x, c.y - 10, 16, night, '#ffd98a')
      break
    }
    case 'furniture_factory': {
      const b = box(ctx, c.x - 3, c.y, W * 0.72, H * 0.75, 13 + grow * 0.3,
        '#7c5a3a', '#96704a', '#6e4f35')
      hipRoof(ctx, b, 5, '#5d4229')
      windows(ctx, b, 1, 3, lit, seed, '#2a2118', '#ffd98a')
      for (let i = 0; i < 4; i++) {                           // fošny
        ctx.fillStyle = i % 2 ? '#a3804f' : '#8a6544'
        ctx.fillRect(c.x + 10, c.y + 5 - i * 1.8, 12, 1.4)
      }
      break
    }
    case 'garment_factory': {
      const b = box(ctx, c.x - 4, c.y, W * 0.7, H * 0.75, 22 + grow * 0.5,
        '#96704a', '#b8a88d', '#8a7c6d')
      windows(ctx, b, 3, 3, lit, seed, '#2a2118', '#ffe9a8')
      awning(ctx, b, 0.28, '#d8cba8', '#b06459')
      for (let i = 0; i < 3; i++)                             // cívky na střeše
        cylinder(ctx, c.x - 10 + i * 6, b.cy - b.ht + 2, 1.8, 3.4,
          ['#c0453c', '#4f83d8', '#3ddc97'][i]!, '#fff')
      break
    }
    case 'machine_shop': {
      const b = box(ctx, c.x - 4, c.y, W * 0.66, H * 0.7, 13 + grow * 0.3,
        shade(skin.wallDark, 0.9), skin.wall, skin.roof)
      windows(ctx, b, 1, 3, lit, seed)
      gear(ctx, c.x + 15, c.y + 4, 4.2, '#93a1bd')
      gear(ctx, c.x + 20, c.y + 7, 2.8, '#7d848f')
      pline(ctx, [{ x: c.x - 18, y: c.y + 2 }, { x: c.x - 18, y: c.y - 12 }], '#ffc266', 1.4)
      pline(ctx, [{ x: c.x - 19, y: c.y - 11 }, { x: c.x - 9, y: c.y - 9 }], '#ffc266', 1.2)
      break
    }
    case 'tool_works': {
      const b = box(ctx, c.x - 5, c.y, W * 0.56, H * 0.6, 11 + grow * 0.25,
        shade(skin.wallDark, 0.9), skin.wall, skin.roof)
      windows(ctx, b, 1, 2, lit, seed)
      gear(ctx, c.x + 13, c.y + 5, 3.2, '#7d848f')
      crate(ctx, c.x + 8, c.y + 10, 3, '#5d636d')
      crate(ctx, c.x + 17, c.y + 9, 2.6, '#4a4f58')
      break
    }
    case 'deli': {
      const b = box(ctx, c.x - 4, c.y + 1, W * 0.58, H * 0.62, 12 + grow * 0.25,
        '#8e4c43', '#b8655a', '#7a3f37')
      // výloha
      poly(ctx, [
        up(lerp(b.g[2], b.g[1], 0.16), 2), up(lerp(b.g[2], b.g[1], 0.84), 2),
        up(lerp(b.g[2], b.g[1], 0.84), 8.5), up(lerp(b.g[2], b.g[1], 0.16), 8.5),
      ], '#ffe9a8', producing || night > 0.3 ? 0.9 : 0.35)
      awning(ctx, b, 0.62, '#eee7d8', '#c0453c')
      neonSign(ctx, c.x - 4, c.y + 1, W * 0.34, 12 + grow * 0.25, '#ffd45e', night, producing)
      nightGlow(ctx, c.x + 2, c.y - 6, 15, night, '#ffd98a')
      // slunečník + stolek
      poly(ctx, [{ x: c.x + 15, y: c.y + 3 }, { x: c.x + 20, y: c.y + 5.5 },
                 { x: c.x + 15, y: c.y + 8 }, { x: c.x + 10, y: c.y + 5.5 }], '#c0453c')
      ctx.fillStyle = '#8a6544'
      ctx.fillRect(c.x + 14.4, c.y + 5.5, 1.2, 5)
      break
    }
    case 'warehouse': {
      const b = box(ctx, c.x, c.y + 1, W * 0.95, H * 0.95, 13 + grow * 0.3,
        '#5d636d', '#7d848f', '#93a1bd')
      // vrata
      poly(ctx, [
        up(lerp(b.g[2], b.g[1], 0.3), 1), up(lerp(b.g[2], b.g[1], 0.7), 1),
        up(lerp(b.g[2], b.g[1], 0.7), 9), up(lerp(b.g[2], b.g[1], 0.3), 9),
      ], '#4a4f58')
      for (let i = 1; i < 4; i++) {
        pline(ctx, [up(lerp(b.g[2], b.g[1], 0.3), 1 + i * 2), up(lerp(b.g[2], b.g[1], 0.7), 1 + i * 2)],
          '#3f444c', 0.7)
      }
      crate(ctx, c.x + 19, c.y + 7, 3.6, '#8a6544')
      crate(ctx, c.x + 14, c.y + 10, 3, '#a3804f')
      crate(ctx, c.x - 19, c.y + 8, 3.2, '#7c5a3a')
      break
    }
    case 'harbor': {
      // molo + jeřáb + kontejnery
      poly(ctx, dia(c.x, c.y, TILE_W - 6, TILE_H - 3), '#6d747e')
      pline(ctx, dia(c.x, c.y, TILE_W - 6, TILE_H - 3), '#4a4f58', 1)
      gantryCrane(ctx, c.x - 4, c.y - 6, 26 + grow, '#c0453c', now, 1)
      const cols = ['#4f83d8', '#c0453c', '#3ddc97', '#ffc266']
      for (let i = 0; i < 3; i++) {
        crate(ctx, c.x + 8 + (i % 2) * 7, c.y + 4 + Math.floor(i / 2) * 5, 3.4,
          cols[(i + Math.floor(seed * 4)) % cols.length]!)
      }
      ctx.fillStyle = '#3f4a5a'                                // pacholata
      ctx.beginPath(); ctx.arc(c.x - 22, c.y + 8, 1.4, 0, Math.PI * 2); ctx.fill()
      break
    }
    default: {
      // generický průmyslový box podle skinu odvětví (staré chování)
      const hgt = Math.min(68, 18 + grow)
      const b = box(ctx, c.x, c.y, W, H, hgt, skin.wallDark, skin.wall, skin.roof)
      windows(ctx, b, Math.min(3, level), 2, lit, seed)
    }
  }
}

/** Staveniště: jeřáb, oplocení, hromada materiálu. */
export function drawConstructionArt(ctx: Ctx, c: Pt, now: number): void {
  poly(ctx, dia(c.x, c.y, TILE_W - 12, TILE_H - 6), '#5c5148')
  pile(ctx, c.x - 12, c.y + 5, 7, 3.4, '#8a7c6d')            // hlína
  pile(ctx, c.x + 12, c.y + 6, 6, 3, '#b06459')              // cihly
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i % 2 ? '#96704a' : '#8a6544'
    ctx.fillRect(c.x + 6, c.y + 1 - i * 1.8, 10, 1.5)
  }
  // oplocení: oranžové sloupky po obvodu
  const g = dia(c.x, c.y, TILE_W - 10, TILE_H - 5)
  for (const p of g) {
    ctx.fillStyle = '#ffc266'
    ctx.fillRect(p.x - 0.8, p.y - 7, 1.6, 7)
  }
  pline(ctx, [g[0], g[1], g[2], g[3], g[0]], '#ffc266', 0.8, 0.75)
  towerCrane(ctx, c.x - 2, c.y + 2, 40, now)
}

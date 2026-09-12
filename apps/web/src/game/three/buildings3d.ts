/**
 * 3D budovy — procedurální low-poly modely všech 28 typů, v2 (detail pass).
 *
 * Statické části se SBÍRAJÍ do bakeru a na konci mergují po materiálech
 (mergeGeometries) → budova má ~6–10 draw calls místo desítek meshů.
 * Patra zůstávají samostatné groupy `floor-N` (podklad pro budoucí editaci).
 * Animované části (pumpjack, jeřáby, kotouče, plamen) jsou živé meshe s
 * `userData.anim`; komíny registrují `smokes` pro kouřové puff-y.
 *
 * Detaily v2: sokl, dveře se stříškou, okna s rámy, odkapní líšty, ploty,
 * sudy, palety, venkovní jednotky, potrubí, vývěsní štíty, betonová
 * podkladová deska s hlinitým límcem — modely nežijí ve vakuu.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { skinFor, type BuildingSkin } from '../art'
import {
  FLARE, FORGE, LAMP, NEON, NEON_COOL, WIN_DARK, WIN_LIT_A, WIN_LIT_B,
  box, cyl, mat, matShade,
} from './materials'

export type BuildOpts = {
  level: number
  producing: boolean
  night: number
  seed: number
  industry: string | null
  retail: boolean | null
}

export type Anim = { kind: 'rotY' | 'rotZ' | 'rotX' | 'slideY' | 'slideX' | 'rock'; node: THREE.Object3D; speed: number }

/* ── baker: sběr geometrií po materiálech ───────────────────────────────── */
class Bake {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>()
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()

  add(geo: THREE.BufferGeometry, material: THREE.Material,
    x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const g = geo.clone()
    this.e.set(rx, ry, rz)
    this.q.setFromEuler(this.e)
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz))
    g.applyMatrix4(this.m)
    const list = this.parts.get(material)
    if (list) list.push(g); else this.parts.set(material, [g])
  }
  box(w: number, h: number, d: number, material: THREE.Material | string,
    x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) {
    this.add(new THREE.BoxGeometry(w, h, d), typeof material === 'string' ? mat(material) : material, x, y, z, rx, ry, rz)
  }
  cyl(rt: number, rb: number, h: number, material: THREE.Material | string,
    x = 0, y = 0, z = 0, seg = 8, rx = 0, ry = 0, rz = 0) {
    this.add(new THREE.CylinderGeometry(rt, rb, h, seg), typeof material === 'string' ? mat(material) : material, x, y, z, rx, ry, rz)
  }
  cone(r: number, h: number, material: THREE.Material | string,
    x = 0, y = 0, z = 0, seg = 6, rx = 0, rz = 0) {
    this.add(new THREE.ConeGeometry(r, h, seg), typeof material === 'string' ? mat(material) : material, x, y, z, rx, 0, rz)
  }
  /** sedlová střecha s přesahem a líštou */
  ridge(w: number, d: number, h: number, color: string, x = 0, y = 0, z = 0) {
    const shape = new THREE.Shape()
    shape.moveTo(-(w / 2 + 0.06), 0)
    shape.lineTo(w / 2 + 0.06, 0)
    shape.lineTo(0, h)
    shape.closePath()
    const g = new THREE.ExtrudeGeometry(shape, { depth: d + 0.12, bevelEnabled: false })
    g.translate(0, 0, -(d + 0.12) / 2)
    g.rotateY(Math.PI / 2)
    this.add(g, mat(color), x, y, z)
    this.box(w + 0.14, 0.05, d + 0.14, matShade(color, 0.8), x, y + 0.02, z)
  }
  /** pilová střecha o N zubech se skleněnými pásky */
  saw(w: number, d: number, h: number, color: string, teeth: number, x = 0, y = 0, z = 0) {
    const tw = w / teeth
    for (let i = 0; i < teeth; i++) {
      const cx = x - w / 2 + tw / 2 + i * tw
      const shape = new THREE.Shape()
      shape.moveTo(-tw / 2, 0)
      shape.lineTo(tw / 2, 0)
      shape.lineTo(tw / 2, h)
      shape.closePath()
      const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false })
      g.translate(0, 0, -d / 2)
      this.add(g, mat(color), cx, y, z)
      this.box(0.05, h * 0.86, d * 0.94, WIN_DARK, cx - tw / 2 + 0.05, y + h * 0.44, z, 0, 0, -Math.atan2(h, tw) + Math.PI / 2)
    }
    this.box(w + 0.1, 0.06, d + 0.1, matShade(color, 0.85), x, y + 0.02, z)
  }
  /** okna s rámy na fasádě; část v noci svítí */
  windows(w: number, h: number, y0: number, side: 'x+' | 'x-' | 'z+' | 'z-', depth: number, seed: number) {
    const cols = Math.max(2, Math.round(w / 0.6))
    const rows = Math.max(1, Math.round(h / 0.62))
    let s = Math.floor(seed * 1e4) + 3
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
    const xSide = side === 'x+' || side === 'x-'
    const ry = xSide ? Math.PI / 2 : 0
    const off = depth / 2 + 0.015
    const sgn = side === 'x+' || side === 'z+' ? 1 : -1
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        const lit = rnd()
        const glass = lit < 0.4 ? WIN_LIT_A : lit < 0.6 ? WIN_LIT_B : WIN_DARK
        const u = -w / 2 + (cc + 0.5) * (w / cols)
        const y = y0 + (r + 0.5) * (h / rows)
        const px = xSide ? sgn * off : u
        const pz = xSide ? u : sgn * off
        const fx = xSide ? sgn * (off - 0.012) : u
        const fz = xSide ? u : sgn * (off - 0.012)
        this.box(0.32, 0.36, 0.05, this.frameMat, fx, y, fz, ry)
        this.box(0.26, 0.3, 0.06, glass, px, y, pz, ry)
      }
    }
  }
  frameMat = mat('#39414d')

  flush(target: THREE.Object3D) {
    for (const [material, geos] of this.parts) {
      if (!geos.length) continue
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false)
      if (!merged) continue
      const mesh = new THREE.Mesh(merged, material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      target.add(mesh)
      if (geos.length > 1) for (const g of geos) g.dispose()
    }
    this.parts.clear()
  }
}

type Ctx = {
  bk: Bake
  g: THREE.Group
  anims: Anim[]
  smokes: { x: number; y: number; z: number }[]
  P: boolean
  skin: BuildingSkin
  seed: number
}
const anim = (c: Ctx, a: Anim) => c.anims.push(a)
const R = (seed: number) => {
  let s = Math.floor(seed * 233280) + 7
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
}

/* ──共用 prop helpery ───────────────────────────────────────────────────── */
function fenceRun(c: Ctx, x: number, z: number, len: number, ry: number) {
  const post = matShade(c.skin.wallDark, 0.7)
  const n = Math.max(2, Math.round(len / 0.45))
  for (const yy of [0.12, 0.24]) c.bk.box(len, 0.035, 0.035, post, x, yy, z, ry)
  for (let i = 0; i <= n; i++) {
    const t = -len / 2 + (i * len) / n
    c.bk.box(0.05, 0.3, 0.05, post, x + t * Math.cos(ry), 0.15, z - t * Math.sin(ry))
  }
}
function barrels(c: Ctx, x: number, z: number, n: number, cols: string[]) {
  for (let i = 0; i < n; i++) {
    c.bk.cyl(0.09, 0.09, 0.24, cols[i % cols.length] ?? '#7d8794', x + (i % 2) * 0.2, 0.12, z + Math.floor(i / 2) * 0.2, 8)
  }
}
function pallets(c: Ctx, x: number, z: number, n: number, top: string) {
  for (let i = 0; i < n; i++) {
    const px = x + (i % 2) * 0.34, pz = z + Math.floor(i / 2) * 0.3
    c.bk.box(0.3, 0.04, 0.26, '#8a6a44', px, 0.02, pz)
    c.bk.box(0.26, 0.12, 0.22, top, px, 0.1, pz)
  }
}
function acUnit(c: Ctx, x: number, y: number, z: number) {
  c.bk.box(0.22, 0.12, 0.18, '#9aa3ad', x, y + 0.06, z)
  c.bk.cyl(0.08, 0.08, 0.03, '#5d6675', x, y + 0.13, z, 8)
}
function pipeRun(c: Ctx, x: number, y: number, z: number, len: number, ry = 0) {
  c.bk.cyl(0.035, 0.035, len, '#8b939e', x, y, z, 6, 0, ry, Math.PI / 2)
  c.bk.cyl(0.025, 0.025, len, '#a5adb8', x, y + 0.07, z, 6, 0, ry, Math.PI / 2)
}
function chimney(c: Ctx, x: number, z: number, h: number, color = '#8d8578') {
  c.bk.cyl(0.13, 0.19, h, color, x, h / 2, z, 7)
  c.bk.cyl(0.17, 0.17, 0.09, matShade(color, 0.75), x, h - 0.02, z, 7)
  if (c.P) c.smokes.push({ x, y: h + 0.08, z })
}

/* ── obal budovy: sokl, patra, dveře, okna s rámy ───────────────────────── */
function shell(c: Ctx, w: number, d: number, floors: number): number {
  const FH = 0.62
  const skin = c.skin
  c.bk.box(w + 0.1, 0.16, d + 0.1, matShade(skin.wall, 0.55), 0, 0.08, 0)   // sokl
  for (let f = 0; f < floors; f++) {
    const fl = new THREE.Group()
    fl.name = `floor-${f + 1}`
    const fb = new Bake()
    const wall = f === 0 ? skin.wall : matShade(skin.wall, f % 2 ? 1.07 : 0.93)
    fb.box(w, FH, d, wall, 0, FH / 2 + f * FH, 0)
    fb.box(w + 0.05, 0.06, d + 0.05, matShade(skin.wall, 0.72), 0, (f + 1) * FH, 0) // líšta mezi patry
    const y0 = f * FH + 0.1
    fb.windows(w * 0.9, FH * 0.72, y0, 'z+', d, c.seed + f)
    fb.windows(w * 0.9, FH * 0.72, y0, 'z-', d, c.seed + f + 0.31)
    if (w > 0.95) fb.windows(d * 0.9, FH * 0.72, y0, 'x+', w, c.seed + f + 0.57)
    if (f === 0) {
      // dveře se stříškou a schůdky
      fb.box(0.34, 0.4, 0.08, '#2b3038', 0, 0.36, d / 2 + 0.02)
      fb.box(0.5, 0.05, 0.22, matShade(skin.roof, 0.85), 0, 0.6, d / 2 + 0.1, 0, 0.18)
      fb.box(0.44, 0.05, 0.16, '#8d8779', 0, 0.03, d / 2 + 0.1)
    }
    fb.flush(fl)
    c.g.add(fl)
    ;(c.g.userData.floors ??= [] as THREE.Group[]).push(fl)
  }
  return floors * FH + 0.06
}

/* ── jednotlivé typy ───────────────────────────────────────────────────── */
function headframe(c: Ctx) {
  const leg = matShade(c.skin.wallDark, 0.85)
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    c.bk.box(0.08, 1.55, 0.08, leg, sx * 0.3, 0.75, sz * 0.3, 0, sz * 0.16, -sx * 0.16)
  }
  c.bk.box(0.66, 0.1, 0.66, leg, 0, 1.5, 0)
  for (const s of [-1, 1]) c.bk.box(0.05, 0.4, 0.05, leg, s * 0.2, 1.7, 0)
  c.bk.box(0.54, 0.44, 0.44, c.skin.wallDark, 0.56, 0.22, 0.3)
  c.bk.box(0.1, 0.5, 0.1, '#5d6675', 0.56, 0.5, 0.3)
  // kolej pro vozík
  c.bk.box(1.1, 0.04, 0.06, '#4a5261', 0.2, 0.03, 0.62)
  c.bk.box(1.1, 0.04, 0.06, '#4a5261', 0.2, 0.03, 0.74)
  const wheel = cyl(0.24, 0.24, 0.07, '#39424f', 0, 1.78, 0, 10)
  wheel.rotation.x = Math.PI / 2
  c.g.add(wheel)
  anim(c, { kind: 'rotX', node: wheel, speed: 1.4 })
}

function pumpjack(c: Ctx) {
  c.bk.box(1.0, 0.18, 0.7, '#4a5261', 0, 0.09, 0)
  c.bk.box(1.1, 0.05, 0.8, '#6e675e', 0, 0.02, 0)
  for (const s of [-1, 1]) c.bk.box(0.07, 0.85, 0.07, '#5d6675', s * 0.17, 0.42, 0, 0, 0, -s * 0.3)
  const beam = new THREE.Group()
  beam.position.set(0, 0.82, 0)
  beam.add(box(1.2, 0.09, 0.12, '#c8763a', 0.1, 0, 0))
  beam.add(box(0.18, 0.36, 0.15, '#8d94a1', -0.55, -0.06, 0))
  beam.add(box(0.1, 0.32, 0.17, '#c8763a', 0.68, -0.06, 0))
  c.g.add(beam)
  anim(c, { kind: 'rock', node: beam, speed: 1.1 })
  const rod = box(0.04, 0.55, 0.04, '#9aa3b0', 0.68, 0.45, 0)
  c.g.add(rod)
  anim(c, { kind: 'slideY', node: rod, speed: 1.1 })
  c.bk.cyl(0.3, 0.34, 0.5, c.skin.wallDark, -0.55, 0.25, 0.36, 8)
  c.bk.cyl(0.24, 0.24, 0.42, '#b9c2cc', 0.62, 0.21, -0.5, 8)   // zásobní nádrž
  pipeRun(c, 0.2, 0.3, -0.5, 0.8)
}

function solarField(c: Ctx) {
  const panel = mat('#1d3a6e')
  const frame = mat('#8fa2b8')
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      const x = -0.62 + col * 0.62, z = -0.58 + r * 0.56
      c.bk.box(0.52, 0.03, 0.36, panel, x, 0.34, z, 0, -0.5)
      c.bk.box(0.54, 0.02, 0.03, frame, x, 0.42, z + 0.16, 0, -0.5)
      c.bk.cyl(0.03, 0.03, 0.34, frame, x, 0.16, z, 5)
      c.bk.box(0.04, 0.2, 0.04, frame, x, 0.2, z - 0.16)
    }
  }
  // střídač a trafostanice
  c.bk.box(0.36, 0.34, 0.28, '#7d8794', 0.74, 0.17, 0.66)
  c.bk.box(0.3, 0.05, 0.24, '#5d6675', 0.74, 0.36, 0.66)
  c.bk.box(0.06, 0.06, 0.5, '#39424f', 0.5, 0.05, 0.66)
  fenceRun(c, 0, -0.85, 1.7, 0)
  fenceRun(c, 0, 0.85, 1.7, 0)
}

function tanks(c: Ctx, n: number, withFlare: boolean) {
  for (let i = 0; i < n; i++) {
    const x = -0.55 + i * 0.55
    const h = 0.6 + (i % 2) * 0.22
    c.bk.cyl(0.26, 0.26, h, i % 2 ? '#b9c2cc' : c.skin.wall, x, h / 2 + 0.06, -0.35, 12)
    c.bk.cyl(0.27, 0.27, 0.06, matShade('#b9c2cc', 0.78), x, h + 0.08, -0.35, 12)
    c.bk.cyl(0.05, 0.05, h, '#8b939e', x + 0.27, h / 2, -0.35, 5)  // swan neck
  }
  pipeRun(c, 0, 0.36, 0.05, 1.5)
  // obvalování
  c.bk.box(1.7, 0.12, 0.08, '#7d7468', 0, 0.06, -0.72)
  c.bk.box(1.7, 0.12, 0.08, '#7d7468', 0, 0.06, 0.0)
  if (withFlare) {
    c.bk.cyl(0.05, 0.08, 1.6, '#77808c', 0.72, 0.8, -0.55, 6)
    const fl = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.32, 6), FLARE)
    fl.position.set(0.72, 1.72, -0.55)
    c.g.add(fl)
    anim(c, { kind: 'slideY', node: fl, speed: 6 })
  }
}

function fieldRows(c: Ctx, color: string, rows = 4) {
  for (let i = 0; i < rows; i++) {
    c.bk.box(1.7, 0.07, 0.17, color, 0, 0.035, -0.72 + i * 0.36)
    c.bk.box(1.7, 0.05, 0.05, matShade(color, 0.8), 0, 0.075, -0.72 + i * 0.36 + 0.06)
  }
}
function piles(c: Ctx, color: string, n: number, seed: number) {
  const rnd = R(seed)
  for (let i = 0; i < n; i++) {
    c.bk.cone(0.17 + rnd() * 0.11, 0.2 + rnd() * 0.13, color, (rnd() - 0.5) * 1.2, 0.1, 0.45 + rnd() * 0.35, 6)
  }
}
function logPile(c: Ctx, x: number, z: number, n = 5) {
  for (let i = 0; i < n; i++) {
    c.bk.cyl(0.07, 0.07, 0.72, i % 2 ? '#8a6a44' : '#75593a',
      x + (i % 2) * 0.08, 0.08 + Math.floor(i / 2) * 0.14, z + (i % 3) * 0.09, 6, 0, 0, Math.PI / 2)
  }
}
function gantryCrane(c: Ctx, h: number, color = '#e0a33c') {
  for (const s of [-1, 1]) {
    c.bk.box(0.09, h, 0.09, color, s * 0.62, h / 2, -0.32)
    c.bk.box(0.09, h, 0.09, color, s * 0.62, h / 2, 0.32)
    c.bk.box(0.09, 0.09, 0.74, color, s * 0.62, h, 0)
    c.bk.box(0.14, 0.1, 0.5, '#4a5261', s * 0.62, 0.05, 0)
  }
  c.bk.box(1.56, 0.13, 0.15, color, 0, h + 0.07, 0)
  c.bk.box(1.56, 0.05, 0.05, matShade(color, 0.8), 0, h + 0.16, 0)
  const trolley = box(0.2, 0.11, 0.18, '#4a5261', 0.1, h - 0.05, 0)
  c.g.add(trolley)
  anim(c, { kind: 'slideX', node: trolley, speed: 0.5 })
  const cable = box(0.015, 0.5, 0.015, '#2b3038', 0.1, h - 0.34, 0)
  c.g.add(cable)
  anim(c, { kind: 'slideY', node: cable, speed: 0.5 })
  const spreader = box(0.32, 0.13, 0.2, '#c0453c', 0.1, h - 0.63, 0)
  c.g.add(spreader)
  anim(c, { kind: 'slideY', node: spreader, speed: 0.5 })
}
function awning(c: Ctx, w: number, z: number, y: number, c1 = '#d9584a', c2 = '#f2efe6') {
  for (let i = 0; i < 5; i++) {
    c.bk.box(w / 5, 0.03, 0.36, i % 2 ? c2 : c1, -w / 2 + (i + 0.5) * (w / 5), y, z, 0, 0.28)
  }
  c.bk.box(w, 0.04, 0.05, matShade(c1, 0.7), 0, y + 0.06, z - 0.16)
}
function container(c: Ctx, x: number, y: number, z: number, color: string, ry = 0) {
  c.bk.box(0.34, 0.17, 0.22, color, x, y, z, ry)
  c.bk.box(0.35, 0.03, 0.23, matShade(color, 1.2), x, y + 0.09, z, ry)
}

/* ── hlavní switch ──────────────────────────────────────────────────────── */
export function buildBuilding(code: string | null, o: BuildOpts): THREE.Group {
  const g = new THREE.Group()
  const skin = skinFor(o.industry, o.retail)
  const floors = Math.max(1, Math.min(4, o.level))
  const c: Ctx = { bk: new Bake(), g, anims: [], smokes: [], P: o.producing, skin, seed: o.seed }
  const bk = c.bk
  const P = o.producing

  switch (code) {
    case 'iron_mine': {
      shell(c, 0.8, 0.7, 1)
      headframe(c)
      piles(c, '#6e6156', 2, o.seed)
      bk.box(0.24, 0.16, 0.18, '#8d94a1', 0.55, 0.11, 0.66)   // vozík
      bk.box(0.2, 0.08, 0.15, '#6e6156', 0.55, 0.2, 0.66)
      fenceRun(c, -0.5, 0.86, 1.1, 0)
      break
    }
    case 'logging_camp': {
      shell(c, 0.85, 0.7, 1)
      bk.ridge(0.95, 0.8, 0.3, skin.roof, 0, 0.7, 0)
      logPile(c, -0.55, 0.55, 6)
      logPile(c, 0.5, 0.62, 4)
      bk.box(0.06, 0.75, 0.06, '#8d94a1', 0.64, 0.37, -0.42)
      const jib = box(0.75, 0.05, 0.05, '#c8763a', 0.36, 0.72, -0.42)
      g.add(jib)
      if (P) anim(c, { kind: 'rotY', node: jib, speed: 0.4 })
      bk.box(0.4, 0.06, 0.3, '#75593a', -0.55, 0.03, 0.2)    // pile foundation / table
      barrels(c, 0.72, 0.3, 2, ['#c0453c', '#4f83d8'])
      break
    }
    case 'quarry': {
      bk.box(1.5, 0.1, 1.2, matShade(skin.wall, 0.7), 0, -0.02, 0.1)
      bk.box(1.1, 0.12, 0.85, matShade(skin.wall, 0.58), 0, 0.05, 0.15)
      bk.box(0.7, 0.14, 0.5, matShade(skin.wall, 0.46), 0, 0.13, 0.2)
      bk.box(0.4, 0.5, 0.36, skin.wall, -0.62, 0.25, -0.55)
      bk.cone(0.24, 0.34, '#7c8590', -0.62, 0.66, -0.55, 7)
      // dopravník
      bk.box(0.9, 0.05, 0.14, '#5d6675', -0.15, 0.42, -0.5, 0, 0, 0.35)
      bk.box(0.05, 0.35, 0.05, '#5d6675', 0.15, 0.2, -0.42)
      bk.box(0.05, 0.5, 0.05, '#5d6675', -0.45, 0.28, -0.58)
      piles(c, '#8d8578', 3, o.seed)
      const crusher = box(0.34, 0.3, 0.3, '#8d94a1', -0.15, 0.5, -0.42)
      g.add(crusher)
      if (P) anim(c, { kind: 'slideY', node: crusher, speed: 5 })
      break
    }
    case 'oil_rig': pumpjack(c); break
    case 'solar_plant': solarField(c); break
    case 'grain_farm': {
      shell(c, 0.75, 0.6, 1)
      bk.ridge(0.85, 0.7, 0.28, skin.roof, 0, 0.7, 0)
      for (const [x, z] of [[-0.6, -0.5], [-0.32, -0.62], [-0.6, -0.24]] as const) {
        bk.cyl(0.15, 0.15, 0.85, '#c9b280', x, 0.42, z, 10)
        bk.cone(0.17, 0.22, '#8e7a42', x, 0.95, z, 10)
        bk.box(0.05, 0.5, 0.05, '#8e7a42', x + 0.16, 0.3, z)
      }
      fieldRows(c, '#c9a84c', 3)
      fenceRun(c, 0.5, 0.86, 1.0, 0)
      pallets(c, 0.55, 0.5, 2, '#c9b280')
      break
    }
    case 'cotton_farm': {
      shell(c, 0.7, 0.6, 1)
      bk.ridge(0.8, 0.7, 0.26, '#a3564a', 0, 0.7, 0)
      fieldRows(c, '#e8e4da', 4)
      bk.cyl(0.2, 0.24, 0.5, '#9aa3b0', 0.66, 0.55, -0.6, 10)
      bk.cone(0.22, 0.18, '#77808c', 0.66, 0.88, -0.6, 10)
      for (const s of [-1, 0, 1]) bk.box(0.04, 0.32, 0.04, '#5d6675', 0.66 + s * 0.12, 0.16, -0.6 + s * 0.08)
      for (let i = 0; i < 3; i++) bk.box(0.26, 0.16, 0.2, '#e8e4da', -0.6 + i * 0.28, 0.08, 0.66)
      break
    }
    case 'sawmill': {
      shell(c, 1.1, 0.8, 1)
      bk.ridge(1.2, 0.9, 0.34, skin.roof, 0, 0.7, 0)
      const blade = box(0.36, 0.28, 0.05, '#b9c2cc', 0.2, 0.52, 0.47)
      g.add(blade)
      if (P) anim(c, { kind: 'slideY', node: blade, speed: 7 })
      bk.box(0.4, 0.3, 0.06, '#39424f', 0.2, 0.4, 0.44)
      logPile(c, -0.62, 0.5, 6)
      for (let i = 0; i < 4; i++) bk.box(0.5, 0.05, 0.3, '#d9c078', 0.62, 0.06 + i * 0.06, 0.55) // prkna
      bk.cyl(0.12, 0.14, 0.5, '#8d8578', -0.62, 0.25, -0.55, 8)  // odsávání
      bk.cone(0.14, 0.2, '#8d8578', -0.62, 0.6, -0.55, 8)
      break
    }
    case 'cement_kiln': {
      shell(c, 0.7, 0.6, 1)
      bk.cyl(0.18, 0.18, 1.5, '#a8a294', 0, 0.52, 0.1, 12, 0, 0, Math.PI / 2 - 0.12)
      bk.box(0.4, 1.15, 0.4, skin.wallDark, -0.62, 0.57, -0.5)
      bk.box(0.44, 0.08, 0.44, matShade(skin.wallDark, 0.8), -0.62, 1.16, -0.5)
      chimney(c, 0.62, -0.55, 1.25)
      piles(c, '#9aa3a0', 2, o.seed)
      pallets(c, 0.6, 0.6, 2, '#b9c2cc')
      break
    }
    case 'flour_mill': {
      const t = shell(c, 0.8, 0.7, 2)
      bk.ridge(0.9, 0.8, 0.3, skin.roof, 0, t, 0)
      bk.cyl(0.18, 0.18, 0.95, '#d8d2c2', 0.62, 0.47, -0.5, 10)
      bk.cone(0.2, 0.2, '#b0a88f', 0.62, 1.04, -0.5, 10)
      bk.box(0.9, 0.06, 0.16, '#8b939e', 0.2, 0.62, -0.2, 0, 0, 0.5)
      fieldRows(c, '#d9c078', 2)
      pallets(c, -0.6, 0.62, 3, '#e0d6b8')
      acUnit(c, -0.2, t + 0.06, 0.1)
      break
    }
    case 'glass_works': {
      shell(c, 1.0, 0.8, 1)
      bk.saw(1.0, 0.8, 0.3, skin.roof, 3, 0, 0.7, 0)
      bk.box(0.32, 0.26, 0.07, FORGE, 0, 0.26, 0.44)
      piles(c, '#e6ddc4', 2, o.seed)
      bk.cyl(0.16, 0.18, 0.6, '#b9c2cc', 0.66, 0.3, -0.55, 8)   // pískové silo
      for (let i = 0; i < 3; i++) bk.box(0.2, 0.14, 0.16, WIN_DARK, -0.5 + i * 0.24, 0.07, 0.66)
      break
    }
    case 'refinery': {
      tanks(c, 3, true)
      shell(c, 0.5, 0.4, 1)
      bk.windows(0.46, 0.4, 0.1, 'z+', 0.4, o.seed)
      bk.box(0.06, 0.4, 0.06, '#77808c', 0.3, 0.2, -0.62)
      barrels(c, -0.7, 0.55, 3, ['#c0453c', '#4f83d8', '#3ddc97'])
      break
    }
    case 'smelter': {
      const t = shell(c, 1.0, 0.85, 1)
      bk.ridge(1.1, 0.95, 0.36, skin.roof, 0, t, 0)
      chimney(c, -0.3, -0.2, 1.35)
      chimney(c, 0.28, -0.28, 1.1)
      bk.box(0.36, 0.32, 0.08, FORGE, 0, 0.28, 0.47)
      piles(c, '#5d564d', 2, o.seed)
      bk.cyl(0.12, 0.14, 0.2, '#39424f', 0.62, 0.1, 0.6, 8)     // pánev
      bk.box(0.3, 0.1, 0.2, '#8d94a1', 0.62, 0.24, 0.6)
      fenceRun(c, -0.55, 0.88, 1.2, 0)
      break
    }
    case 'steel_mill': {
      const t = shell(c, 1.3, 0.9, 1)
      bk.ridge(1.4, 1.0, 0.4, skin.roof, 0, t, 0)
      bk.box(1.2, 0.07, 0.5, '#5d6675', 0, t + 0.44, 0)
      bk.box(0.16, 0.14, 0.4, '#c8763a', 0.2, t + 0.54, 0)
      chimney(c, -0.5, -0.3, 1.45)
      bk.box(0.5, 0.36, 0.08, FORGE, 0.2, 0.32, 0.5)
      for (let i = 0; i < 4; i++) bk.box(0.24, 0.07, 0.12, '#8d94a1', -0.5 + i * 0.26, 0.04, 0.68)
      piles(c, '#39424f', 2, o.seed + 1)
      break
    }
    case 'textile_mill': {
      shell(c, 1.2, 0.9, 1)
      bk.saw(1.2, 0.9, 0.32, skin.roof, 4, 0, 0.7, 0)
      bk.cyl(0.22, 0.26, 0.44, '#7fa3b8', 0.66, 0.92, -0.55, 10)
      bk.cone(0.24, 0.16, '#5d6675', 0.66, 1.2, -0.55, 10)
      for (const s of [-1, 0, 1]) bk.box(0.05, 0.5, 0.05, '#5d6675', 0.66 + s * 0.14, 0.45, -0.55 + s * 0.1)
      for (let i = 0; i < 4; i++) bk.box(0.22, 0.16, 0.18, '#e8e4da', -0.55 + i * 0.26, 0.08, 0.68)
      break
    }
    case 'electronics_lab': {
      const t = shell(c, 1.0, 0.8, Math.max(2, floors))
      bk.box(1.06, 0.07, 0.86, '#f2f6fa', 0, t, 0)
      bk.box(0.3, 0.16, 0.24, '#dfe6ee', -0.3, t + 0.11, -0.2)
      acUnit(c, 0.1, t + 0.07, -0.25)
      const dish = cyl(0.22, 0.22, 0.05, '#eef2f7', 0.32, t + 0.26, -0.2, 10)
      dish.rotation.x = -0.7
      g.add(dish)
      if (P) anim(c, { kind: 'rotY', node: dish, speed: 0.5 })
      bk.cyl(0.03, 0.03, 0.3, '#b9c2cc', 0.32, t + 0.12, -0.2, 5)
      bk.box(0.9, 0.06, 0.04, NEON_COOL, 0, 0.52, 0.43)
      bk.box(0.5, 0.05, 0.3, '#b9c2cc', 0.6, 0.03, 0.62)       // chodník
      break
    }
    case 'nail_press': {
      shell(c, 0.8, 0.65, 1)
      bk.ridge(0.9, 0.75, 0.26, skin.roof, 0, 0.7, 0)
      const coil = cyl(0.24, 0.24, 0.16, '#9aa3b0', -0.6, 0.24, 0.5, 12)
      coil.rotation.x = Math.PI / 2
      g.add(coil)
      if (P) anim(c, { kind: 'rotZ', node: coil, speed: 2 })
      bk.box(0.1, 0.3, 0.3, '#5d6675', -0.6, 0.15, 0.32)
      pallets(c, 0.55, 0.55, 2, '#7d6a4d')
      break
    }
    case 'wire_draw': {
      shell(c, 0.95, 0.7, 1)
      bk.ridge(1.05, 0.8, 0.28, skin.roof, 0, 0.7, 0)
      for (let i = 0; i < 3; i++) {
        bk.cyl(0.14, 0.14, 0.06, '#5d6675', -0.4 + i * 0.4, 0.78, 0.3, 10)
        const sp = cyl(0.16, 0.16, 0.1, '#c8b06c', -0.4 + i * 0.4, 0.9, 0.3, 10)
        g.add(sp)
        if (P) anim(c, { kind: 'rotY', node: sp, speed: 3 })
      }
      pipeRun(c, 0.5, 0.3, -0.42, 0.9)
      break
    }
    case 'appliance_plant': {
      const t = shell(c, 1.2, 0.85, 1)
      bk.box(1.28, 0.09, 0.92, skin.roof, 0, t, 0)
      gantryCrane(c, t + 0.5, '#8fa2b8')
      container(c, 0.62, 0.12, 0.62, '#dfe6ee')
      container(c, 0.6, 0.3, 0.6, '#c9d2dc')
      acUnit(c, -0.4, t + 0.09, -0.2)
      acUnit(c, 0.2, t + 0.09, -0.3)
      break
    }
    case 'bakery': {
      shell(c, 0.8, 0.7, 1)
      bk.ridge(0.9, 0.8, 0.3, '#a3564a', 0, 0.7, 0)
      awning(c, 0.74, 0.44, 0.52)
      chimney(c, -0.28, -0.18, 1.0)
      bk.box(0.52, 0.32, 0.06, WIN_DARK, 0, 0.34, 0.38)
      bk.box(0.18, 0.18, 0.06, FLARE, 0.32, 0.66, 0.38)
      bk.box(0.24, 0.3, 0.04, '#8a6a44', 0.55, 0.15, 0.55, 0.4)  // vývěsní tabule
      pallets(c, -0.6, 0.6, 2, '#c9a84c')
      break
    }
    case 'deli': {
      shell(c, 0.8, 0.7, 1)
      bk.box(0.88, 0.11, 0.78, skin.roof, 0, 0.73, 0)
      awning(c, 0.74, 0.44, 0.52, '#3f8f6a', '#f2efe6')
      bk.box(0.52, 0.15, 0.07, NEON, 0, 0.88, 0.4)
      bk.box(0.58, 0.34, 0.06, WIN_DARK, 0, 0.32, 0.38)
      bk.box(0.3, 0.18, 0.2, '#3f8f6a', 0.6, 0.09, 0.6)   // bedýnky se zeleninou
      bk.box(0.26, 0.1, 0.16, '#c9a84c', 0.6, 0.22, 0.6)
      break
    }
    case 'furniture_factory': {
      shell(c, 1.0, 0.8, 1)
      bk.ridge(1.1, 0.9, 0.3, skin.roof, 0, 0.7, 0)
      bk.cyl(0.14, 0.16, 0.62, '#b0a88f', 0.62, 0.31, -0.5, 8)
      bk.cone(0.16, 0.2, '#8e7a42', 0.62, 0.72, -0.5, 8)
      logPile(c, -0.6, 0.55, 4)
      for (let i = 0; i < 3; i++) bk.box(0.4, 0.06, 0.3, '#c69d68', 0.55, 0.06 + i * 0.07, 0.6)
      break
    }
    case 'garment_factory': {
      shell(c, 1.0, 0.8, 1)
      bk.saw(1.0, 0.8, 0.28, skin.roof, 3, 0, 0.7, 0)
      for (let i = 0; i < 3; i++) {
        bk.cyl(0.09, 0.09, 0.5, ['#b0566a', '#5a8f9c', '#c9a84c'][i] ?? '#b0566a', -0.35 + i * 0.35, 0.09, 0.64, 8, 0, 0, Math.PI / 2)
      }
      pallets(c, 0.62, 0.5, 2, '#b0566a')
      break
    }
    case 'machine_shop': {
      const t = shell(c, 1.05, 0.8, 1)
      bk.ridge(1.15, 0.9, 0.32, skin.roof, 0, t, 0)
      bk.box(0.46, 0.38, 0.07, matShade(skin.wallDark, 0.75), 0, 0.22, 0.44)
      bk.box(0.5, 0.05, 0.05, '#c8763a', 0.5, t + 0.18, 0.3)
      bk.box(0.05, 0.26, 0.05, '#5d6675', 0.74, t + 0.06, 0.3)
      bk.box(0.3, 0.24, 0.28, '#7d6a4d', -0.64, 0.12, 0.58)
      barrels(c, 0.68, 0.55, 2, ['#4f83d8', '#7d8794'])
      acUnit(c, -0.3, t + 0.06, -0.15)
      break
    }
    case 'tool_works': {
      shell(c, 0.85, 0.7, 1)
      bk.ridge(0.95, 0.8, 0.28, skin.roof, 0, 0.7, 0)
      const wheel = cyl(0.2, 0.2, 0.06, '#9aa3b0', 0.6, 0.36, 0.47, 14)
      wheel.rotation.x = Math.PI / 2
      g.add(wheel)
      if (P) anim(c, { kind: 'rotX', node: wheel, speed: 6 })
      bk.box(0.08, 0.3, 0.08, '#5d6675', 0.6, 0.15, 0.47)
      pallets(c, -0.6, 0.6, 2, '#7d6a4d')
      break
    }
    case 'warehouse': {
      const w = 1.5, d = 1.0
      bk.box(w + 0.1, 0.16, d + 0.1, matShade(skin.wall, 0.55), 0, 0.08, 0)
      bk.box(w, 0.78, d, skin.wall, 0, 0.55, 0)
      bk.ridge(w + 0.08, d + 0.08, 0.34, skin.roof, 0, 0.94, 0)
      for (let i = 0; i < 3; i++) {
        bk.box(0.32, 0.36, 0.07, matShade(skin.wallDark, 0.8), -0.45 + i * 0.45, 0.34, d / 2 + 0.02)
        bk.box(0.36, 0.05, 0.24, '#8d8779', -0.45 + i * 0.45, 0.16, d / 2 + 0.14)  // rampa
      }
      container(c, 0.55, 0.14, 0.82, '#c0453c')
      container(c, 0.1, 0.14, 0.86, '#4f83d8')
      pallets(c, -0.6, 0.82, 3, '#c9a84c')
      bk.box(0.06, 0.5, 0.06, '#5d6675', 0.78, 0.25, 0.72)
      bk.box(0.08, 0.06, 0.08, LAMP, 0.78, 0.52, 0.72)
      break
    }
    case 'harbor': {
      bk.box(1.6, 0.14, 1.2, '#6e7684', 0, 0.05, 0)
      bk.box(1.62, 0.05, 0.1, '#4a5261', 0, 0.13, 0.6)
      gantryCrane(c, 1.4)
      container(c, -0.62, 0.2, 0.55, '#c0453c')
      container(c, -0.3, 0.2, 0.6, '#4f83d8')
      container(c, -0.46, 0.38, 0.57, '#3ddc97')
      container(c, 0.55, 0.2, 0.5, '#8b7bff')
      for (let i = 0; i < 4; i++) bk.cyl(0.05, 0.06, 0.14, '#2b3038', -0.66 + i * 0.44, 0.18, 0.88, 6)
      bk.box(0.3, 0.2, 0.24, '#7d8794', 0.66, 0.22, -0.5)
      break
    }
    default: {
      const t = shell(c, 0.9, 0.75, floors)
      bk.ridge(1.0, 0.85, 0.3, skin.roof, 0, t, 0)
      acUnit(c, 0.2, t + 0.06, -0.15)
      pallets(c, -0.6, 0.6, 2, '#7d6a4d')
      break
    }
  }

  // noční a doplňková světla před budovou
  if (o.retail || code === 'warehouse' || code === 'harbor') {
    bk.cyl(0.025, 0.03, 0.55, '#5d6675', 0.62, 0.27, 0.74, 5)
    bk.box(0.08, 0.05, 0.08, LAMP, 0.62, 0.56, 0.74)
  }
  // betonová podkladová deska + hlinitý límec (schová reliéf terénu)
  bk.box(TILE_PAD, 0.16, TILE_PAD, '#98917f', 0, 0.02, 0)
  bk.box(TILE_PAD + 0.16, 0.1, TILE_PAD + 0.16, '#6f6455', 0, -0.05, 0)

  c.bk.flush(g)
  g.userData.anims = c.anims
  g.userData.smokeSrc = c.smokes
  g.userData.code = code
  g.userData.night = o.night
  return g
}
const TILE_PAD = 1.86

/* ── staveniště ─────────────────────────────────────────────────────────── */
export function buildConstruction(seed: number): THREE.Group {
  const g = new THREE.Group()
  const bk = new Bake()
  const anims: Anim[] = []
  bk.box(1.3, 0.12, 1.1, '#7d7468', 0, 0.06, 0)
  bk.box(0.9, 0.26, 0.8, '#8d8578', 0, 0.18, 0)
  bk.box(0.5, 0.2, 0.4, '#98917f', 0.2, 0.36, 0.1)
  const fence = mat('#c9a84c', { transparent: 0.85 })
  for (const [w, d, x, z] of [[1.7, 0.03, 0, -0.8], [1.7, 0.03, 0, 0.8], [0.03, 1.6, -0.85, 0], [0.03, 1.6, 0.85, 0]] as const) {
    bk.box(w, 0.24, d, fence, x, 0.12, z)
  }
  bk.box(0.13, 1.8, 0.13, '#e0a33c', -0.55, 0.9, -0.55)
  for (let i = 0; i < 6; i++) bk.box(0.18, 0.035, 0.18, '#c58e2f', -0.55, 0.28 + i * 0.3, -0.55)
  bk.box(0.3, 0.2, 0.3, '#5d6675', -0.55, 0.1, -0.2)
  const jib = new THREE.Group()
  jib.position.set(-0.55, 1.82, -0.55)
  jib.add(box(1.2, 0.07, 0.07, '#e0a33c', 0.52, 0, 0))
  jib.add(box(0.36, 0.07, 0.07, '#e0a33c', -0.24, 0, 0))
  jib.add(box(0.18, 0.15, 0.15, '#5d6675', -0.36, -0.04, 0))
  jib.add(box(0.08, 0.12, 0.08, '#5d6675', 0, 0.1, 0))
  jib.add(box(0.02, 0.55, 0.02, '#2b3038', 0.8, -0.3, 0))
  jib.add(box(0.24, 0.15, 0.17, '#b9c2cc', 0.8, -0.62, 0))
  g.add(jib)
  anims.push({ kind: 'rotY', node: jib, speed: 0.25 })
  const rnd = R(seed)
  for (let i = 0; i < 2; i++) {
    bk.cone(0.18 + rnd() * 0.1, 0.22, '#9aa3a0', (rnd() - 0.5) * 1.1, 0.11, 0.5 + rnd() * 0.3, 6)
  }
  bk.box(0.32, 0.2, 0.26, '#c0453c', 0.64, 0.1, 0.62)
  bk.box(TILE_PAD, 0.14, TILE_PAD, '#98917f', 0, 0.0, 0)
  bk.box(TILE_PAD + 0.16, 0.1, TILE_PAD + 0.16, '#6f6455', 0, -0.06, 0)
  bk.flush(g)
  g.userData.anims = anims
  g.userData.smokeSrc = []
  return g
}

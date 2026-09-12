/**
 * 3D svět — materiály a primitiva (stylizovaný low-poly).
 *
 * Všechny materiály se CACHUJÍ podle barvy, takže tisíce meshů sdílí pár
 * instancí (méně draw calls, méně GC). `flatShading` dělá fazetovaný
 * low-poly vzhled; noční materiály (okna, neony, výheň) jsou SDÍLENÉ
 * singletony, takže přechod den/noc je jedna změna emissiveIntensity,
 * ne procházení scény.
 */
import * as THREE from 'three'
import { shade } from '../art'

/** hrana jedné dlaždice ve world units */
export const TILE = 2

const matCache = new Map<string, THREE.MeshLambertMaterial>()

/** Cacheovaný lambert materiál (low-poly fazety). */
export function mat(color: string, opts: { flat?: boolean; transparent?: number } = {}) {
  const key = `${color}|${opts.flat ?? true}|${opts.transparent ?? 1}`
  let m = matCache.get(key)
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) })
    m.flatShading = opts.flat ?? true
    if (opts.transparent !== undefined && opts.transparent < 1) {
      m.transparent = true
      m.opacity = opts.transparent
    }
    matCache.set(key, m)
  }
  return m
}

/** Tmavší/světlejší varianta přes shade() z art.ts. */
export const matShade = (color: string, f: number) => mat(shade(color, f))

/* ── sdílené „svítící" materiály (den/noc přepíná WorldScene) ─────────────── */
function emissiveMat(color: string, emissive: string) {
  const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) })
  m.emissive = new THREE.Color(emissive)
  m.emissiveIntensity = 0
  return m
}
/** okna — v noci svítí teplce (dvě varianty pro náhodné rozložení) */
export const WIN_LIT_A = emissiveMat('#2a3140', '#ffd9a0')
export const WIN_LIT_B = emissiveMat('#2a3140', '#ffbf7a')
/** okna, která v noci zůstávají tmavá */
export const WIN_DARK = mat('#232a36')
/** neon / výloha */
export const NEON = emissiveMat('#ff5f8a', '#ff5f8a')
export const NEON_COOL = emissiveMat('#59e0ff', '#59e0ff')
/** výheň pece / hořák rafinerie */
export const FORGE = emissiveMat('#3a1c10', '#ff7a2a')
export const FLARE = emissiveMat('#ffd45e', '#ffb347')
/** světla vozidel */
export const LAMP = emissiveMat('#fff3c4', '#fff3c4')

/** seznam materiálů, jejichž emissiveIntensity řídí noc (0..1) */
export const NIGHT_MATS: { m: THREE.MeshLambertMaterial; min: number; max: number }[] = [
  { m: WIN_LIT_A, min: 0, max: 1.15 },
  { m: WIN_LIT_B, min: 0, max: 0.95 },
  { m: NEON, min: 0.15, max: 1.6 },
  { m: NEON_COOL, min: 0.15, max: 1.4 },
  { m: FORGE, min: 0.35, max: 1.5 },
  { m: FLARE, min: 0.5, max: 2.2 },
  { m: LAMP, min: 0, max: 1.8 },
]

/* ── geometrie: cache podle rozměrů ─────────────────────────────────────── */
const geoCache = new Map<string, THREE.BufferGeometry>()
function cached(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key)
  if (!g) {
    g = make()
    g.userData.cached = true
    geoCache.set(key, g)
  }
  return g
}
/** Geometrie ze shared cache se nesmí dispose-ovat při bourání budov. */
export const isCachedGeo = (g: THREE.BufferGeometry) => g.userData.cached === true

export const boxGeo = (w: number, h: number, d: number) =>
  cached(`b${w.toFixed(2)}_${h.toFixed(2)}_${d.toFixed(2)}`, () => new THREE.BoxGeometry(w, h, d))
export const cylGeo = (rt: number, rb: number, h: number, seg = 8) =>
  cached(`c${rt.toFixed(2)}_${rb.toFixed(2)}_${h.toFixed(2)}_${seg}`,
    () => new THREE.CylinderGeometry(rt, rb, h, seg))
export const coneGeo = (r: number, h: number, seg = 6) =>
  cached(`k${r.toFixed(2)}_${h.toFixed(2)}_${seg}`, () => new THREE.ConeGeometry(r, h, seg))

/* ── stavitelské helpery ────────────────────────────────────────────────── */
export function box(
  w: number, h: number, d: number, color: string | THREE.Material,
  x = 0, y = 0, z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo(w, h, d), typeof color === 'string' ? mat(color) : color)
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}
export function cyl(
  rt: number, rb: number, h: number, color: string | THREE.Material,
  x = 0, y = 0, z = 0, seg = 8,
): THREE.Mesh {
  const m = new THREE.Mesh(cylGeo(rt, rb, h, seg), typeof color === 'string' ? mat(color) : color)
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}
export function cone(r: number, h: number, color: string, x = 0, y = 0, z = 0, seg = 6): THREE.Mesh {
  const m = new THREE.Mesh(coneGeo(r, h, seg), mat(color))
  m.position.set(x, y, z)
  m.castShadow = true
  return m
}
/** trojboký hranol ležící podél osy X (sedlová střecha) */
export function prismGeo(w: number, d: number, h: number) {
  const shape = new THREE.Shape()
  shape.moveTo(-w / 2, 0)
  shape.lineTo(w / 2, 0)
  shape.lineTo(0, h)
  shape.closePath()
  const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false })
  g.translate(0, 0, -d / 2)
  g.rotateY(Math.PI / 2)
  return g
}
/** sedlová střecha: trojboký hranol s hřebenem podél X */
export function ridgeRoof(w: number, d: number, h: number, color: string, x = 0, y = 0, z = 0) {
  const g = cached(`rr${w.toFixed(2)}_${d.toFixed(2)}_${h.toFixed(2)}`, () => prismGeo(w, d, h))
  const m = new THREE.Mesh(g, mat(color))
  m.position.set(x, y, z)
  m.castShadow = true
  return m
}
/** pultová/střecha „shed" (pilová střecha továren): N zubů podél X */
export function sawRoof(w: number, d: number, h: number, color: string, teeth = 3,
  x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group()
  const tw = w / teeth
  for (let i = 0; i < teeth; i++) {
    const shape = new THREE.Shape()
    shape.moveTo(-tw / 2, 0)
    shape.lineTo(tw / 2, 0)
    shape.lineTo(tw / 2, h)
    shape.closePath()
    const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false })
    geo.translate(0, 0, -d / 2)
    const m = new THREE.Mesh(geo, mat(color))
    m.position.set(x - w / 2 + tw / 2 + i * tw, y, z)
    m.castShadow = true
    g.add(m)
    // skleněný pásko severní strany
    const glass = new THREE.Mesh(boxGeo(0.06, h * 0.9, d * 0.96), WIN_DARK)
    glass.castShadow = false
    glass.position.set(x - w / 2 + i * tw + 0.06, y + h * 0.45, z)
    glass.rotation.z = -Math.atan2(h, tw) + Math.PI / 2
    g.add(glass)
  }
  return g
}
/** náhodné okna na fasádě: mřížka malých kvádříků, část svítí */
export function windowGrid(
  parent: THREE.Group, w: number, h: number, y0: number,
  side: 'x+' | 'x-' | 'z+' | 'z-', depth: number, seed: number,
) {
  const cols = Math.max(2, Math.round(w / 0.55))
  const rows = Math.max(1, Math.round(h / 0.6))
  let s = Math.floor(seed * 1e4)
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lit = rnd()
      const m = lit < 0.42 ? WIN_LIT_A : lit < 0.62 ? WIN_LIT_B : WIN_DARK
      const u = -w / 2 + (c + 0.5) * (w / cols)
      const y = y0 + (r + 0.5) * (h / rows)
      const win = new THREE.Mesh(boxGeo(0.26, 0.3, 0.06), m)
      win.castShadow = false
      if (side === 'x+' || side === 'x-') {
        win.position.set(u, y, side === 'x+' ? depth / 2 + 0.02 : -depth / 2 - 0.02)
      } else {
        win.rotation.y = Math.PI / 2
        win.position.set(side === 'z+' ? depth / 2 + 0.02 : -depth / 2 - 0.02, y, u)
      }
      parent.add(win)
    }
  }
}
/** komín + registrace kouření (WorldScene animuje puff-y) */
export function chimney(parent: THREE.Group, x: number, z: number, h: number,
  color = '#8d8578', smoke = false): THREE.Mesh {
  const c = cyl(0.14, 0.2, h, color, x, h / 2, z, 7)
  parent.add(c)
  const rim = cyl(0.18, 0.18, 0.1, matShade(color, 0.8), x, h - 0.03, z, 7)
  parent.add(rim)
  if (smoke) c.userData.smoke = { x, y: h + 0.1, z }
  return c
}

/**
 * Terén 3D světa — vypadá jako krajina, ne jako šachovnice zón.
 *
 * - JEDEN heightfield mesh (playable mřížka + prstenec EXT dlaždic kolem):
 *   mírné kopce z value-noise, voda vyhloubená pod hladinu, silnice
 *   srovnané do roviny, zastavěné/vlastněné pozemky mírně zplanované
 *   („upravený terén"), za hranicí světa se zvedají kopce a hory.
 * - Vertex barvy míchají trávu / suchou trávu / hlínu / písek / skálu podle
 *   noise patchů, výšky a sklonu — žádná barva „protože je to zóna".
 *   (Herní zóny zůstávají jen v datech a v inspektoru.)
 * - Animovaná voda: shader s vlnkami z několika sinusovek + fresnel odlesk
 *   oblohy; hladina je pod břehem, takže se objeví jen v prohlubních.
 * - Dekorce: instancované stromy (dvě patra koruny), keře, skály, balvany
 *   a horské štíty po obvodu — krajina pokračuje i za hranicí kamery.
 * - `heightAt(x, z)` drží budovy a vozidla na povrchu.
 */
import * as THREE from 'three'
import type { MapData } from '../../api'
import { TILE, mat } from './materials'

export const EXT = 12                 // prstenec krajiny kolem hřiště (dlaždice)
export const WATER_Y = -0.30          // hladina
const BED_Y = -0.95                   // dno

/* ── value noise (deterministický, hladký) ───────────────────────────────── */
function lattice(ix: number, iy: number, seed: number) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 974711) | 0
  h = ((h ^ (h >> 13)) * 1274126177) | 0
  return ((h ^ (h >> 16)) >>> 0) / 4294967295
}
function vnoise(x: number, y: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const a = lattice(ix, iy, seed), b = lattice(ix + 1, iy, seed)
  const c = lattice(ix, iy + 1, seed), d = lattice(ix + 1, iy + 1, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}
const fbm = (x: number, y: number, seed: number) =>
  vnoise(x, y, seed) * 0.62 + vnoise(x * 2.3 + 17, y * 2.3 + 9, seed + 5) * 0.26
  + vnoise(x * 5.1 + 3, y * 5.1 + 41, seed + 11) * 0.12

export type TerrainBuild = {
  ground: THREE.Mesh
  water: THREE.Mesh
  deco: THREE.Group
  heightAt: (x: number, z: number) => number
  update: (t: number) => void
  half: { x: number; z: number }        // polovina playable rozměru ve world units
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function buildTerrain3d(map: MapData): TerrainBuild {
  const W = map.grid.w, H = map.grid.h
  const type = new Map<string, string>()
  const owned = new Set<string>()
  for (const p of map.plots) {
    type.set(`${p.x},${p.y}`, p.type)
    if (p.owner_id || p.b_id) owned.add(`${p.x},${p.y}`)
  }
  const tileType = (gx: number, gy: number) =>
    type.get(`${Math.max(0, Math.min(W - 1, gx))},${Math.max(0, Math.min(H - 1, gy))}`) ?? 'forest'

  const half = { x: (W * TILE) / 2, z: (H * TILE) / 2 }
  const toG = (x: number, z: number): [number, number] =>
    [x / TILE + (W - 1) / 2, z / TILE + (H - 1) / 2]

  /** výška v mřížkových souřadnicích (dlaždice, i mimo hřiště) */
  const heightG = (gx: number, gy: number): number => {
    // masky ze 4 sousedních dlaždic (vertex leží na rohu čtverice)
    let water = 0, road = 0, graded = 0
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
      const t = tileType(gx + dx, gy + dy)
      if (t === 'water') water++
      if (t === 'road') road++
      if (owned.has(`${gx + dx},${gy + dy}`)) graded++
    }
    const n = fbm(gx * 0.085, gy * 0.085, 7)
    let h = (n - 0.5) * 0.62                       // mírné kopce ±0.31
    h += (fbm(gx * 0.31 + 5, gy * 0.31 + 5, 13) - 0.5) * 0.12
    if (graded > 0) h *= 1 - 0.75 * (graded / 4)   // zastavěno = srovnaný pozemek
    if (road > 0) h *= 1 - 0.9 * (road / 4)        // silnice v rovině
    if (water >= 2) h = BED_Y + (n - 0.5) * 0.3    // prohlubeň s vodou
    else if (water === 1) h = Math.min(h, -0.05) - 0.12  // břeh
    // za hranicí světa: kopce a hory, ať horizont nikdy není prázdný
    const ox = Math.max(0, -gx, gx - (W - 1))
    const oz = Math.max(0, -gy, gy - (H - 1))
    const d = Math.sqrt(ox * ox + oz * oz)
    const up = smooth(1, EXT * 0.85, d)
    h += up * up * 5.5 + up * (fbm(gx * 0.16 + 71, gy * 0.16 + 3, 21) - 0.35) * 3.2
    return h
  }

  const heightAt = (x: number, z: number) => {
    const [gx, gy] = toG(x, z)
    const ix = Math.floor(gx), iy = Math.floor(gy)
    const fx = gx - ix, fy = gy - iy
    const a = heightG(ix, iy), b = heightG(ix + 1, iy)
    const c = heightG(ix, iy + 1), d = heightG(ix + 1, iy + 1)
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
  }

  /* ── heightfield geometrie s vertex barvami ───────────────────────────── */
  const NX = W + EXT * 2, NY = H + EXT * 2
  const cols = NX + 1, rows = NY + 1
  const pos = new Float32Array(cols * rows * 3)
  const col = new Float32Array(cols * rows * 3)
  const idx: number[] = []
  const cGrass1 = new THREE.Color('#4d8a4c')
  const cGrass2 = new THREE.Color('#63a05a')
  const cDry = new THREE.Color('#8fa055')
  const cDirt = new THREE.Color('#7c6a4e')
  const cSand = new THREE.Color('#c8b78c')
  const cRock = new THREE.Color('#7e7869')
  const cSnow = new THREE.Color('#e9edf3')
  const cBed = new THREE.Color('#3c4a44')
  const tmp = new THREE.Color()

  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const gx = ix - EXT, gy = iy - EXT
      const h = heightG(gx, gy)
      const x = (gx - (W - 1) / 2) * TILE
      const z = (gy - (H - 1) / 2) * TILE
      const i = iy * cols + ix
      pos[i * 3] = x; pos[i * 3 + 1] = h; pos[i * 3 + 2] = z
      // sklon pro skálu
      const sl = Math.abs(heightG(gx + 1, gy) - h) + Math.abs(heightG(gx, gy + 1) - h)
      const patch = fbm(gx * 0.17 + 91, gy * 0.17 + 17, 29)     // hlinité patche
      const dry = fbm(gx * 0.12 + 3, gy * 0.12 + 55, 37)        // suchá tráva
      tmp.copy(cGrass1).lerp(cGrass2, vnoise(gx * 0.5, gy * 0.5, 41))
      tmp.lerp(cDry, smooth(0.55, 0.8, dry) * 0.7)
      tmp.lerp(cDirt, smooth(0.6, 0.82, patch) * 0.85)
      tmp.lerp(cRock, smooth(0.28, 0.55, sl))
      if (h > 3.2) tmp.lerp(cSnow, smooth(3.2, 4.6, h))
      if (h < 0.06 && h > WATER_Y - 0.22) tmp.lerp(cSand, smooth(WATER_Y - 0.18, 0.02, h) * 0.9)
      if (h <= WATER_Y - 0.15) tmp.lerp(cBed, smooth(WATER_Y - 0.1, BED_Y + 0.2, h))
      const j = 0.96 + lattice(ix, iy, 61) * 0.08
      col[i * 3] = tmp.r * j; col[i * 3 + 1] = tmp.g * j; col[i * 3 + 2] = tmp.b * j
    }
  }
  for (let iy = 0; iy < rows - 1; iy++) {
    for (let ix = 0; ix < cols - 1; ix++) {
      const a = iy * cols + ix
      // winding proti hodinám při pohledu shora (+Y) → normály nahoru
      idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }))
  ground.receiveShadow = true
  ground.name = 'terrain'

  /* ── animovaná voda ───────────────────────────────────────────────────── */
  const wgeo = new THREE.PlaneGeometry(NX * TILE, NY * TILE, 64, 40)
  const wmat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color('#1c4d6d') },
      uShallow: { value: new THREE.Color('#2f89ad') },
      uSky: { value: new THREE.Color('#a9cbe8') },
    },
    vertexShader: `
      uniform float uTime;
      varying float w;
      varying vec3 vN;
      varying vec3 vView;
      float wave(vec2 p, float t) {
        return sin(p.x * 0.55 + t * 1.3) * 0.05
             + sin(p.y * 0.42 - t * 1.05) * 0.055
             + sin((p.x + p.y) * 0.27 + t * 0.65) * 0.035;
      }
      void main() {
        vec3 p = position;
        float t = uTime;
        w = wave(p.xy, t);
        p.z += w;
        // analytická normála pro odlesky
        float e = 0.35;
        float hx = wave(p.xy + vec2(e, 0.0), t) - wave(p.xy - vec2(e, 0.0), t);
        float hy = wave(p.xy + vec2(0.0, e), t) - wave(p.xy - vec2(0.0, e), t);
        vN = normalize(vec3(-hx / (2.0 * e), -hy / (2.0 * e), 1.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSky;
      varying float w; varying vec3 vN; varying vec3 vView;
      void main() {
        float k = smoothstep(-0.09, 0.09, w);
        vec3 c = mix(uDeep, uShallow, k);
        float fres = pow(1.0 - max(dot(normalize(vN), normalize(vView)), 0.0), 2.2);
        c = mix(c, uSky, fres * 0.55);
        float glint = pow(max(dot(reflect(-normalize(vView), normalize(vN)), vec3(0.35, 0.5, 0.55)), 0.0), 24.0);
        c += vec3(1.0, 0.97, 0.85) * glint * 0.5;
        gl_FragColor = vec4(c, 0.9);
      }`,
  })
  const water = new THREE.Mesh(wgeo, wmat)
  water.rotation.x = -Math.PI / 2
  water.position.y = WATER_Y
  water.name = 'water'

  /* ── dekorce: stromy, keře, skály, hory ───────────────────────────────── */
  const deco = new THREE.Group()
  const trees: { x: number; z: number; s: number; r: number; y: number }[] = []
  const bushes: { x: number; z: number; s: number }[] = []
  const rocks: { x: number; z: number; s: number; r: number }[] = []
  const peaks: { x: number; z: number; s: number; r: number }[] = []
  const rnd = (a: number, b: number) => lattice(a | 0, b | 0, 71) + (a % 1) * 0.13

  for (let gy = -EXT; gy < H + EXT; gy++) {
    for (let gx = -EXT; gx < W + EXT; gx++) {
      const inPlay = gx >= 0 && gy >= 0 && gx < W && gy < H
      const t = inPlay ? type.get(`${gx},${gy}`) : tileType(gx, gy)
      const h = heightG(gx, gy)
      if (h < WATER_Y + 0.12) continue
      const cx = (gx - (W - 1) / 2) * TILE
      const cz = (gy - (H - 1) / 2) * TILE
      const outside = !inPlay
      const density = t === 'forest' ? 2.6 : outside ? 1.5 : 0.22
      const n = rnd(gx * 3.7, gy * 2.9) * density
      for (let i = 0; i < Math.floor(n); i++) {
        const ox = (rnd(gx + i * 13.7, gy + i * 7.1) - 0.5) * TILE * 0.9
        const oz = (rnd(gx + i * 5.3 + 40, gy + i * 11.9) - 0.5) * TILE * 0.9
        trees.push({
          x: cx + ox, z: cz + oz, y: heightAt(cx + ox, cz + oz),
          s: 0.8 + rnd(gx + i * 3.1, gy + i * 9.7) * 0.75,
          r: rnd(gx + i, gy + i * 2) * Math.PI,
        })
      }
      if (rnd(gx * 1.7 + 8, gy * 2.3 + 4) < (t === 'forest' ? 0.5 : 0.16)) {
        bushes.push({ x: cx + (rnd(gx, gy + 3) - 0.5) * TILE, z: cz + (rnd(gx + 9, gy) - 0.5) * TILE, s: 0.5 + rnd(gx + 2, gy + 6) * 0.6 })
      }
      if ((t === 'mine' || h > 1.2) && rnd(gx * 2.1 + 15, gy * 1.3 + 22) < 0.5) {
        rocks.push({ x: cx + (rnd(gx + 4, gy) - 0.5) * TILE, z: cz + (rnd(gx, gy + 7) - 0.5) * TILE, s: 0.5 + rnd(gx + 6, gy + 1) * 0.9, r: rnd(gx + 3, gy + 8) * Math.PI })
      }
      if (outside && h > 2.2 && rnd(gx * 1.1 + 60, gy * 1.7 + 30) < 0.16) {
        peaks.push({ x: cx, z: cz, s: 1.6 + rnd(gx + 12, gy + 24) * 2.6, r: rnd(gx + 40, gy + 50) * Math.PI })
      }
    }
  }

  const put = (
    geoM: THREE.BufferGeometry, m: THREE.Material,
    list: { x: number; z: number; s: number; r?: number; y?: number }[], yOff: number, yScale = 1,
  ) => {
    if (!list.length) return
    const im = new THREE.InstancedMesh(geoM, m, list.length)
    im.castShadow = true
    im.receiveShadow = false
    list.forEach((o, i) => {
      const y = (o.y ?? heightAt(o.x, o.z)) + yOff * o.s * yScale
      im.setMatrixAt(i, new THREE.Matrix4().compose(
        new THREE.Vector3(o.x, y, o.z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), o.r ?? 0),
        new THREE.Vector3(o.s, o.s * yScale, o.s),
      ))
    })
    im.instanceMatrix.needsUpdate = true
    deco.add(im)
  }
  const trunkG = new THREE.CylinderGeometry(0.06, 0.1, 0.42, 5)
  const crown1G = new THREE.ConeGeometry(0.34, 0.62, 6)
  const crown2G = new THREE.ConeGeometry(0.24, 0.5, 6)
  const bushG = new THREE.IcosahedronGeometry(0.2, 0)
  const rockG = new THREE.DodecahedronGeometry(0.18, 0)
  const peakG = new THREE.ConeGeometry(1.1, 1.6, 5)
  for (const g of [trunkG, crown1G, crown2G, bushG, rockG, peakG]) g.userData.cached = true
  put(trunkG, mat('#6b4c2c'), trees, 0.2)
  put(crown1G, mat('#3d7a48'), trees, 0.62)
  put(crown2G, mat('#4c8f55'), trees, 1.02)
  put(bushG, mat('#40704a'), bushes, 0.12, 0.7)
  put(rockG, mat('#847d6e'), rocks, 0.06, 0.75)
  put(peakG, mat('#767062'), peaks, 0.7)

  const update = (t: number) => { wmat.uniforms.uTime.value = t }

  return { ground, water, deco, heightAt, update, half }
}

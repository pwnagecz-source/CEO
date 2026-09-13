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

export const EXT = 14                 // prstenec krajiny kolem hřiště (dlaždice)
export const WATER_Y = -0.30          // hladina
const BED_Y = -0.95                   // dno

/* ── value noise (deterministický, hladký) ───────────────────────────────── */
function lattice(ix: number, iy: number, seed: number) {
  // xorshift mix s LOGICKÝMI posuny — jinak se sign bit vyruší a noise
  // žije jen v [0, 0.5] (plochý svět, mrtvé masky)
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974711)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
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

  /** bilineární sampling po-tileových masek → hladké flattenování pod dlaždici */
  const bil = (f: (gx: number, gy: number) => number, gx: number, gy: number) => {
    const ix = Math.floor(gx), iy = Math.floor(gy)
    const fx = gx - ix, fy = gy - iy
    const a = f(ix, iy), b = f(ix + 1, iy), c = f(ix, iy + 1), d = f(ix + 1, iy + 1)
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
  }
  const tW = (gx: number, gy: number) => (tileType(gx, gy) === 'water' ? 1 : 0)
  const tR = (gx: number, gy: number) => (tileType(gx, gy) === 'road' ? 1 : 0)
  const tG = (gx: number, gy: number) => (owned.has(`${gx},${gy}`) ? 1 : 0)

  /** spojitá výška v mřížkových souřadnicích (dlaždice i mimo hřiště) */
  const heightGF = (gx: number, gy: number): number => {
    const waterF = bil(tW, gx, gy), roadF = bil(tR, gx, gy), gradedF = bil(tG, gx, gy)
    const n = fbm(gx * 0.075, gy * 0.075, 7)
    let h = (n - 0.5) * 1.35                        // vlnité kopce ±0.68
    h += (fbm(gx * 0.21 + 5, gy * 0.21 + 5, 13) - 0.5) * 0.45
    h += (fbm(gx * 0.55 + 9, gy * 0.55 + 2, 17) - 0.5) * 0.12
    if (gradedF > 0) h *= 1 - 0.8 * gradedF         // zastavěno = srovnaný pozemek
    if (roadF > 0) h *= 1 - 0.95 * Math.min(1, roadF * 2)  // silnice v rovině
    const lake = smooth(0.78, 0.9, fbm(gx * 0.035 + 140, gy * 0.035 - 60, 51))
    if (waterF >= 0.5) h = BED_Y + (n - 0.5) * 0.35         // příkop kolem ostrova
    else if (waterF >= 0.25) h = Math.min(h, -0.02) - 0.10  // břeh s pláží
    else if (lake > 0) h = Math.min(h, h + (BED_Y + 0.1 - h) * lake)  // jezera
    else if (h < WATER_Y + 0.07) {                  // údolí: měkké dno nad vodou
      const t = WATER_Y + 0.07
      h = t + (h - t) * 0.12
    }
    // za hranicí světa: kopce a hory, ať horizont nikdy není prázdný
    const ox = Math.max(0, -gx, gx - (W - 1))
    const oz = Math.max(0, -gy, gy - (H - 1))
    const d = Math.sqrt(ox * ox + oz * oz)
    const up = smooth(2, EXT * 0.8, d)
    h += up * up * 8.5 + up * (fbm(gx * 0.16 + 71, gy * 0.16 + 3, 21) - 0.35) * 4.0
    return h
  }

  const heightAt = (x: number, z: number) => {
    const [gx, gy] = toG(x, z)
    return heightGF(gx, gy)
  }

  /* ── heightfield geometrie s vertex barvami ───────────────────────────── */
  const NX = W + EXT * 2, NY = H + EXT * 2
  const SUB = 2                                   // 2 vertexy na dlaždici = ostré barvy
  const cols = NX * SUB + 1, rows = NY * SUB + 1
  const pos = new Float32Array(cols * rows * 3)
  const col = new Float32Array(cols * rows * 3)
  const hs = new Float32Array(cols * rows)
  const idx: number[] = []
  const cGrass1 = new THREE.Color('#4f9048')
  const cGrass2 = new THREE.Color('#6cae55')
  const cDry = new THREE.Color('#9dad55')
  const cDirt = new THREE.Color('#8a7150')
  const cSand = new THREE.Color('#d3bf8e')
  const cRock = new THREE.Color('#87816f')
  const cSnow = new THREE.Color('#eef2f7')
  const cBed = new THREE.Color('#4a5a50')
  const cGravel = new THREE.Color('#7d7460')
  const tmp = new THREE.Color()

  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const gx = ix / SUB - EXT, gy = iy / SUB - EXT
      const h = heightGF(gx, gy)
      const i = iy * cols + ix
      hs[i] = h
      pos[i * 3] = (gx - (W - 1) / 2) * TILE
      pos[i * 3 + 1] = h
      pos[i * 3 + 2] = (gy - (H - 1) / 2) * TILE
    }
  }
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const gx = ix / SUB - EXT, gy = iy / SUB - EXT
      const i = iy * cols + ix
      const h = hs[i]
      // sklon pro skálu (půltilecový krok)
      const sl = Math.abs(hs[Math.min(i + 1, cols * rows - 1)] - h)
        + Math.abs(hs[Math.min(i + cols, cols * rows - 1)] - h)
      const patch = fbm(gx * 0.17 + 91, gy * 0.17 + 17, 29)     // hlinité patche
      const dry = fbm(gx * 0.12 + 3, gy * 0.12 + 55, 37)        // suchá tráva
      const rd = bil(tR, gx, gy)
      tmp.copy(cGrass1).lerp(cGrass2, vnoise(gx * 0.5, gy * 0.5, 41))
      tmp.lerp(cDry, smooth(0.52, 0.78, dry) * 0.75)
      tmp.lerp(cDirt, smooth(0.56, 0.8, patch) * 0.9)
      tmp.lerp(cRock, smooth(0.16, 0.36, sl))
      if (rd > 0.01 && rd < 0.99) tmp.lerp(cGravel, Math.max(0, 0.72 - rd * 0.55))
      if (h > 4.2) tmp.lerp(cSnow, smooth(4.2, 6.6, h))
      if (h < 0.06 && h > WATER_Y - 0.22) tmp.lerp(cSand, smooth(WATER_Y - 0.18, 0.02, h) * 0.9)
      if (h <= WATER_Y - 0.15) tmp.lerp(cBed, smooth(WATER_Y - 0.1, BED_Y + 0.2, h))
      // jemný šum + cavity AO: údolí tmavší, hřbety světlejší → ostrý dojem
      const inner = ix > 0 && iy > 0 && ix < cols - 1 && iy < rows - 1
      const cav = inner ? h * 4 - (hs[i - 1] + hs[i + 1] + hs[i - cols] + hs[i + cols]) : 0
      const j = 0.94 + lattice(ix, iy, 61) * 0.10
        + (vnoise(gx * 1.9, gy * 1.9, 71) - 0.5) * 0.10
        + Math.max(-0.22, Math.min(0.1, cav * 0.5))
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
  const wgeo = new THREE.PlaneGeometry(NX * TILE, NY * TILE, 96, 60)
  const wmat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color('#17567c') },
      uShallow: { value: new THREE.Color('#2f92b4') },
      uSky: { value: new THREE.Color('#bfe0f2') },
      uDim: { value: 1 },
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
      uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSky; uniform float uDim;
      varying float w; varying vec3 vN; varying vec3 vView;
      void main() {
        float k = smoothstep(-0.09, 0.09, w);
        vec3 c = mix(uDeep, uShallow, k);
        float fres = pow(1.0 - max(dot(normalize(vN), normalize(vView)), 0.0), 2.2);
        c = mix(c, uSky, fres * 0.55);
        float glint = pow(max(dot(reflect(-normalize(vView), normalize(vN)), vec3(0.35, 0.5, 0.55)), 0.0), 24.0);
        c += vec3(1.0, 0.97, 0.85) * glint * 0.5;
        gl_FragColor = vec4(c * uDim, 0.88);
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
  const caps: { x: number; z: number; s: number; y: number }[] = []
  const rnd = (a: number, b: number) => lattice(a | 0, b | 0, 71) + (a % 1) * 0.13

  for (let gy = -EXT; gy < H + EXT; gy++) {
    for (let gx = -EXT; gx < W + EXT; gx++) {
      const inPlay = gx >= 0 && gy >= 0 && gx < W && gy < H
      const t = inPlay ? type.get(`${gx},${gy}`) : tileType(gx, gy)
      const h = heightGF(gx + 0.5, gy + 0.5)
      if (h < WATER_Y + 0.12) continue
      const cx = (gx - (W - 1) / 2) * TILE
      const cz = (gy - (H - 1) / 2) * TILE
      const outside = !inPlay
      const cluster = fbm(gx * 0.09 + 7, gy * 0.09 - 3, 61)
      const density = t === 'forest' ? 1.5 + smooth(0.42, 0.68, cluster) * 3.6
        : outside ? 1.2 + smooth(0.4, 0.66, cluster) * 2.6 : 0.18
      const n = rnd(gx * 3.7, gy * 2.9) * density
      for (let i = 0; i < Math.floor(n); i++) {
        const ox = (rnd(gx + i * 13.7, gy + i * 7.1) - 0.5) * TILE * 0.9
        const oz = (rnd(gx + i * 5.3 + 40, gy + i * 11.9) - 0.5) * TILE * 0.9
        trees.push({
          x: cx + ox, z: cz + oz, y: heightAt(cx + ox, cz + oz),
          s: (0.85 + rnd(gx + i * 3.1, gy + i * 9.7) * 0.8) * 2.05,
          r: rnd(gx + i, gy + i * 2) * Math.PI,
        })
      }
      if (rnd(gx * 1.7 + 8, gy * 2.3 + 4) < (t === 'forest' ? 0.35 : cluster > 0.55 ? 0.28 : 0.04)) {
        bushes.push({ x: cx + (rnd(gx, gy + 3) - 0.5) * TILE, z: cz + (rnd(gx + 9, gy) - 0.5) * TILE, s: (0.5 + rnd(gx + 2, gy + 6) * 0.6) * 1.6 })
      }
      if ((t === 'mine' || h > 1.2) && rnd(gx * 2.1 + 15, gy * 1.3 + 22) < 0.5) {
        rocks.push({ x: cx + (rnd(gx + 4, gy) - 0.5) * TILE, z: cz + (rnd(gx, gy + 7) - 0.5) * TILE, s: (0.5 + rnd(gx + 6, gy + 1) * 0.9) * 1.5, r: rnd(gx + 3, gy + 8) * Math.PI })
      }
      if (outside && h > 2.6 && rnd(gx * 1.1 + 60, gy * 1.7 + 30) < 0.2) {
        const ps = 2.0 + rnd(gx + 12, gy + 24) * 3.2
        peaks.push({ x: cx, z: cz, s: ps, r: rnd(gx + 40, gy + 50) * Math.PI })
        caps.push({ x: cx, z: cz, s: ps * 0.42, y: h + ps * 0.62 })
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
    return im
  }
  /** šedá variace instanceColor → les nežije jako jedna barva */
  const vary = (im: THREE.InstancedMesh, lo: number, hi: number, seed: number) => {
    const c = new THREE.Color()
    for (let i = 0; i < im.count; i++) {
      const j = lo + lattice(i, seed, 91) * (hi - lo)
      im.setColorAt(i, c.setRGB(j, j, j))
    }
    if (im.instanceColor) im.instanceColor.needsUpdate = true
  }
  const trunkG = new THREE.CylinderGeometry(0.06, 0.1, 0.42, 5)
  const crown1G = new THREE.ConeGeometry(0.34, 0.62, 6)
  const crown2G = new THREE.ConeGeometry(0.24, 0.5, 6)
  const bushG = new THREE.IcosahedronGeometry(0.2, 0)
  const rockG = new THREE.DodecahedronGeometry(0.18, 0)
  const peakG = new THREE.ConeGeometry(1.1, 1.6, 5)
  for (const g of [trunkG, crown1G, crown2G, bushG, rockG, peakG]) g.userData.cached = true
  put(trunkG, mat('#6b4c2c'), trees, 0.2)
  vary(put(crown1G, mat('#3f8049'), trees, 0.62)!, 0.8, 1.18, 3)
  vary(put(crown2G, mat('#4f9457'), trees, 1.02)!, 0.82, 1.2, 4)
  vary(put(bushG, mat('#4a7f4d'), bushes, 0.12, 0.7)!, 0.8, 1.2, 5)
  vary(put(rockG, mat('#847d6e'), rocks, 0.06, 0.75)!, 0.85, 1.15, 6)
  vary(put(peakG, mat('#767062'), peaks, 0.7)!, 0.85, 1.12, 7)
  put(new THREE.ConeGeometry(1.1, 0.9, 5), mat('#e8edf4', { flat: true }), caps, 0.35)

  const update = (t: number) => { wmat.uniforms.uTime.value = t }

  return { ground, water, deco, heightAt, update, half }
}

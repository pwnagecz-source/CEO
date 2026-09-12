/**
 * 3D scéna světa (Three.js, stylizovaný low-poly).
 *
 * Nahrazuje dřívější Canvas 2D renderer, ale drží stejné rozhraní vůči Reactu:
 * `setMap` / `applyPlots` / `setRoutes` / `setClock` + callbacky hover/select.
 *
 * - terén: InstancedMesh per biom (1 draw call na typ) + stromy/skály jako instance
 * - silnice: asfalt + obrubníky + přerušovaná osa dle sousedství (jako 2D verze)
 * - budovy: procedurální groupy z buildings3d.ts, patra jako `floor-N` podgroupy
 * - den/noc: sdílené emissive materiály (okna/neony) + barva slunce, oblohy a mlhy
 * - kamera: OrbitControls — levé tlačítko posun, kolečko zoom, pravé natáčení
 *   (polar úhel držený v izometrickém pásmu)
 * - picking: raycast proti instancím terénu (instanceId → plot)
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { MapData, MapPlot, TransportRoute } from '../../api'
import { FALLBACK_TERRAIN, TERRAIN } from '../art'
import { ownerColor } from '../iso'
import { buildBuilding, buildConstruction, type Anim } from './buildings3d'
import { makeShip, makeTruck } from './vehicles3d'
import { TILE, box, isCachedGeo, mat, NIGHT_MATS } from './materials'

export type SceneCallbacks = {
  onHover: (plot: MapPlot | null, cx: number, cy: number) => void
  onSelect: (plot: MapPlot | null) => void
}

const CARGO_COLORS = ['#c0453c', '#4f83d8', '#3ddc97', '#ffc266', '#b06459', '#8b7bff']
const TILES_PER_HOUR = { truck: 8, ship: 5 }
const SEC_PER_HOUR = 12           // při rychlosti 1× uběhne 1 herní hodina za 12 s
const hash2 = (x: number, y: number, s = 0) => {
  let h = (x * 374761393 + y * 668265263 + s * 974711) | 0
  h = ((h ^ (h >> 13)) * 1274126177) | 0
  return ((h ^ (h >> 16)) >>> 0) / 4294967295
}

type Lane = { pts: THREE.Vector3[]; cum: number[]; len: number; kind: 'truck' | 'ship' }
type Vehicle = { g: THREE.Group; lane: Lane; off: number; kind: 'truck' | 'ship' }

const landMat = () => mat('#ffffff')
const SMOKE_MAT = new THREE.MeshLambertMaterial({
  color: 0xbfc4cc, transparent: true, opacity: 0.32, depthWrite: false,
})
const PUFF_GEO = new THREE.SphereGeometry(0.1, 6, 5)
PUFF_GEO.userData.cached = true

const BG_DAY = new THREE.Color('#9ec4e8')
const BG_NIGHT = new THREE.Color('#0b1226')
const BG_DUSK = new THREE.Color('#e8956a')
const SUN_NOON = new THREE.Color('#ffe3b3')
const SUN_SET = new THREE.Color('#ff8a4a')
const HEMI_DAY = new THREE.Color('#bcd7ff')
const HEMI_NIGHT = new THREE.Color('#26365e')

export class WorldScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private cb: SceneCallbacks
  private container: HTMLElement
  private ro: ResizeObserver
  private raf = 0
  private disposed = false
  private lastT = 0

  private sun: THREE.DirectionalLight
  private hemi: THREE.HemisphereLight
  private bg = new THREE.Color()

  private grid = { w: 0, h: 0 }
  private plots = new Map<string, MapPlot>()
  private terrainGroup = new THREE.Group()
  private decoGroup = new THREE.Group()
  private roadGroup = new THREE.Group()
  private vehGroup = new THREE.Group()
  private rootGroup = new THREE.Group()
  private buildGroups = new Map<string, THREE.Group>()
  private ownerGroups = new Map<string, THREE.Group>()
  private pickMeshes: THREE.Mesh[] = []
  private selFrame: THREE.Group
  private hovFrame: THREE.Group
  private selId: string | null = null
  private hovId: string | null = null

  private lanes: Lane[] = []
  private vehicles: Vehicle[] = []
  private speed = 1
  private hourAbs = 12

  private downAt: { x: number; y: number } | null = null
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()

  constructor(container: HTMLElement, cb: SceneCallbacks) {
    this.container = container
    this.cb = cb
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth || 800, container.clientHeight || 600, false)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    container.appendChild(this.renderer.domElement)

    this.scene.background = this.bg
    this.scene.fog = new THREE.Fog(this.bg.getHex(), 80, 230)

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 500)
    this.camera.position.set(34, 30, 34)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.09
    this.controls.screenSpacePanning = false
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE,
    }
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }
    this.controls.minPolarAngle = 0.62
    this.controls.maxPolarAngle = 1.16
    this.controls.minDistance = 8
    this.controls.maxDistance = 130
    this.controls.rotateSpeed = 0.55
    this.controls.zoomSpeed = 0.9
    this.controls.panSpeed = 0.95
    this.controls.addEventListener('change', () => this.clampTarget())

    this.hemi = new THREE.HemisphereLight(0xbcd7ff, 0x3a4a3a, 0.85)
    this.scene.add(this.hemi)
    this.sun = new THREE.DirectionalLight(0xffe3b3, 1.7)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const sc = this.sun.shadow.camera
    sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95
    sc.near = 1; sc.far = 320
    this.sun.shadow.bias = -0.0006
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)

    // podklad mimo herní mřížku
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), mat('#2c3a30'))
    outer.rotation.x = -Math.PI / 2
    outer.position.y = -0.5
    outer.receiveShadow = true
    this.rootGroup.add(outer)
    this.rootGroup.add(this.terrainGroup, this.decoGroup, this.roadGroup, this.vehGroup)
    this.scene.add(this.rootGroup)

    this.selFrame = this.makeFrame('#3ddc97', 0.95)
    this.hovFrame = this.makeFrame('#ffffff', 0.5)
    this.hovFrame.visible = false
    this.scene.add(this.selFrame, this.hovFrame)

    const el = this.renderer.domElement
    el.addEventListener('pointermove', this.onMove)
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointerup', this.onUp)
    el.addEventListener('pointerleave', () => {
      this.setHover(null)
      this.cb.onHover(null, 0, 0)
    })
    el.addEventListener('contextmenu', (e) => e.preventDefault())

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()
    this.updateDayNight()
    this.lastT = performance.now()
    const loop = (t: number) => {
      if (this.disposed) return
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min(0.1, (t - this.lastT) / 1000)
      this.lastT = t
      this.tick(dt, t / 1000)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    this.raf = requestAnimationFrame(loop)
  }

  /* ── souřadnice ───────────────────────────────────────────────────────── */
  private tilePos(x: number, y: number): THREE.Vector3 {
    return new THREE.Vector3(
      (x - (this.grid.w - 1) / 2) * TILE, 0, (y - (this.grid.h - 1) / 2) * TILE,
    )
  }

  private clampTarget() {
    const hx = (this.grid.w / 2) * TILE + 6
    const hz = (this.grid.h / 2) * TILE + 6
    const t = this.controls.target
    t.x = Math.max(-hx, Math.min(hx, t.x))
    t.z = Math.max(-hz, Math.min(hz, t.z))
    t.y = 0
  }

  private resize() {
    const w = this.container.clientWidth || 800
    const h = this.container.clientHeight || 600
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /* ── mapa ─────────────────────────────────────────────────────────────── */
  setMap(map: MapData) {
    this.grid = map.grid
    this.plots.clear()
    for (const p of map.plots) this.plots.set(p.id, p)
    this.clearGroup(this.terrainGroup)
    this.clearGroup(this.decoGroup)
    this.clearGroup(this.roadGroup)
    for (const g of this.buildGroups.values()) this.disposeBuildingGroup(g)
    this.buildGroups.clear()
    for (const g of this.ownerGroups.values()) this.clearGroup(g, true)
    this.ownerGroups.clear()
    this.pickMeshes = []

    this.buildTerrain(map)
    this.buildDeco(map)
    this.buildRoads(map)
    for (const p of map.plots) {
      if (p.b_id) this.addBuilding(p)
      if (p.owner_id) this.addOwnerFrame(p)
    }
    this.controls.target.set(0, 0, 0)
    this.resetView()
  }

  /** přírůstkové změny z SSE delta */
  applyPlots(changed: MapPlot[]) {
    let roadsDirty = false
    for (const p of changed) {
      const old = this.plots.get(p.id)
      this.plots.set(p.id, p)
      const wasRoad = old ? (old.type === 'road' || old.b_code === 'road') : false
      const isRoad = p.type === 'road' || p.b_code === 'road'
      if (wasRoad !== isRoad) roadsDirty = true
      const oldSig = old ? `${old.b_id}|${old.b_code}|${old.b_status}|${old.b_level}` : '|'
      const newSig = `${p.b_id}|${p.b_code}|${p.b_status}|${p.b_level}`
      if (oldSig !== newSig) {
        const prev = this.buildGroups.get(p.id)
        if (prev) { this.disposeBuildingGroup(prev); this.buildGroups.delete(p.id) }
        if (p.b_id) this.addBuilding(p)
      }
      if (old?.owner_id !== p.owner_id) {
        const prev = this.ownerGroups.get(p.id)
        if (prev) { this.clearGroup(prev, true); this.ownerGroups.delete(p.id) }
        if (p.owner_id) this.addOwnerFrame(p)
      }
    }
    if (roadsDirty) {
      this.clearGroup(this.roadGroup)
      const map: MapData = { grid: this.grid, plots: [...this.plots.values()] }
      this.buildRoads(map)
    }
    if (this.selId && !this.plots.get(this.selId)) this.setSelected(null)
  }

  private buildTerrain(map: MapData) {
    const byType = new Map<string, MapPlot[]>()
    for (const p of map.plots) {
      const k = p.type === 'road' ? 'unowned' : p.type
      const arr = byType.get(k)
      if (arr) arr.push(p); else byType.set(k, [p])
    }
    const geo = new THREE.BoxGeometry(TILE * 0.99, 0.14, TILE * 0.99)
    geo.userData.cached = true
    for (const [type, list] of byType) {
      const water = type === 'water'
      const m = new THREE.InstancedMesh(geo, landMat(), list.length)
      m.receiveShadow = true
      m.castShadow = false
      const base = new THREE.Color((TERRAIN[type] ?? FALLBACK_TERRAIN).fill)
      if (water) base.multiplyScalar(0.9)
      const c = new THREE.Color()
      const ids: string[] = []
      list.forEach((p, i) => {
        const pos = this.tilePos(p.x, p.y)
        pos.y = water ? -0.22 : -0.07
        m.setMatrixAt(i, new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z))
        const j = 0.92 + hash2(p.x, p.y, 3) * 0.16
        c.copy(base).multiplyScalar(j)
        m.setColorAt(i, c)
        ids.push(p.id)
      })
      m.instanceMatrix.needsUpdate = true
      if (m.instanceColor) m.instanceColor.needsUpdate = true
      m.userData.plotIds = ids
      this.terrainGroup.add(m)
      this.pickMeshes.push(m)
    }
  }

  private buildDeco(map: MapData) {
    const trees: { x: number; z: number; s: number; r: number }[] = []
    const rocks: { x: number; z: number; s: number; r: number }[] = []
    for (const p of map.plots) {
      if (p.b_id || p.owner_id) continue
      if (p.type === 'forest') {
        const n = Math.floor(hash2(p.x, p.y, 11) * 3)
        for (let i = 0; i < n; i++) {
          trees.push({
            x: p.x + (hash2(p.x, p.y, 20 + i) - 0.5) * 0.8,
            z: p.y + (hash2(p.x, p.y, 30 + i) - 0.5) * 0.8,
            s: 0.75 + hash2(p.x, p.y, 40 + i) * 0.6,
            r: hash2(p.x, p.y, 50 + i) * Math.PI,
          })
        }
      } else if (p.type === 'mine') {
        const n = Math.floor(hash2(p.x, p.y, 13) * 2.4)
        for (let i = 0; i < n; i++) {
          rocks.push({
            x: p.x + (hash2(p.x, p.y, 60 + i) - 0.5) * 0.9,
            z: p.y + (hash2(p.x, p.y, 70 + i) - 0.5) * 0.9,
            s: 0.5 + hash2(p.x, p.y, 80 + i) * 0.7,
            r: hash2(p.x, p.y, 90 + i) * Math.PI,
          })
        }
      }
    }
    if (trees.length) {
      const trunkGeo = new THREE.CylinderGeometry(0.05, 0.08, 0.3, 5)
      const crownGeo = new THREE.ConeGeometry(0.3, 0.72, 6)
      trunkGeo.userData.cached = true; crownGeo.userData.cached = true
      const trunks = new THREE.InstancedMesh(trunkGeo, mat('#6b4c2c'), trees.length)
      const crowns = new THREE.InstancedMesh(crownGeo, mat('#3f7d4c'), trees.length)
      crowns.castShadow = true
      const c = new THREE.Color()
      trees.forEach((t, i) => {
        const pos = this.tilePos(Math.round(t.x), Math.round(t.z))
        const ox = (t.x - Math.round(t.x)) * TILE
        const oz = (t.z - Math.round(t.z)) * TILE
        const mtx = new THREE.Matrix4().compose(
          new THREE.Vector3(pos.x + ox, 0.15 * t.s, pos.z + oz),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.r),
          new THREE.Vector3(t.s, t.s, t.s),
        )
        trunks.setMatrixAt(i, mtx)
        const mtx2 = mtx.clone()
        mtx2.setPosition(pos.x + ox, 0.66 * t.s, pos.z + oz)
        crowns.setMatrixAt(i, mtx2)
        c.set('#3f7d4c').multiplyScalar(0.85 + hash2(i, 7, 1) * 0.35)
        crowns.setColorAt(i, c)
      })
      trunks.instanceMatrix.needsUpdate = true
      crowns.instanceMatrix.needsUpdate = true
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true
      this.decoGroup.add(trunks, crowns)
    }
    if (rocks.length) {
      const rockGeo = new THREE.DodecahedronGeometry(0.16, 0)
      rockGeo.userData.cached = true
      const rm = new THREE.InstancedMesh(rockGeo, mat('#847a6c'), rocks.length)
      rm.castShadow = true
      rocks.forEach((r, i) => {
        const pos = this.tilePos(Math.round(r.x), Math.round(r.z))
        const ox = (r.x - Math.round(r.x)) * TILE
        const oz = (r.z - Math.round(r.z)) * TILE
        const mtx = new THREE.Matrix4().compose(
          new THREE.Vector3(pos.x + ox, 0.06, pos.z + oz),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.r),
          new THREE.Vector3(r.s, r.s * 0.7, r.s),
        )
        rm.setMatrixAt(i, mtx)
      })
      rm.instanceMatrix.needsUpdate = true
      this.decoGroup.add(rm)
    }
  }

  private buildRoads(map: MapData) {
    const roadSet = new Set<string>()
    for (const p of map.plots) {
      if (p.type === 'road' || p.b_code === 'road') roadSet.add(`${p.x},${p.y}`)
    }
    const tiles = [...roadSet].map((k) => k.split(',').map(Number) as [number, number])
    if (!tiles.length) return
    const asphaltGeo = new THREE.BoxGeometry(TILE, 0.08, TILE)
    const curbGeo = new THREE.BoxGeometry(TILE + 0.12, 0.05, TILE + 0.12)
    const dashGeo = new THREE.BoxGeometry(0.34, 0.02, 0.1)
    asphaltGeo.userData.cached = true; curbGeo.userData.cached = true; dashGeo.userData.cached = true
    const asphalt = new THREE.InstancedMesh(asphaltGeo, mat('#3d434d'), tiles.length)
    const curb = new THREE.InstancedMesh(curbGeo, mat('#2a2f37'), tiles.length)
    asphalt.receiveShadow = true
    const dashes: { x: number; z: number; rot: number }[] = []
    tiles.forEach(([x, y], i) => {
      const pos = this.tilePos(x, y)
      asphalt.setMatrixAt(i, new THREE.Matrix4().makeTranslation(pos.x, 0.02, pos.z))
      curb.setMatrixAt(i, new THREE.Matrix4().makeTranslation(pos.x, -0.015, pos.z))
      const ne = roadSet.has(`${x + 1},${y - 1}`); const sw = roadSet.has(`${x - 1},${y + 1}`)
      const nw = roadSet.has(`${x - 1},${y - 1}`); const se = roadSet.has(`${x + 1},${y + 1}`)
      const n = roadSet.has(`${x},${y - 1}`); const s = roadSet.has(`${x},${y + 1}`)
      const w = roadSet.has(`${x - 1},${y}`); const e = roadSet.has(`${x + 1},${y}`)
      const axisNE = (ne || sw) && !n && !s && !w && !e
      const axisNW = (nw || se) && !n && !s && !w && !e
      const straightNS = (n || s) && !w && !e && !ne && !sw && !nw && !se
      const straightEW = (w || e) && !n && !s && !ne && !sw && !nw && !se
      if (axisNE || straightEW) dashes.push({ x: pos.x, z: pos.z, rot: axisNE ? Math.PI / 4 : Math.PI / 2 })
      else if (axisNW || straightNS) dashes.push({ x: pos.x, z: pos.z, rot: axisNW ? -Math.PI / 4 : 0 })
    })
    asphalt.instanceMatrix.needsUpdate = true
    curb.instanceMatrix.needsUpdate = true
    this.roadGroup.add(asphalt, curb)
    if (dashes.length) {
      const dm = new THREE.InstancedMesh(dashGeo, mat('#c9b45c'), dashes.length)
      dashes.forEach((d, i) => {
        dm.setMatrixAt(i, new THREE.Matrix4().compose(
          new THREE.Vector3(d.x, 0.07, d.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.rot),
          new THREE.Vector3(1, 1, 1),
        ))
      })
      dm.instanceMatrix.needsUpdate = true
      this.roadGroup.add(dm)
    }
  }

  /* ── budovy a vlastnictví ─────────────────────────────────────────────── */
  private addBuilding(p: MapPlot) {
    const seed = hash2(p.x, p.y, 17)
    const g = p.b_status === 'construction'
      ? buildConstruction(seed)
      : buildBuilding(p.b_code, {
        level: p.b_level ?? 1,
        producing: p.b_status === 'producing',
        night: 0,
        seed,
        industry: p.b_industry,
        retail: p.b_retail,
      })
    const pos = this.tilePos(p.x, p.y)
    if (p.type === 'water') pos.y = -0.16
    g.position.copy(pos)
    if (p.b_code !== 'harbor') g.rotation.y = Math.floor(hash2(p.x, p.y, 5) * 4) * (Math.PI / 2)
    // kouřové puff-y z komínů
    const smokes: { m: THREE.Mesh; base: THREE.Vector3; ph: number }[] = []
    g.traverse((n) => {
      const s = (n as THREE.Mesh).userData?.smoke
      if (s) {
        for (let i = 0; i < 3; i++) {
          const puff = new THREE.Mesh(PUFF_GEO, SMOKE_MAT)
          puff.castShadow = false
          puff.position.set(pos.x + s.x, pos.y + s.y, pos.z + s.z)
          this.rootGroup.add(puff)
          smokes.push({ m: puff, base: new THREE.Vector3(pos.x + s.x, pos.y + s.y, pos.z + s.z), ph: i / 3 })
        }
      }
    })
    g.userData.smokes = smokes
    this.rootGroup.add(g)
    this.buildGroups.set(p.id, g)
  }

  private disposeBuildingGroup(g: THREE.Group) {
    for (const s of (g.userData.smokes ?? []) as { m: THREE.Mesh }[]) {
      this.rootGroup.remove(s.m)
    }
    this.clearGroup(g, true)
  }

  private addOwnerFrame(p: MapPlot) {
    const col = ownerColor(p.owner_id)
    const g = new THREE.Group()
    const m = mat(col, { transparent: 0.75 })
    const t = 0.07
    const L = TILE * 0.98
    g.add(box(L, 0.03, t, m, 0, 0.015, -L / 2))
    g.add(box(L, 0.03, t, m, 0, 0.015, L / 2))
    g.add(box(t, 0.03, L, m, -L / 2, 0.015, 0))
    g.add(box(t, 0.03, L, m, L / 2, 0.015, 0))
    const pos = this.tilePos(p.x, p.y)
    g.position.set(pos.x, 0.0, pos.z)
    this.rootGroup.add(g)
    this.ownerGroups.set(p.id, g)
  }

  private makeFrame(color: string, opacity: number) {
    const g = new THREE.Group()
    const m = mat(color, { transparent: opacity })
    const t = 0.1
    const L = TILE * 1.02
    g.add(box(L, 0.05, t, m, 0, 0.04, -L / 2))
    g.add(box(L, 0.05, t, m, 0, 0.04, L / 2))
    g.add(box(t, 0.05, L, m, -L / 2, 0.04, 0))
    g.add(box(t, 0.05, L, m, L / 2, 0.04, 0))
    return g
  }

  setSelected(id: string | null) {
    this.selId = id
    if (!id) { this.selFrame.visible = false; return }
    const p = this.plots.get(id)
    if (!p) { this.selFrame.visible = false; return }
    const pos = this.tilePos(p.x, p.y)
    this.selFrame.position.set(pos.x, 0, pos.z)
    this.selFrame.visible = true
  }

  private setHover(id: string | null) {
    if (id === this.hovId) return
    this.hovId = id
    if (!id) { this.hovFrame.visible = false; return }
    const p = this.plots.get(id)
    if (!p) { this.hovFrame.visible = false; return }
    const pos = this.tilePos(p.x, p.y)
    this.hovFrame.position.set(pos.x, 0, pos.z)
    this.hovFrame.visible = true
  }

  /* ── trasy a vozidla ──────────────────────────────────────────────────── */
  setRoutes(routes: TransportRoute[]) {
    this.clearGroup(this.vehGroup, true)
    this.lanes = []
    this.vehicles = []
    for (const r of routes) {
      if (r.status !== 'active' || r.path.length < 2) continue
      const pts = r.path.map((pt) => {
        const v = this.tilePos(pt.x, pt.y)
        v.y = r.mode === 'ship' ? 0.03 : 0.14
        return v
      })
      const cum = [0]
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]))
      const len = cum[cum.length - 1]
      if (len < 0.5) continue
      const lane: Lane = { pts, cum, len, kind: r.mode }
      this.lanes.push(lane)
      const color = CARGO_COLORS[(this.lanes.length - 1) % CARGO_COLORS.length] ?? '#c0453c'
      // čárkovaná linka trasy
      const lg = new THREE.BufferGeometry().setFromPoints(pts)
      const line = new THREE.Line(lg, new THREE.LineDashedMaterial({
        color: 0xffffff, transparent: true, opacity: 0.28, dashSize: 0.35, gapSize: 0.3,
      }))
      line.computeLineDistances()
      this.vehGroup.add(line)
      for (let i = 0; i < r.vehicles; i++) {
        const g = r.mode === 'ship' ? makeShip(color) : makeTruck(color)
        g.traverse((n) => { if ((n as THREE.Mesh).isMesh) n.castShadow = true })
        this.vehGroup.add(g)
        this.vehicles.push({ g, lane, off: i / r.vehicles, kind: r.mode })
      }
    }
  }

  private pointAt(lane: Lane, t: number, out: THREE.Vector3) {
    const d = (((t % 1) + 1) % 1) * lane.len
    let i = 1
    while (i < lane.cum.length - 1 && lane.cum[i] < d) i++
    const a = lane.pts[i - 1]; const b = lane.pts[i]
    const seg = lane.cum[i] - lane.cum[i - 1] || 1
    const f = (d - lane.cum[i - 1]) / seg
    out.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f)
    return out
  }

  /* ── čas, den/noc ─────────────────────────────────────────────────────── */
  setClock(speed: number, hour: number) {
    this.speed = speed
    const frac = this.hourAbs - Math.floor(this.hourAbs)
    this.hourAbs = hour + frac
    this.updateDayNight()
  }

  private updateDayNight() {
    const h = ((this.hourAbs % 24) + 24) % 24
    let night = 0
    if (h >= 21 || h < 4) night = 1
    else if (h >= 19) night = (h - 19) / 2
    else if (h < 6) night = (6 - h) / 2
    for (const { m, min, max } of NIGHT_MATS) m.emissiveIntensity = min + (max - min) * night

    const theta = ((h - 6) / 12) * Math.PI           // 6 h východ, 12 h zenit, 18 h západ
    const elev = Math.sin(theta)
    this.sun.position.set(Math.cos(theta) * 80, Math.max(elev, -0.35) * 70 + 10, 34)
    this.sun.intensity = Math.max(0.06, elev * 1.75)
    const dusk = Math.max(0, 1 - Math.abs(elev) * 4) * (elev > -0.3 ? 1 : 0)
    this.sun.color.copy(SUN_NOON).lerp(SUN_SET, dusk * 0.8)
    this.hemi.intensity = 0.85 - 0.62 * night
    this.hemi.color.copy(HEMI_DAY).lerp(HEMI_NIGHT, night)
    this.bg.copy(BG_DAY).lerp(BG_NIGHT, night)
    if (dusk > 0.02 && night < 0.9) this.bg.lerp(BG_DUSK, dusk * 0.45 * (1 - night))
    ;(this.scene.fog as THREE.Fog).color.copy(this.bg)
  }

  /* ── snímek ───────────────────────────────────────────────────────────── */
  private tmpA = new THREE.Vector3()
  private tmpB = new THREE.Vector3()
  private tick(dt: number, t: number) {
    this.hourAbs += dt * this.speed / SEC_PER_HOUR
    this.updateDayNight()

    // animace budov a stavenišť
    for (const g of this.buildGroups.values()) {
      const anims = g.userData.anim as Anim[] | undefined
      if (anims) {
        for (const a of anims) {
          const base = (a.node.userData.base ??= { x: a.node.position.x, y: a.node.position.y, rz: a.node.rotation.z })
          switch (a.kind) {
            case 'rotY': a.node.rotation.y = t * a.speed; break
            case 'rotZ': a.node.rotation.z = t * a.speed; break
            case 'rotX': a.node.rotation.x = t * a.speed; break
            case 'slideY': a.node.position.y = base.y + Math.sin(t * a.speed) * 0.16; break
            case 'slideX': a.node.position.x = base.x + Math.sin(t * a.speed * 0.7) * 0.3; break
            case 'rock': a.node.rotation.z = base.rz + Math.sin(t * a.speed) * 0.22; break
          }
        }
      }
      const smokes = g.userData.smokes as { m: THREE.Mesh; base: THREE.Vector3; ph: number }[] | undefined
      if (smokes) {
        for (const s of smokes) {
          const ph = (t * 0.22 + s.ph) % 1
          s.m.position.set(s.base.x + ph * 0.25, s.base.y + ph * 1.15, s.base.z)
          s.m.scale.setScalar(0.5 + ph * 1.8)
        }
      }
    }

    // vozidla
    for (const v of this.vehicles) {
      const tph = TILES_PER_HOUR[v.kind] * TILE
      const t0 = (this.hourAbs * tph) / v.lane.len + v.off
      this.pointAt(v.lane, t0, this.tmpA)
      this.pointAt(v.lane, t0 + 0.004, this.tmpB)
      v.g.position.copy(this.tmpA)
      if (v.kind === 'ship') v.g.position.y += Math.sin(t * 2 + v.off * 9) * 0.02
      const dx = this.tmpB.x - this.tmpA.x
      const dz = this.tmpB.z - this.tmpA.z
      if (dx * dx + dz * dz > 1e-8) v.g.rotation.y = -Math.atan2(dz, dx)
    }

    // pulz výběru
    if (this.selFrame.visible) {
      this.selFrame.scale.setScalar(1 + Math.sin(t * 4) * 0.03)
    }
  }

  /* ── picking ─────────────────────────────────────────────────────────── */
  private pick(cx: number, cy: number): MapPlot | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.camera)
    const hits = this.ray.intersectObjects(this.pickMeshes, false)
    for (const h of hits) {
      const ids = h.object.userData.plotIds as string[] | undefined
      if (ids && h.instanceId !== undefined) {
        const id = ids[h.instanceId]
        if (id) return this.plots.get(id) ?? null
      }
    }
    return null
  }

  private onMove = (e: PointerEvent) => {
    const p = this.pick(e.clientX, e.clientY)
    this.setHover(p?.id ?? null)
    this.cb.onHover(p, e.clientX, e.clientY)
    this.renderer.domElement.style.cursor = p ? 'pointer' : 'grab'
  }
  private onDown = (e: PointerEvent) => {
    if (e.button === 0) this.downAt = { x: e.clientX, y: e.clientY }
  }
  private onUp = (e: PointerEvent) => {
    if (e.button !== 0 || !this.downAt) return
    const dx = e.clientX - this.downAt.x
    const dy = e.clientY - this.downAt.y
    this.downAt = null
    if (dx * dx + dy * dy > 36) return
    this.cb.onSelect(this.pick(e.clientX, e.clientY))
  }

  /* ── kamera ───────────────────────────────────────────────────────────── */
  zoomBy(f: number) {
    const off = this.camera.position.clone().sub(this.controls.target)
    const len = Math.max(this.controls.minDistance, Math.min(this.controls.maxDistance, off.length() * f))
    off.setLength(len)
    this.camera.position.copy(this.controls.target).add(off)
    this.controls.update()
  }
  resetView() {
    const d = Math.max(this.grid.w, this.grid.h) * TILE * 0.42
    this.controls.target.set(0, 0, 0)
    this.camera.position.set(d * 0.85, d * 0.72, d * 0.85)
    this.controls.update()
  }

  /* ── úklid ────────────────────────────────────────────────────────────── */
  private clearGroup(g: THREE.Group, removeSelf = false) {
    for (const child of [...g.children]) {
      g.remove(child)
      child.traverse((n) => {
        const m = n as THREE.Mesh
        if (m.isMesh && m.geometry && !isCachedGeo(m.geometry)) m.geometry.dispose()
      })
    }
    if (removeSelf && g.parent) g.parent.remove(g)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointermove', this.onMove)
    el.removeEventListener('pointerdown', this.onDown)
    el.removeEventListener('pointerup', this.onUp)
    this.controls.dispose()
    this.scene.traverse((n) => {
      const m = n as THREE.Mesh
      if (m.isMesh && m.geometry && !isCachedGeo(m.geometry)) m.geometry.dispose()
    })
    this.renderer.dispose()
    if (el.parentElement === this.container) this.container.removeChild(el)
  }
}

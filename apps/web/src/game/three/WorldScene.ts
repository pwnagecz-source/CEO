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
import { ownerColor } from '../iso'
import { buildBuilding, buildConstruction, type Anim } from './buildings3d'
import { buildTerrain3d, WATER_Y, type TerrainBuild } from './terrain3d'
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
const MOON_C = new THREE.Color('#8ea6d8')
const LAMP_HEAD_M = new THREE.MeshLambertMaterial({
  color: '#e8e2cf', emissive: new THREE.Color('#ffd98a'), emissiveIntensity: 0.05,
})
NIGHT_MATS.push({ m: LAMP_HEAD_M, min: 0.05, max: 2.6 })

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
  private terrain: TerrainBuild | null = null
  private coordIndex = new Map<string, string>()
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
    this.renderer.toneMappingExposure = 1.12
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    container.appendChild(this.renderer.domElement)

    this.scene.background = this.bg
    this.scene.fog = new THREE.Fog(this.bg.getHex(), 190, 640)

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 900)
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

    this.hemi = new THREE.HemisphereLight(0xcfe4ff, 0x506046, 1.15)
    this.scene.add(this.hemi)
    this.sun = new THREE.DirectionalLight(0xffe3b3, 2.4)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const sc = this.sun.shadow.camera
    sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120
    sc.near = 1; sc.far = 460
    this.sun.shadow.bias = -0.0006
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)

    // podklad mimo herní mřížku
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), mat('#4e7a48'))
    outer.rotation.x = -Math.PI / 2
    outer.position.y = -1.4
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
    const hx = (this.grid.w / 2) * TILE - TILE
    const hz = (this.grid.h / 2) * TILE - TILE
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
    this.coordIndex.clear()
    for (const p of map.plots) {
      this.plots.set(p.id, p)
      this.coordIndex.set(`${p.x},${p.y}`, p.id)
    }
    if (this.terrain) {
      this.terrain.ground.geometry.dispose()
      this.terrain.water.geometry.dispose()
      ;(this.terrain.water.material as THREE.Material).dispose()
      ;(this.terrain.ground.material as THREE.Material).dispose()
    }
    this.terrain = null
    this.clearGroup(this.terrainGroup)
    this.clearGroup(this.roadGroup)
    for (const g of this.buildGroups.values()) this.disposeBuildingGroup(g)
    this.buildGroups.clear()
    for (const g of this.ownerGroups.values()) this.clearGroup(g, true)
    this.ownerGroups.clear()

    this.terrain = buildTerrain3d(map)
    this.terrainGroup.add(this.terrain.ground, this.terrain.water, this.terrain.deco)
    const sc = this.sun.shadow.camera
    sc.left = -this.terrain.half.x - 14; sc.right = this.terrain.half.x + 14
    sc.top = this.terrain.half.z + 14; sc.bottom = -this.terrain.half.z - 14
    sc.updateProjectionMatrix()
    this.buildRoads(map)
    for (const p of map.plots) {
      if (p.b_id) this.addBuilding(p)
      if (p.owner_id) this.addOwnerFrame(p)
    }
    const keepSel = this.selId, keepHov = this.hovId
    this.selId = null; this.hovId = null
    this.setSelected(keepSel); this.setHover(keepHov)
    this.controls.target.set(0, 0, 0)
    this.resetView()
  }

  /** přírůstkové změny z SSE delta */
  applyPlots(changed: MapPlot[]) {
    let roadsDirty = false
    for (const p of changed) {
      const old = this.plots.get(p.id)
      this.plots.set(p.id, p)
      this.coordIndex.set(`${p.x},${p.y}`, p.id)
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

  private buildRoads(map: MapData) {
    const roadSet = new Set<string>()
    for (const p of map.plots) {
      if (p.type === 'road' || p.b_code === 'road') roadSet.add(`${p.x},${p.y}`)
    }
    const tiles = [...roadSet].map((k) => k.split(',').map(Number) as [number, number])
    if (!tiles.length) return
    const RD = 0.7                                  // hloubka desek náspu
    const shoulderGeo = new THREE.BoxGeometry(TILE * 1.42, RD, TILE * 1.42)
    const asphaltGeo = new THREE.BoxGeometry(TILE, RD, TILE)
    const curbGeo = new THREE.BoxGeometry(TILE + 0.16, RD + 0.04, TILE + 0.16)
    const dashGeo = new THREE.BoxGeometry(0.46, 0.02, 0.09)
    shoulderGeo.userData.cached = true; asphaltGeo.userData.cached = true
    curbGeo.userData.cached = true; dashGeo.userData.cached = true
    const shoulder = new THREE.InstancedMesh(shoulderGeo, mat('#7d7460'), tiles.length)
    const asphalt = new THREE.InstancedMesh(asphaltGeo, mat('#6e747c'), tiles.length)
    const curb = new THREE.InstancedMesh(curbGeo, mat('#8b9199'), tiles.length)
    asphalt.receiveShadow = true; shoulder.receiveShadow = true; curb.receiveShadow = true
    const dashes: { x: number; z: number; rot: number }[] = []
    tiles.forEach(([x, y], i) => {
      const pos = this.tilePos(x, y)
      const r = TILE / 2
      const hc = this.terrain
        ? Math.max(
            this.terrain.heightAt(pos.x - r, pos.z - r), this.terrain.heightAt(pos.x + r, pos.z - r),
            this.terrain.heightAt(pos.x - r, pos.z + r), this.terrain.heightAt(pos.x + r, pos.z + r),
          )
        : 0
      shoulder.setMatrixAt(i, new THREE.Matrix4().makeTranslation(pos.x, hc - RD / 2 - 0.02, pos.z))
      asphalt.setMatrixAt(i, new THREE.Matrix4().makeTranslation(pos.x, hc + 0.09 - RD / 2, pos.z))
      curb.setMatrixAt(i, new THREE.Matrix4().makeTranslation(pos.x, hc + 0.05 - (RD + 0.04) / 2, pos.z))
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
    shoulder.instanceMatrix.needsUpdate = true
    shoulder.instanceMatrix.needsUpdate = true
    asphalt.instanceMatrix.needsUpdate = true
    curb.instanceMatrix.needsUpdate = true
    this.roadGroup.add(shoulder, asphalt, curb)
    const lamps: { x: number; z: number; h: number }[] = []
    tiles.forEach(([x, y]) => {
      const n = roadSet.has(`${x},${y - 1}`); const s2 = roadSet.has(`${x},${y + 1}`)
      const w2 = roadSet.has(`${x - 1},${y}`); const e = roadSet.has(`${x + 1},${y}`)
      const ns = (n || s2) && !w2 && !e
      const ew = (w2 || e) && !n && !s2
      if (!ns && !ew) return
      if (((x * 7 + y * 13) % 4 + 4) % 4 !== 0) return
      const pos = this.tilePos(x, y)
      const hh = this.roadTopY(pos.x, pos.z)
      if (ns) lamps.push({ x: pos.x + 1.18, z: pos.z, h: hh })
      else lamps.push({ x: pos.x, z: pos.z + 1.18, h: hh })
    })
    if (lamps.length) {
      const poleG = new THREE.CylinderGeometry(0.035, 0.055, 1.5, 5)
      const headG = new THREE.BoxGeometry(0.24, 0.07, 0.13)
      poleG.userData.cached = true; headG.userData.cached = true
      const poles = new THREE.InstancedMesh(poleG, mat('#3c4149'), lamps.length)
      const heads = new THREE.InstancedMesh(headG, LAMP_HEAD_M, lamps.length)
      poles.castShadow = true
      lamps.forEach((l, i) => {
        poles.setMatrixAt(i, new THREE.Matrix4().makeTranslation(l.x, l.h + 0.77, l.z))
        heads.setMatrixAt(i, new THREE.Matrix4().makeTranslation(l.x, l.h + 1.55, l.z))
      })
      poles.instanceMatrix.needsUpdate = true
      heads.instanceMatrix.needsUpdate = true
      this.roadGroup.add(poles, heads)
    }
    if (dashes.length) {
      const dm = new THREE.InstancedMesh(dashGeo, mat('#cfd3d8'), dashes.length)
      dashes.forEach((d, i) => {
        dm.setMatrixAt(i, new THREE.Matrix4().compose(
          new THREE.Vector3(d.x, this.roadTopY(d.x, d.z) + 0.015, d.z),
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
    pos.y = p.type === 'water' ? WATER_Y + 0.02 : (this.terrain?.heightAt(pos.x, pos.z) ?? 0) - 0.06
    g.position.copy(pos)
    if (p.b_code !== 'harbor') g.rotation.y = Math.floor(hash2(p.x, p.y, 5) * 4) * (Math.PI / 2)
    // kouřové puff-y z komínů
    const smokes: { m: THREE.Mesh; base: THREE.Vector3; ph: number }[] = []
    for (const src of (g.userData.smokeSrc ?? []) as { x: number; y: number; z: number }[]) {
      for (let i = 0; i < 3; i++) {
        const puff = new THREE.Mesh(PUFF_GEO, SMOKE_MAT)
        puff.castShadow = false
        puff.position.set(pos.x + src.x, pos.y + src.y, pos.z + src.z)
        this.rootGroup.add(puff)
        smokes.push({ m: puff, base: new THREE.Vector3(pos.x + src.x, pos.y + src.y, pos.z + src.z), ph: i / 3 })
      }
    }
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
    g.position.set(pos.x, (this.terrain?.heightAt(pos.x, pos.z) ?? 0) + 0.02, pos.z)
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

  /** horní hrana silničního náspu v bodě (max roh dlaždice + 0.09) */
  private roadTopY(x: number, z: number) {
    if (!this.terrain) return 0.09
    const gx = Math.round(x / TILE + (this.grid.w - 1) / 2)
    const gy = Math.round(z / TILE + (this.grid.h - 1) / 2)
    const c = this.tilePos(gx, gy)
    const r = TILE / 2
    return Math.max(
      this.terrain.heightAt(c.x - r, c.z - r), this.terrain.heightAt(c.x + r, c.z - r),
      this.terrain.heightAt(c.x - r, c.z + r), this.terrain.heightAt(c.x + r, c.z + r),
    ) + 0.09
  }

  /** y rámečku: nejvyšší roh pozemku + malý odstup → leží na terénu */
  private frameY(x: number, y: number) {
    const pos = this.tilePos(x, y)
    if (!this.terrain) return 0.1
    const r = TILE / 2
    return Math.max(
      this.terrain.heightAt(pos.x - r, pos.z - r), this.terrain.heightAt(pos.x + r, pos.z - r),
      this.terrain.heightAt(pos.x - r, pos.z + r), this.terrain.heightAt(pos.x + r, pos.z + r),
    ) + 0.07
  }

  setSelected(id: string | null) {
    this.selId = id
    if (!id) { this.selFrame.visible = false; return }
    const p = this.plots.get(id)
    if (!p) { this.selFrame.visible = false; return }
    const pos = this.tilePos(p.x, p.y)
    this.selFrame.position.set(pos.x, this.frameY(p.x, p.y), pos.z)
    this.selFrame.visible = true
  }

  private setHover(id: string | null) {
    if (id === this.hovId) return
    this.hovId = id
    if (!id) { this.hovFrame.visible = false; return }
    const p = this.plots.get(id)
    if (!p) { this.hovFrame.visible = false; return }
    const pos = this.tilePos(p.x, p.y)
    this.hovFrame.position.set(pos.x, this.frameY(p.x, p.y), pos.z)
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
        v.y = 0
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
    // v noci přejde slunce v měsíc: studené světlo shora, ne tma od země
    this.sun.position.set(
      THREE.MathUtils.lerp(Math.cos(theta) * 80, -52, night),
      THREE.MathUtils.lerp(Math.max(elev, -0.35) * 70 + 10, 54, night),
      THREE.MathUtils.lerp(34, -26, night),
    )
    this.sun.intensity = Math.max(0.04, elev * 2.6) * (1 - night) + 0.42 * night
    const dusk = Math.max(0, 1 - Math.abs(elev) * 4) * (elev > -0.3 ? 1 : 0)
    this.sun.color.copy(SUN_NOON).lerp(SUN_SET, dusk * 0.8)
    if (night > 0) this.sun.color.lerp(MOON_C, night)
    this.hemi.intensity = 1.25 - 0.9 * night
    const wu = (this.terrain?.water.material as THREE.ShaderMaterial)?.uniforms
    if (wu?.uDim) wu.uDim.value = 1 - 0.6 * night
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
    this.terrain?.update(t)

    // animace budov a stavenišť
    for (const g of this.buildGroups.values()) {
      const anims = g.userData.anims as Anim[] | undefined
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
      v.g.position.y = v.kind === 'ship'
        ? WATER_Y + 0.1 + Math.sin(t * 2 + v.off * 9) * 0.02
        : this.roadTopY(this.tmpA.x, this.tmpA.z) + 0.02
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
    if (!this.terrain) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.camera)
    const hits = this.ray.intersectObjects([this.terrain.ground, this.terrain.water], false)
    for (const h of hits) {
      const gx = Math.round(h.point.x / TILE + (this.grid.w - 1) / 2)
      const gy = Math.round(h.point.z / TILE + (this.grid.h - 1) / 2)
      if (gx < 0 || gy < 0 || gx >= this.grid.w || gy >= this.grid.h) return null
      const id = this.coordIndex.get(`${gx},${gy}`)
      if (id) return this.plots.get(id) ?? null
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
        if (m.isMesh && m.geometry && !isCachedGeo(m.geometry)) {
          if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose()
          m.geometry.dispose()
        }
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
    if (this.terrain) {
      this.terrain.ground.geometry.dispose()
      this.terrain.water.geometry.dispose()
    }
    this.scene.traverse((n) => {
      const m = n as THREE.Mesh
      if (m.isMesh && m.geometry && !isCachedGeo(m.geometry)) m.geometry.dispose()
    })
    this.renderer.dispose()
    if (el.parentElement === this.container) this.container.removeChild(el)
  }
}

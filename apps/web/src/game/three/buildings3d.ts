/**
 * 3D budovy — procedurální low-poly modely všech 28 typů.
 *
 * Každá budova je THREE.Group s:
 *  - `userData.floors`  — pole pater (Group), aby šla později stavět/přidávat
 *    jednotlivá patra přímo v budově (příprava na další vlnu),
 *  - `userData.anim`    — [{ kind, node, speed }] animace (pumpjack, pec,
 *    jeřáb, kotouč…), které každý snímek aplikuje WorldScene,
 *  - komíny s `userData.smoke` — WorldScene nad nimi pouští kouřové puff-y.
 *
 * Siluety záměrně odpovídají funkci budovy: těžní věž dolu, pumpjack,
 * solární pole, rotační pec, flare rafinerie, pilová střecha tkalcovny,
 * neon lahůdek, gantry přístavu…
 */
import * as THREE from 'three'
import { skinFor, type BuildingSkin } from '../art'
import {
  FORGE, FLARE, LAMP, NEON, NEON_COOL, WIN_DARK,
  box, chimney, cone, cyl, mat, matShade, ridgeRoof, sawRoof, windowGrid,
} from './materials'

export type BuildOpts = {
  level: number
  producing: boolean
  /** 0..1 — noc (rozsvícená okna se řeší sdílenými materiály, tady jen doplňky) */
  night: number
  seed: number
  industry: string | null
  retail: boolean | null
}

export type Anim = { kind: 'rotY' | 'rotZ' | 'rotX' | 'slideY' | 'slideX' | 'rock'; node: THREE.Object3D; speed: number }

const R = (seed: number) => {
  let s = Math.floor(seed * 233280) + 7
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
}

/* ── společný obal: patra + okna ─────────────────────────────────────────── */
function shell(g: THREE.Group, skin: BuildingSkin, w: number, d: number, floors: number, seed: number) {
  const FH = 0.62
  const list: THREE.Group[] = []
  for (let f = 0; f < floors; f++) {
    const fl = new THREE.Group()
    fl.name = `floor-${f + 1}`
    const wall = f === 0 ? skin.wall : matShade(skin.wall, f % 2 ? 1.06 : 0.94)
    const body = box(w, FH, d, wall, 0, FH / 2 + f * FH, 0)
    fl.add(body)
    // okna na všech čtyřech stranách (výška patra)
    windowGrid(fl, w * 0.92, FH * 0.8, f * FH + FH * 0.08, 'z+', d, seed + f)
    windowGrid(fl, w * 0.92, FH * 0.8, f * FH + FH * 0.08, 'z-', d, seed + f + 0.31)
    if (w > 0.9) {
      windowGrid(fl, d * 0.92, FH * 0.8, f * FH + FH * 0.08, 'x+', w, seed + f + 0.57)
    }
    g.add(fl)
    list.push(fl)
  }
  const band = box(w + 0.06, 0.07, d + 0.06, matShade(skin.wall, 0.75), 0, floors * FH, 0)
  g.add(band)
  g.userData.floors = list
  return floors * FH + 0.07
}

function anim(g: THREE.Group, a: Anim) {
  (g.userData.anim ??= [] as Anim[]).push(a)
}

/* ── jednotlivé typy ────────────────────────────────────────────────────── */
function headframe(g: THREE.Group, skin: BuildingSkin) {
  // těžní věž: čtyři šikmé nohy + kolo na vrcholu + těžní domek
  const leg = matShade(skin.wallDark, 0.9)
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const l = box(0.09, 1.5, 0.09, leg, sx * 0.28, 0.72, sz * 0.28)
    l.rotation.set(sz * 0.16, 0, -sx * 0.16)
    g.add(l)
  }
  g.add(box(0.62, 0.1, 0.62, leg, 0, 1.44, 0))
  const wheel = cyl(0.24, 0.24, 0.07, '#39424f', 0, 1.62, 0, 10)
  wheel.rotation.x = Math.PI / 2
  g.add(wheel)
  anim(g, { kind: 'rotX', node: wheel, speed: 1.4 })
  g.add(box(0.5, 0.42, 0.42, skin.wallDark, 0.52, 0.21, 0.28))
}

function pumpjack(g: THREE.Group, skin: BuildingSkin) {
  g.add(box(0.9, 0.16, 0.6, '#4a5261', 0, 0.08, 0))
  // kozlík
  for (const s of [-1, 1]) {
    const l = box(0.07, 0.8, 0.07, '#5d6675', s * 0.16, 0.4, 0)
    l.rotation.z = -s * 0.3
    g.add(l)
  }
  const beam = new THREE.Group()
  beam.position.set(0, 0.78, 0)
  beam.add(box(1.15, 0.09, 0.12, '#c8763a', 0.1, 0, 0))
  beam.add(box(0.16, 0.34, 0.14, '#8d94a1', -0.52, -0.06, 0))   // protizávaží
  beam.add(box(0.1, 0.3, 0.16, '#c8763a', 0.66, -0.06, 0))     // hlava (oblouk)
  g.add(beam)
  anim(g, { kind: 'rock', node: beam, speed: 1.1 })
  const rod = box(0.04, 0.5, 0.04, '#9aa3b0', 0.66, 0.42, 0)
  g.add(rod)
  anim(g, { kind: 'slideY', node: rod, speed: 1.1 })
  g.add(cyl(0.3, 0.34, 0.5, skin.wallDark, -0.5, 0.25, 0.34, 8)) // pohon
}

function solarField(g: THREE.Group) {
  const panel = mat('#1d3a6e')
  const frame = mat('#8fa2b8')
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const p = new THREE.Group()
      const panelM = box(0.5, 0.03, 0.34, panel, 0, 0, 0)
      panelM.receiveShadow = true
      p.add(panelM)
      p.add(box(0.52, 0.02, 0.03, frame, 0, 0.015, 0.17))
      p.add(cyl(0.03, 0.03, 0.22, frame, 0, -0.12, 0, 5))
      p.position.set(-0.6 + c * 0.6, 0.3, -0.55 + r * 0.55)
      p.rotation.x = -0.5
      g.add(p)
    }
  }
  g.add(box(0.34, 0.3, 0.26, '#7d8794', 0.72, 0.15, 0.66)) // střídač
}

function tanks(g: THREE.Group, skin: BuildingSkin, n: number, withFlare: boolean) {
  for (let i = 0; i < n; i++) {
    const x = -0.55 + i * 0.55
    const h = 0.55 + (i % 2) * 0.2
    g.add(cyl(0.26, 0.26, h, i % 2 ? '#b9c2cc' : skin.wall, x, h / 2, -0.35, 10))
    g.add(cyl(0.27, 0.27, 0.05, matShade('#b9c2cc', 0.8), x, h, -0.35, 10))
  }
  // potrubní most
  g.add(box(1.5, 0.05, 0.05, '#8b939e', 0, 0.34, 0.1))
  g.add(box(1.5, 0.05, 0.05, '#8b939e', 0, 0.44, 0.1))
  if (withFlare) {
    g.add(cyl(0.05, 0.07, 1.5, '#77808c', 0.7, 0.75, -0.5, 6))
    const flame = cone(0.11, 0.3, '#ffd45e', 0.7, 1.6, -0.5, 6)
    flame.material = FLARE
    g.add(flame)
    anim(g, { kind: 'slideY', node: flame, speed: 6 })
  }
}

function fieldRows(g: THREE.Group, color: string, rows = 4) {
  for (let i = 0; i < rows; i++) {
    const r = box(1.7, 0.08, 0.16, color, 0, 0.04, -0.7 + i * 0.36)
    r.castShadow = false
    g.add(r)
  }
}

function piles(g: THREE.Group, color: string, n: number, seed: number) {
  const rnd = R(seed)
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * 1.2
    const z = 0.45 + rnd() * 0.35
    g.add(cone(0.16 + rnd() * 0.1, 0.2 + rnd() * 0.12, color, x, 0.1, z, 6))
  }
}

function logPile(g: THREE.Group, x: number, z: number, n = 5) {
  for (let i = 0; i < n; i++) {
    const l = cyl(0.07, 0.07, 0.7, i % 2 ? '#8a6a44' : '#75593a', x + (i % 2) * 0.08, 0.08 + Math.floor(i / 2) * 0.13, z + (i % 3) * 0.09, 6)
    l.rotation.z = Math.PI / 2
    g.add(l)
  }
}

function gantryCrane(g: THREE.Group, h: number, color = '#e0a33c') {
  // portálový jeřáb: nohy + horní nosník + vozík + zavěšený spreader
  for (const s of [-1, 1]) {
    g.add(box(0.09, h, 0.09, color, s * 0.62, h / 2, -0.3))
    g.add(box(0.09, h, 0.09, color, s * 0.62, h / 2, 0.3))
    g.add(box(0.09, 0.09, 0.7, color, s * 0.62, h, 0))
  }
  g.add(box(1.5, 0.12, 0.14, color, 0, h + 0.06, 0))
  const trolley = box(0.18, 0.1, 0.16, '#4a5261', 0.1, h - 0.06, 0)
  g.add(trolley)
  anim(g, { kind: 'slideX', node: trolley, speed: 0.5 })
  const cable = box(0.015, 0.5, 0.015, '#2b3038', 0.1, h - 0.34, 0)
  g.add(cable)
  const spreader = box(0.3, 0.12, 0.18, '#c0453c', 0.1, h - 0.62, 0)
  g.add(spreader)
  anim(g, { kind: 'slideY', node: spreader, speed: 0.5 })
  anim(g, { kind: 'slideY', node: cable, speed: 0.5 })
}

function awning(g: THREE.Group, w: number, z: number, y: number, c1 = '#d9584a', c2 = '#f2efe6') {
  const n = 5
  for (let i = 0; i < n; i++) {
    const s = box(w / n, 0.03, 0.34, i % 2 ? c2 : c1, -w / 2 + (i + 0.5) * (w / n), y, z)
    s.rotation.x = 0.28
    g.add(s)
  }
}

/* ── hlavní switch ───────────────────────────────────────────────────────── */
export function buildBuilding(code: string | null, o: BuildOpts): THREE.Group {
  const g = new THREE.Group()
  const skin = skinFor(o.industry, o.retail)
  const floors = Math.max(1, Math.min(4, o.level))
  const P = o.producing

  switch (code) {
    case 'iron_mine': {
      shell(g, skin, 0.8, 0.7, 1, o.seed)
      headframe(g, skin)
      piles(g, '#6e6156', 2, o.seed)
      break
    }
    case 'logging_camp': {
      shell(g, skin, 0.85, 0.7, 1, o.seed)
      g.add(ridgeRoof(0.95, 0.8, 0.3, skin.roof, 0, 0.69, 0))
      logPile(g, -0.55, 0.55, 6)
      logPile(g, 0.5, 0.6, 4)
      g.add(box(0.06, 0.7, 0.06, '#8d94a1', 0.62, 0.35, -0.4))
      const jib = box(0.7, 0.05, 0.05, '#c8763a', 0.35, 0.68, -0.4)
      g.add(jib)
      if (P) anim(g, { kind: 'rotY', node: jib, speed: 0.4 })
      break
    }
    case 'quarry': {
      // terasovaná jáma + drtič
      g.add(box(1.5, 0.1, 1.2, matShade(skin.wall, 0.7), 0, -0.02, 0.1))
      g.add(box(1.1, 0.12, 0.85, matShade(skin.wall, 0.58), 0, 0.05, 0.15))
      g.add(box(0.7, 0.14, 0.5, matShade(skin.wall, 0.46), 0, 0.13, 0.2))
      const crusher = box(0.4, 0.5, 0.36, skin.wall, -0.62, 0.25, -0.55)
      g.add(crusher)
      g.add(cone(0.24, 0.34, '#7c8590', -0.62, 0.66, -0.55, 7))
      piles(g, '#8d8578', 3, o.seed)
      if (P) anim(g, { kind: 'slideY', node: crusher, speed: 5 })
      break
    }
    case 'oil_rig': pumpjack(g, skin); break
    case 'solar_plant': solarField(g); break
    case 'grain_farm': {
      shell(g, skin, 0.75, 0.6, 1, o.seed)
      g.add(ridgeRoof(0.85, 0.7, 0.28, skin.roof, 0, 0.69, 0))
      for (const [x, z] of [[-0.6, -0.5], [-0.32, -0.62]] as const) {
        g.add(cyl(0.16, 0.16, 0.8, '#c9b280', x, 0.4, z, 9))
        g.add(cone(0.18, 0.22, '#8e7a42', x, 0.9, z, 9))
      }
      fieldRows(g, '#c9a84c', 3)
      break
    }
    case 'cotton_farm': {
      shell(g, skin, 0.7, 0.6, 1, o.seed)
      g.add(ridgeRoof(0.8, 0.7, 0.26, '#a3564a', 0, 0.69, 0))
      fieldRows(g, '#e8e4da', 4)
      g.add(cyl(0.2, 0.24, 0.5, '#9aa3b0', 0.66, 0.25, -0.6, 8)) // vodárenská věž
      g.add(cone(0.22, 0.18, '#77808c', 0.66, 0.58, -0.6, 8))
      break
    }
    case 'sawmill': {
      shell(g, skin, 1.1, 0.8, 1, o.seed)
      g.add(ridgeRoof(1.2, 0.9, 0.34, skin.roof, 0, 0.69, 0))
      const blade = box(0.34, 0.26, 0.05, '#b9c2cc', 0.2, 0.5, 0.46)
      g.add(blade)
      if (P) anim(g, { kind: 'slideY', node: blade, speed: 7 })
      logPile(g, -0.62, 0.5, 6)
      piles(g, '#d9c078', 2, o.seed + 0.5)
      break
    }
    case 'cement_kiln': {
      shell(g, skin, 0.7, 0.6, 1, o.seed)
      const kiln = cyl(0.18, 0.18, 1.5, '#a8a294', 0, 0.5, 0.1, 10)
      kiln.rotation.z = Math.PI / 2 - 0.12
      g.add(kiln)
      if (P) anim(g, { kind: 'rotX', node: kiln, speed: 0.8 })
      g.add(box(0.4, 1.1, 0.4, skin.wallDark, -0.62, 0.55, -0.5)) // preheater
      chimney(g, 0.62, -0.55, 1.2, '#8d8578', P)
      piles(g, '#9aa3a0', 2, o.seed)
      break
    }
    case 'flour_mill': {
      const t = shell(g, skin, 0.8, 0.7, 2, o.seed)
      g.add(ridgeRoof(0.9, 0.8, 0.3, skin.roof, 0, t, 0))
      g.add(cyl(0.18, 0.18, 0.9, '#d8d2c2', 0.62, 0.45, -0.5, 9))
      g.add(cone(0.2, 0.2, '#b0a88f', 0.62, 1.0, -0.5, 9))
      const conv = box(0.9, 0.06, 0.16, '#8b939e', 0.2, 0.6, -0.2)
      conv.rotation.z = 0.5
      g.add(conv)
      fieldRows(g, '#d9c078', 2)
      break
    }
    case 'glass_works': {
      shell(g, skin, 1.0, 0.8, 1, o.seed)
      g.add(sawRoof(1.0, 0.8, 0.3, skin.roof, 3, 0, 0.69, 0))
      g.add(box(0.3, 0.24, 0.06, FORGE, 0, 0.24, 0.43))
      piles(g, '#e6ddc4', 2, o.seed)
      break
    }
    case 'refinery': {
      tanks(g, skin, 3, true)
      g.add(box(0.5, 0.5, 0.4, skin.wall, -0.6, 0.25, 0.55)) // velín
      windowGrid(g, 0.46, 0.4, 0.05, 'z+', 0.4, o.seed)
      break
    }
    case 'smelter': {
      const t = shell(g, skin, 1.0, 0.85, 1, o.seed)
      g.add(ridgeRoof(1.1, 0.95, 0.36, skin.roof, 0, t, 0))
      chimney(g, -0.3, -0.2, 1.3, '#7c746a', P)
      chimney(g, 0.28, -0.28, 1.05, '#7c746a', P)
      g.add(box(0.34, 0.3, 0.08, FORGE, 0, 0.26, 0.46))
      piles(g, '#5d564d', 2, o.seed)
      break
    }
    case 'steel_mill': {
      const t = shell(g, skin, 1.3, 0.9, 1, o.seed)
      g.add(ridgeRoof(1.4, 1.0, 0.4, skin.roof, 0, t, 0))
      // pojezdový jeřáb po střeše
      const rail = box(1.2, 0.06, 0.5, '#5d6675', 0, t + 0.42, 0)
      g.add(rail)
      if (P) anim(g, { kind: 'slideX', node: rail, speed: 0.35 })
      chimney(g, -0.5, -0.3, 1.4, '#6e675e', P)
      g.add(box(0.5, 0.34, 0.08, FORGE, 0.2, 0.3, 0.49))
      break
    }
    case 'textile_mill': {
      shell(g, skin, 1.2, 0.9, 1, o.seed)
      g.add(sawRoof(1.2, 0.9, 0.32, skin.roof, 4, 0, 0.69, 0))
      g.add(cyl(0.22, 0.26, 0.42, '#7fa3b8', 0.66, 0.9, -0.55, 10)) // vodárna
      g.add(box(0.06, 0.5, 0.06, '#5d6675', 0.66, 0.45, -0.55))
      break
    }
    case 'electronics_lab': {
      const t = shell(g, { wall: '#dfe6ee', wallDark: '#b9c2cc', roof: '#f2f6fa' }, 1.0, 0.8, Math.max(2, floors), o.seed)
      g.add(box(1.04, 0.06, 0.84, '#f2f6fa', 0, t, 0))
      const dish = cyl(0.22, 0.22, 0.05, '#eef2f7', 0.3, t + 0.24, -0.2, 10)
      dish.rotation.x = -0.7
      g.add(dish)
      g.add(cyl(0.03, 0.03, 0.3, '#b9c2cc', 0.3, t + 0.1, -0.2, 5))
      if (P) anim(g, { kind: 'rotY', node: dish, speed: 0.5 })
      g.add(box(0.9, 0.05, 0.03, NEON_COOL, 0, 0.5, 0.42))
      break
    }
    case 'nail_press': {
      shell(g, skin, 0.8, 0.65, 1, o.seed)
      g.add(ridgeRoof(0.9, 0.75, 0.26, skin.roof, 0, 0.69, 0))
      const coil = cyl(0.24, 0.24, 0.16, '#9aa3b0', -0.6, 0.24, 0.5, 10)
      coil.rotation.x = Math.PI / 2
      g.add(coil)
      if (P) anim(g, { kind: 'rotZ', node: coil, speed: 2 })
      g.add(box(0.3, 0.2, 0.3, '#7d6a4d', 0.55, 0.1, 0.55))
      break
    }
    case 'wire_draw': {
      shell(g, skin, 0.95, 0.7, 1, o.seed)
      g.add(ridgeRoof(1.05, 0.8, 0.28, skin.roof, 0, 0.69, 0))
      for (let i = 0; i < 3; i++) {
        const sp = cyl(0.16, 0.16, 0.1, '#c8b06c', -0.4 + i * 0.4, 0.86, 0.28, 10)
        g.add(sp)
        if (P) anim(g, { kind: 'rotY', node: sp, speed: 3 })
      }
      break
    }
    case 'appliance_plant': {
      const t = shell(g, skin, 1.2, 0.85, 1, o.seed)
      g.add(box(1.26, 0.08, 0.9, skin.roof, 0, t, 0))
      gantryCrane(g, t + 0.5, '#8fa2b8')
      g.add(box(0.34, 0.26, 0.3, '#dfe6ee', 0.62, 0.13, 0.6))
      g.add(box(0.3, 0.24, 0.28, '#c9d2dc', 0.6, 0.36, 0.58))
      break
    }
    case 'bakery': {
      shell(g, skin, 0.8, 0.7, 1, o.seed)
      g.add(ridgeRoof(0.9, 0.8, 0.3, '#a3564a', 0, 0.69, 0))
      awning(g, 0.72, 0.42, 0.5)
      chimney(g, -0.28, -0.18, 0.95, '#8d8578', P)
      g.add(box(0.5, 0.3, 0.05, WIN_DARK, 0, 0.32, 0.37))
      g.add(box(0.16, 0.16, 0.05, FLARE, 0.3, 0.62, 0.37)) // vývěska
      break
    }
    case 'deli': {
      shell(g, skin, 0.8, 0.7, 1, o.seed)
      g.add(box(0.86, 0.1, 0.76, skin.roof, 0, 0.72, 0))
      awning(g, 0.72, 0.42, 0.5, '#3f8f6a', '#f2efe6')
      g.add(box(0.5, 0.14, 0.06, NEON, 0, 0.86, 0.38))
      g.add(box(0.56, 0.32, 0.05, WIN_DARK, 0, 0.3, 0.37))
      break
    }
    case 'furniture_factory': {
      shell(g, skin, 1.0, 0.8, 1, o.seed)
      g.add(ridgeRoof(1.1, 0.9, 0.3, skin.roof, 0, 0.69, 0))
      g.add(cyl(0.14, 0.16, 0.6, '#b0a88f', 0.62, 0.3, -0.5, 8)) // odsávací silo
      g.add(cone(0.16, 0.2, '#8e7a42', 0.62, 0.7, -0.5, 8))
      logPile(g, -0.6, 0.55, 4)
      break
    }
    case 'garment_factory': {
      shell(g, skin, 1.0, 0.8, 1, o.seed)
      g.add(sawRoof(1.0, 0.8, 0.28, skin.roof, 3, 0, 0.69, 0))
      for (let i = 0; i < 3; i++) {
        const roll = cyl(0.09, 0.09, 0.5, ['#b0566a', '#5a8f9c', '#c9a84c'][i] ?? '#b0566a', -0.35 + i * 0.35, 0.09, 0.62, 8)
        roll.rotation.z = Math.PI / 2
        g.add(roll)
      }
      break
    }
    case 'machine_shop': {
      const t = shell(g, skin, 1.05, 0.8, 1, o.seed)
      g.add(ridgeRoof(1.15, 0.9, 0.32, skin.roof, 0, t, 0))
      g.add(box(0.44, 0.36, 0.06, matShade(skin.wallDark, 0.8), 0, 0.2, 0.43)) // vrata
      const jib = box(0.5, 0.05, 0.05, '#c8763a', 0.5, t + 0.16, 0.3)
      g.add(jib)
      g.add(box(0.05, 0.24, 0.05, '#5d6675', 0.72, t + 0.05, 0.3))
      if (P) anim(g, { kind: 'rotY', node: jib, speed: 0.6 })
      g.add(box(0.28, 0.22, 0.26, '#7d6a4d', -0.62, 0.11, 0.56))
      break
    }
    case 'tool_works': {
      shell(g, skin, 0.85, 0.7, 1, o.seed)
      g.add(ridgeRoof(0.95, 0.8, 0.28, skin.roof, 0, 0.69, 0))
      const wheel = cyl(0.2, 0.2, 0.06, '#9aa3b0', 0.6, 0.34, 0.45, 12)
      wheel.rotation.x = Math.PI / 2
      g.add(wheel)
      if (P) anim(g, { kind: 'rotX', node: wheel, speed: 6 })
      g.add(box(0.26, 0.2, 0.24, '#7d6a4d', -0.55, 0.1, 0.55))
      break
    }
    case 'warehouse': {
      const w = 1.5, d = 1.0
      g.add(box(w, 0.75, d, skin.wall, 0, 0.375, 0))
      g.add(ridgeRoof(w + 0.08, d + 0.08, 0.34, skin.roof, 0, 0.75, 0))
      for (let i = 0; i < 3; i++) {
        g.add(box(0.3, 0.34, 0.06, matShade(skin.wallDark, 0.85), -0.45 + i * 0.45, 0.17, d / 2 + 0.02))
      }
      g.add(box(0.4, 0.26, 0.3, '#c0453c', 0.55, 0.13, 0.78))
      g.add(box(0.36, 0.24, 0.28, '#4f83d8', 0.1, 0.12, 0.82))
      break
    }
    case 'harbor': {
      g.add(box(1.6, 0.12, 1.2, '#6e7684', 0, 0.06, 0)) // nábřeží
      gantryCrane(g, 1.35, '#e0a33c')
      for (const [x, z, c] of [[-0.62, 0.55, '#c0453c'], [-0.3, 0.6, '#4f83d8'], [-0.46, 0.42, '#3ddc97']] as const) {
        g.add(box(0.3, 0.16, 0.2, c, x, 0.2, z))
      }
      for (let i = 0; i < 3; i++) {
        g.add(cyl(0.05, 0.06, 0.12, '#2b3038', -0.6 + i * 0.6, 0.16, 0.86, 6))
      }
      break
    }
    default: {
      const t = shell(g, skin, 0.9, 0.75, floors, o.seed)
      g.add(ridgeRoof(1.0, 0.85, 0.3, skin.roof, 0, t, 0))
      break
    }
  }

  // noční doplňky: nájezdová světla před budovou
  if (o.retail || code === 'warehouse' || code === 'harbor') {
    g.add(cyl(0.025, 0.03, 0.5, '#5d6675', 0.55, 0.25, 0.72, 5))
    g.add(box(0.07, 0.05, 0.07, LAMP, 0.55, 0.52, 0.72))
  }
  g.userData.code = code
  g.userData.night = o.night
  return g
}

/* ── staveniště ─────────────────────────────────────────────────────────── */
export function buildConstruction(seed: number): THREE.Group {
  const g = new THREE.Group()
  // základová deska
  g.add(box(1.3, 0.1, 1.1, '#7d7468', 0, 0.05, 0))
  g.add(box(0.9, 0.22, 0.8, '#8d8578', 0, 0.16, 0))
  // oplocení
  const fence = mat('#c9a84c', { transparent: 0.85 })
  for (const [w, d, x, z] of [[1.7, 0.03, 0, -0.8], [1.7, 0.03, 0, 0.8], [0.03, 1.6, -0.85, 0], [0.03, 1.6, 0.85, 0]] as const) {
    g.add(box(w, 0.22, d, fence, x, 0.11, z))
  }
  // věžový jeřáb
  g.add(box(0.12, 1.7, 0.12, '#e0a33c', -0.55, 0.85, -0.55))
  for (let i = 0; i < 5; i++) g.add(box(0.16, 0.03, 0.16, '#c58e2f', -0.55, 0.3 + i * 0.32, -0.55))
  const jib = new THREE.Group()
  jib.position.set(-0.55, 1.74, -0.55)
  jib.add(box(1.15, 0.07, 0.07, '#e0a33c', 0.5, 0, 0))
  jib.add(box(0.34, 0.07, 0.07, '#e0a33c', -0.22, 0, 0))
  jib.add(box(0.16, 0.14, 0.14, '#5d6675', -0.34, -0.04, 0))
  jib.add(box(0.08, 0.1, 0.08, '#5d6675', 0, 0.09, 0))
  jib.add(box(0.02, 0.5, 0.02, '#2b3038', 0.75, -0.28, 0))
  jib.add(box(0.22, 0.14, 0.16, '#b9c2cc', 0.75, -0.58, 0))
  g.add(jib)
  anim(g, { kind: 'rotY', node: jib, speed: 0.25 })
  // hromady materiálu
  piles(g, '#9aa3a0', 2, seed)
  g.add(box(0.3, 0.18, 0.24, '#c0453c', 0.62, 0.09, 0.6))
  return g
}

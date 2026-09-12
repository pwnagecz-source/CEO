/**
 * 3D vozidla cargo linek — tahač s návěsem a kontejnerová loď.
 * Modely sdílí cache geometrií (materials.ts), barvu nákladu řeší jeden
 * materiál na kontejner podle linky.
 */
import * as THREE from 'three'
import { LAMP, box, cyl, mat } from './materials'

export function makeTruck(cargo: string): THREE.Group {
  const g = new THREE.Group()
  // tahač: kabina + kapota
  g.add(box(0.34, 0.24, 0.3, '#3f4a5a', 0.42, 0.2, 0))
  g.add(box(0.14, 0.16, 0.28, '#55637a', 0.62, 0.14, 0))
  g.add(box(0.05, 0.1, 0.24, '#9fd4ff', 0.58, 0.24, 0))
  g.add(box(0.03, 0.04, 0.05, LAMP, 0.69, 0.12, 0.09))
  g.add(box(0.03, 0.04, 0.05, LAMP, 0.69, 0.12, -0.09))
  // rám podvozku + blatníky + výfuk
  g.add(box(1.15, 0.05, 0.12, '#22262d', 0.05, 0.12, 0))
  for (const z of [0.17, -0.17]) {
    g.add(box(0.2, 0.05, 0.04, '#22262d', 0.42, 0.2, z))
    g.add(box(0.22, 0.05, 0.04, '#22262d', -0.5, 0.2, z))
  }
  g.add(cyl(0.02, 0.02, 0.3, '#8d94a1', 0.28, 0.3, 0.16, 5))
  // návěs: podvozek + kontejner v barvě linky
  g.add(box(0.72, 0.06, 0.26, '#2b3038', -0.28, 0.14, 0))
  g.add(box(0.66, 0.26, 0.26, mat(cargo), -0.3, 0.3, 0))
  g.add(box(0.68, 0.02, 0.28, mat(cargo), -0.3, 0.44, 0))
  g.add(box(0.66, 0.03, 0.02, mat(cargo, { flat: true }), -0.3, 0.3, 0.135))
  g.add(box(0.04, 0.2, 0.2, '#39424f', -0.64, 0.28, 0))   // zadní dveře návěsu
  // kola
  const wheel = mat('#14181f')
  for (const [x, z] of [[0.42, 0.16], [0.42, -0.16], [-0.1, 0.16], [-0.1, -0.16], [-0.5, 0.16], [-0.5, -0.16]] as const) {
    const w = cyl(0.09, 0.09, 0.05, wheel, x, 0.09, z, 8)
    w.rotation.x = Math.PI / 2
    w.castShadow = false
    g.add(w)
  }
  g.userData.len = 1.1
  return g
}

export function makeShip(cargo: string): THREE.Group {
  const g = new THREE.Group()
  // trup: příď jako klín
  g.add(box(1.5, 0.22, 0.46, '#35435a', 0, 0.11, 0))
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.23, 0.4, 4), mat('#35435a'))
  bow.rotation.y = Math.PI / 2
  bow.rotation.z = -Math.PI / 2
  bow.position.set(0.95, 0.11, 0)
  bow.scale.set(1, 0.5, 2)
  g.add(bow)
  g.add(box(1.5, 0.04, 0.48, '#b06459', 0, 0.05, 0))   // ponorka
  g.add(box(1.4, 0.03, 0.4, '#5a6a85', 0, 0.235, 0))   // paluba
  for (const z of [0.22, -0.22]) g.add(box(1.42, 0.07, 0.03, '#485872', 0, 0.28, z))  // falc
  g.add(box(0.03, 0.07, 0.44, '#485872', 0.71, 0.28, 0))
  // kontejnery ve dvou řadách
  const cols = [cargo, '#e8c07a', '#5a8f9c', cargo]
  for (let i = 0; i < 4; i++) {
    g.add(box(0.3, 0.14, 0.18, mat(cols[i] ?? cargo), -0.45 + i * 0.32, 0.32, 0.11))
    if (i < 3) g.add(box(0.3, 0.14, 0.18, mat(cols[i + 1] ?? cargo), -0.29 + i * 0.32, 0.32, -0.11))
  }
  // nástavba na zádi
  g.add(box(0.26, 0.3, 0.34, '#b9c8dd', -0.62, 0.4, 0))
  g.add(box(0.28, 0.04, 0.36, '#d7e2f0', -0.62, 0.57, 0))
  g.add(cyl(0.04, 0.05, 0.16, '#c0453c', -0.62, 0.66, 0, 6))
  g.add(box(0.03, 0.03, 0.04, LAMP, 0.72, 0.28, 0))
  g.userData.len = 1.9
  return g
}

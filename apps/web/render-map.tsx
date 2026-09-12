// Nástroj: vyrenderuje náhled mapy bez prohlížeče (SVG → PNG přes sharp).
// Herní mapa samotná se kreslí do Canvas 2D (výkon); tohle je nezávislá
// geometrická/exportní kontrola terénů a budov přímo z dat /api/map.
import { writeFileSync } from 'node:fs'
import { TILE_H, TILE_W, gridBounds, tileCenter } from './src/game/iso'
import { terrainFor } from './src/game/art'
import type { MapData } from './src/api'

const res = await fetch('http://localhost:8080/api/map')
const map = (await res.json()) as MapData
const b = gridBounds(map.grid.w, map.grid.h)

const parts: string[] = []
for (const p of [...map.plots].sort((a, z) => (a.x + a.y) - (z.x + z.y) || a.x - z.x)) {
  const c = tileCenter(p.x, p.y)
  const owned = p.owner_id !== null
  const isRoad = p.type === 'road' || p.b_code === 'road'
  const terr = terrainFor(isRoad ? 'road' : p.type, owned)
  const pts = `${c.x},${c.y - TILE_H / 2} ${c.x + TILE_W / 2},${c.y} ${c.x},${c.y + TILE_H / 2} ${c.x - TILE_W / 2},${c.y}`
  parts.push(`<polygon points="${pts}" fill="${terr.fill}" stroke="${terr.edge}" stroke-width="0.5"/>`)
  if (p.b_id && p.b_code !== 'road') {
    parts.push(`<rect x="${c.x - 7}" y="${c.y - 20}" width="14" height="18" rx="2" fill="#c9cdd4" opacity="0.9"/>`)
  }
}
const w = 2000
const h = Math.round((w * b.height) / b.width)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" width="${w}" height="${h}">${parts.join('')}</svg>`
writeFileSync('/tmp/map.svg', svg)

// numerická kontrola geometrie
let nan = 0
let polys = 0
for (const m of svg.matchAll(/points="([^"]+)"/g)) {
  polys++
  for (const pair of m[1].split(' ')) {
    const xy = pair.split(',')
    if (Number.isNaN(Number(xy[0])) || Number.isNaN(Number(xy[1]))) nan++
  }
}
console.log(`polygonů: ${polys}, NaN souřadnic: ${nan}`)
console.log(`viewBox: ${b.x} ${b.y} ${b.width} ${b.height}`)
console.log('zapsáno: /tmp/map.svg')

// Dočasný nástroj: vyrenderuje izometrickou mapu na SVG soubor, abychom mohli
// zkontrolovat geometrii/vzhled bez prohlížeče (převedeno ImageMagickem na PNG).
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync } from 'node:fs'
import WorldMap from './src/components/WorldMap'
import type { MapData } from './src/api'

const res = await fetch('http://localhost:8080/api/map')
const map = (await res.json()) as MapData

let svg = renderToStaticMarkup(
  <WorldMap map={map} myCompanyId="1" selectedPlotId={null} onSelectPlot={() => {}} />,
)

// ImageMagick potřebuje explicitní width/height; dopočteme z viewBox.
const m = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg)
if (m) {
  const [, , , w, h] = m.map(Number)
  const scale = 2000 / w
  svg = svg.replace('<svg ', `<svg width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" `)
}
writeFileSync('/tmp/map.svg', svg)

// numerická kontrola geometrie
const polys = [...svg.matchAll(/points="([^"]+)"/g)].map((x) => x[1])
let nan = 0; let xs: number[] = []; let ys: number[] = []
for (const p of polys) for (const pair of p.split(' ')) {
  const [x, y] = pair.split(',').map(Number)
  if (Number.isNaN(x) || Number.isNaN(y)) nan++
  else { xs.push(x); ys.push(y) }
}
console.log(`polygonů: ${polys.length}, NaN souřadnic: ${nan}`)
console.log(`rozsah X: ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)}, Y: ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)}`)
console.log(`viewBox: ${m ? m.slice(1).join(' ') : '?'}`)

/**
 * WorldMap — React wrapper kolem Three.js scény (`game/three/WorldScene`).
 *
 * Rozhraní vůči GameView je stejné jako u dřívějšího Canvas 2D rendereru
 * (map / routes / clock / select / hover tooltip), takže zbytek aplikace
 * o výměně rendereru neví. Scéna vzniká jednou v efektu, přírůstky z SSE
 * delta posíláme přes `applyPlots` (dif podle signatury plotů).
 */
import { useEffect, useRef, useState } from 'react'
import type { MapData, MapPlot, TransportRoute } from '../api'
import { FALLBACK_TERRAIN, TERRAIN } from '../game/art'
import { WorldScene } from '../game/three/WorldScene'

type Props = {
  map: MapData | null
  myCompanyId: string | null
  selectedPlotId: string | null
  onSelectPlot: (plot: MapPlot | null) => void
  /** rychlost herních hodin (0 = pauza → doprava stojí) */
  clockSpeed: number
  /** Herní hodina (0–23) pro denní/noční nádech scény. */
  hourOfDay?: number
  /** hráčem založené cargo trasy — jen po nich něco jezdí */
  routes: TransportRoute[]
}

const sig = (p: MapPlot) => [
  p.type, p.status, p.owner_id, p.owner_name, p.b_id, p.b_code,
  p.b_status, p.b_level, p.b_name,
].join('|')

function plotLabel(p: MapPlot): string {
  if (p.b_code === 'road') return 'silnice'
  if (p.b_id) return p.b_name ?? p.b_code ?? 'budova'
  const t = (TERRAIN[p.type] ?? FALLBACK_TERRAIN).label
  return p.owner_id ? `${t} · ${p.owner_name ?? 'vlastněno'}` : `${t} · volný pozemek`
}

export default function WorldMap({
  map, myCompanyId: _myCompanyId, selectedPlotId, onSelectPlot,
  clockSpeed, hourOfDay = 12, routes,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<WorldScene | null>(null)
  const mapRef = useRef<MapData | null>(null)
  const sigRef = useRef<Map<string, string>>(new Map())
  const selectRef = useRef(onSelectPlot)
  selectRef.current = onSelectPlot
  const [tip, setTip] = useState<{ x: number; y: number; plot: MapPlot } | null>(null)

  // scéna vzniká jednou, zaniká s unmountem (HMR-safe)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scene = new WorldScene(host, {
      onHover: (p, cx, cy) => setTip(p ? { x: cx, y: cy, plot: p } : null),
      onSelect: (p) => selectRef.current(p),
    })
    sceneRef.current = scene
    // po vzniku scény ihned aplikuj aktuální mapu, pokud už dorazila
    const m = mapRef.current
    if (m) {
      scene.setMap(m)
      sigRef.current = new Map(m.plots.map((p) => [p.id, sig(p)]))
    }
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  // mapa: full rebuild jen při resetu světa, jinak přírůstky
  useEffect(() => {
    if (!map) return
    mapRef.current = map
    const scene = sceneRef.current
    if (!scene) return
    const prev = sigRef.current
    if (prev.size === 0 || needsFullRebuild(prev, map)) {
      scene.setMap(map)
      sigRef.current = new Map(map.plots.map((p) => [p.id, sig(p)]))
      return
    }
    const changed = map.plots.filter((p) => prev.get(p.id) !== sig(p))
    if (changed.length) {
      scene.applyPlots(changed)
      for (const p of changed) prev.set(p.id, sig(p))
    }
  }, [map])

  useEffect(() => { sceneRef.current?.setRoutes(routes) }, [routes])
  useEffect(() => { sceneRef.current?.setClock(clockSpeed, hourOfDay) }, [clockSpeed, hourOfDay])
  useEffect(() => { sceneRef.current?.setSelected(selectedPlotId) }, [selectedPlotId])

  if (!map) return <div className="empty">načítám mapu světa…</div>

  return (
    <div className="map-stage" ref={hostRef}>
      {tip && (
        <div className="map-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <strong>[{tip.plot.x}, {tip.plot.y}]</strong> {plotLabel(tip.plot)}
          {tip.plot.b_status && tip.plot.b_status !== 'producing' && (
            <span className="dim"> · {tip.plot.b_status}</span>
          )}
        </div>
      )}
      <div className="map-tools">
        <button className="map-tool" title="Přiblížit" onClick={() => sceneRef.current?.zoomBy(1 / 1.4)}>＋</button>
        <button className="map-tool" title="Oddálit" onClick={() => sceneRef.current?.zoomBy(1.4)}>−</button>
        <button className="map-tool" title="Celý svět" onClick={() => sceneRef.current?.resetView()}>⤢</button>
      </div>
      <div className="map-hint3d">
        🖱️ táhni = posun · kolečko = zoom · pravé tlačítko = natočení
      </div>
    </div>
  )
}

/** reset světa / jiná mřížka → full rebuild scény */
function needsFullRebuild(prev: Map<string, string>, map: MapData): boolean {
  if (prev.size !== map.plots.length) return true
  const first = map.plots[0]
  return !first || !prev.has(first.id)
}

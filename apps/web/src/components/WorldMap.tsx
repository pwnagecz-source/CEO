import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MapData, MapPlot } from '../api'
import {
  FLOOR_H, TILE_H, TILE_W, diamond, diamondPoints, gridBounds, ownerColor, poly,
  tileCenter, up, type Pt,
} from '../game/iso'
import { STATUS_GLOW, shade, skinFor, terrainFor } from '../game/art'

type Props = {
  map: MapData | null
  myCompanyId: string | null
  selectedPlotId: string | null
  onSelectPlot: (plot: MapPlot | null) => void
  /** rychlost herních hodin (0 = pauza → auta stojí) */
  clockSpeed: number
}

/** Deterministický „náhodný“ detail terénu (stromy, skály) — stabilní mezi rendery. */
function hash2(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 974634) >>> 0
  h = (h ^ (h >> 13)) * 1274126177 >>> 0
  return ((h ^ (h >> 16)) >>> 0) / 4294967295
}

/** Lineární interpolace mezi dvěma body (pro okna lícující s pravou stěnou). */
function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function TerrainDetail({ plot, c }: { plot: MapPlot; c: Pt }) {
  const t = plot.type
  if (t === 'forest') {
    // 2–3 stromky rozmístěné deterministicky
    const n = 2 + Math.floor(hash2(plot.x, plot.y) * 2)
    return (
      <g>
        {Array.from({ length: n }, (_, i) => {
          const ox = (hash2(plot.x, plot.y, i + 1) - 0.5) * (TILE_W * 0.5)
          const oy = (hash2(plot.x, plot.y, i + 7) - 0.5) * (TILE_H * 0.5)
          const h = 9 + hash2(plot.x, plot.y, i + 13) * 6
          return (
            <g key={i} transform={`translate(${c.x + ox},${c.y + oy})`}>
              <rect x={-0.8} y={-h * 0.35} width={1.6} height={h * 0.4} fill="#4a3a26" />
              <polygon points={`0,${-h} ${4.5},${-h * 0.3} ${-4.5},${-h * 0.3}`} fill="#2c5236" />
              <polygon points={`0,${-h * 0.78} ${3.6},${-h * 0.12} ${-3.6},${-h * 0.12}`} fill="#3d7a4f" />
            </g>
          )
        })}
      </g>
    )
  }
  if (t === 'mine') {
    return (
      <g>
        {Array.from({ length: 3 }, (_, i) => {
          const ox = (hash2(plot.x, plot.y, i + 3) - 0.5) * (TILE_W * 0.45)
          const oy = (hash2(plot.x, plot.y, i + 9) - 0.5) * (TILE_H * 0.45)
          const r = 2 + hash2(plot.x, plot.y, i + 21) * 2.5
          return (
            <polygon
              key={i}
              points={`${c.x + ox - r},${c.y + oy} ${c.x + ox},${c.y + oy - r * 1.2} ${c.x + ox + r},${c.y + oy} ${c.x + ox},${c.y + oy + r * 0.5}`}
              fill="#6b6157"
            />
          )
        })}
      </g>
    )
  }
  if (t === 'water') {
    return (
      <g opacity={0.5}>
        <path d={`M ${c.x - 12} ${c.y} q 6 -3 12 0 q 6 3 12 0`} stroke="#8fc4e8" strokeWidth={1} fill="none" />
        <path d={`M ${c.x - 8} ${c.y + 6} q 5 -2.5 10 0`} stroke="#6ea3c9" strokeWidth={0.8} fill="none" />
      </g>
    )
  }
  if (t === 'commercial' || t === 'civic') {
    // dlažba/centrum: jemná tečka, aby plocha nebyla mrtvá
    return <circle cx={c.x} cy={c.y} r={1.4} fill="#ffffff" opacity={0.12} />
  }
  if (t === 'industrial' || t === 'utility') {
    // řídký štěrk/tráva: velké plochy jinak působí jako mrtvá barva
    if (hash2(plot.x, plot.y, 41) > 0.55) return null
    return (
      <g opacity={0.5}>
        {Array.from({ length: 2 }, (_, i) => {
          const ox = (hash2(plot.x, plot.y, i + 51) - 0.5) * TILE_W * 0.5
          const oy = (hash2(plot.x, plot.y, i + 61) - 0.5) * TILE_H * 0.5
          return <circle key={i} cx={c.x + ox} cy={c.y + oy} r={0.9} fill={t === 'utility' ? '#b9a8e8' : '#8a9384'} opacity={0.5} />
        })}
      </g>
    )
  }
  return null
}

/** Průmyslové obory, kterým rostou z komína (a občas i kouř). */
const CHIMNEY = new Set(['metallurgy', 'energy', 'mining', 'construction', 'manufacturing'])

/** Izometrická budova: hranol s nasvícenými stěnami a střechou. */
function Building({ plot, c }: { plot: MapPlot; c: Pt }) {
  const skin = skinFor(plot.b_industry, plot.b_retail)
  const tier = plot.b_tier ?? 1
  const level = plot.b_level ?? 1
  // Výška roste s tierem (větší provozy) i úrovní — ale s stropem, ať mapa
  // nepřeroste sama sebe.
  const hgt = Math.min(68, 18 + tier * 8 + (level - 1) * FLOOR_H * 0.6)
  const inset = 6 // budova nestojí až po okraj dlaždice
  const g = diamondPoints(c.x, c.y, TILE_W - inset * 2, TILE_H - inset)
  const glow = plot.b_status ? STATUS_GLOW[plot.b_status] : undefined

  const leftWall = poly([g.left, g.bottom, up(g.bottom, hgt), up(g.left, hgt)])
  const rightWall = poly([g.bottom, g.right, up(g.right, hgt), up(g.bottom, hgt)])
  const roof = poly([up(g.top, hgt), up(g.right, hgt), up(g.bottom, hgt), up(g.left, hgt)])

  return (
    <g>
      {/* vržený stín */}
      <polygon points={diamond(c.x + 3, c.y + 3, TILE_W - inset, TILE_H - inset * 0.6)}
               fill="#000" opacity={0.24} />
      <polygon points={leftWall} fill={skin.wallDark} />
      <polygon points={rightWall} fill={skin.wall} />
      <polygon points={roof} fill={skin.roof} />
      {/* hrana střechy pro čitelnost */}
      <polygon points={roof} fill="none" stroke="#00000040" strokeWidth={0.6} />

      {/* okna jako pásy lícující s pravou (nasvícenou) stěnou */}
      {Array.from({ length: Math.min(3, level) }, (_, i) => {
        const y0 = hgt - 5 - i * 7
        if (y0 < 4) return null
        const lit = plot.b_status === 'producing'
        return (
          <polygon
            key={i}
            points={poly([
              up(lerp(g.bottom, g.right, 0.2), y0),
              up(lerp(g.bottom, g.right, 0.8), y0),
              up(lerp(g.bottom, g.right, 0.8), y0 + 3),
              up(lerp(g.bottom, g.right, 0.2), y0 + 3),
            ])}
            fill={lit ? '#ffe9a8' : '#232a35'}
            opacity={0.92}
          />
        )
      })}

      {/* retail markýza */}
      {plot.b_retail && (
        <g>
          <polygon
            points={poly([
              up(g.bottom, hgt * 0.55), up(g.right, hgt * 0.55),
              up(g.right, hgt * 0.55 + 5), up(g.bottom, hgt * 0.55 + 5),
            ])}
            fill="#eee7d8"
          />
          <polygon
            points={poly([
              up(g.bottom, hgt * 0.55), up(g.right, hgt * 0.55),
              up(g.right, hgt * 0.55 + 2.4), up(g.bottom, hgt * 0.55 + 2.4),
            ])}
            fill="#c0453c"
          />
        </g>
      )}

      {/* komín / větrák pro těžký průmysl */}
      {plot.b_industry && CHIMNEY.has(plot.b_industry) && (
        <g>
          <rect x={c.x - 2} y={c.y - hgt - 9} width={4} height={10} fill={skin.wallDark} />
          {plot.b_status === 'producing' && (
            <circle cx={c.x} cy={c.y - hgt - 12} r={2.6} fill="#c9cdd4" opacity={0.5} className="smoke" />
          )}
        </g>
      )}

      {/* stavová kontrolka */}
      {glow && (
        <circle
          cx={c.x}
          cy={c.y - hgt - 4}
          r={2.4}
          fill={glow}
          className={plot.b_status === 'producing' ? 'pulse' : undefined}
        />
      )}

      {/* úrovně jako tečky na střeše */}
      {level > 1 && (
        <g>
          {Array.from({ length: Math.min(5, level - 1) }, (_, i) => (
            <circle key={i} cx={c.x - 8 + i * 4} cy={c.y - hgt + 2} r={1.3} fill="#ffffffcc" />
          ))}
        </g>
      )}
    </g>
  )
}

type TileProps = {
  plot: MapPlot
  myCompanyId: string | null
  isSel: boolean
  isHover: boolean
  onSelect: (p: MapPlot) => void
  onHover: (id: string | null) => void
}

/**
 * Jedna dlaždice. `memo` je tu kvůli výkonu: svět má 800 pozemků a hover by
 * jinak překreslil celou scénu při každém pohybu myši. Memoizace znamená, že
 * při hoveru se přepočítají jen dvě dlaždice (stará a nová).
 */
const Tile = memo(function Tile({ plot, myCompanyId, isSel, isHover, onSelect, onHover }: TileProps) {
  const c = tileCenter(plot.x, plot.y)
  const owned = plot.owner_id !== null
  const terr = terrainFor(plot.type, owned)
  const isMine = owned && plot.owner_id === myCompanyId
  const oc = ownerColor(plot.owner_id)

  return (
    <g
      className="tile"
      onClick={() => onSelect(plot)}
      onMouseEnter={() => onHover(plot.id)}
      onMouseLeave={() => onHover(null)}
    >
      <title>
        {`[${plot.x}, ${plot.y}] ${terr.label}` +
         (owned ? ` · ${plot.owner_name}${isMine ? ' (ty)' : ''}` : ' · volný pozemek') +
         (plot.b_name ? `\n${plot.b_name} · lvl ${plot.b_level} · ${plot.b_status}` : '')}
      </title>

      {/* podklad dlaždice — jemný jitter světlosti, aby velké plochy nežily
          jako jedna mrtvá barva, ale jako krajina */}
      <polygon points={diamond(c.x, c.y)} fill={shade(terr.fill, 0.94 + hash2(plot.x, plot.y, 31) * 0.12)} />
      {/* parcela: sotva viditelný obrys, ať je čitelná struktura pozemků */}
      <polygon
        points={diamond(c.x, c.y, TILE_W - 6, TILE_H - 3)}
        fill="none" stroke="#ffffff" strokeOpacity={0.055} strokeWidth={0.6}
      />
      {/* nasvícená horní hrana */}
      <polyline
        points={`${c.x - TILE_W / 2},${c.y} ${c.x},${c.y - TILE_H / 2} ${c.x + TILE_W / 2},${c.y}`}
        fill="none" stroke={terr.edge} strokeWidth={1}
      />
      <TerrainDetail plot={plot} c={c} />

      {/* vlastnictví */}
      {owned && (
        <polygon
          points={diamond(c.x, c.y, TILE_W - 4, TILE_H - 2)}
          fill="none" stroke={oc} strokeWidth={isMine ? 1.6 : 1}
          opacity={isMine ? 0.95 : 0.5}
        />
      )}

      {/* budova */}
      {plot.b_id && <Building plot={plot} c={c} />}

      {/* výběr / hover */}
      {(isSel || isHover) && (
        <polygon
          points={diamond(c.x, c.y)}
          fill={isSel ? '#58a6ff26' : '#ffffff0d'}
          stroke={isSel ? '#58a6ff' : '#ffffff66'}
          strokeWidth={isSel ? 1.8 : 1}
        />
      )}
    </g>
  )
})

type View = { x: number; y: number; w: number; h: number }

/* ── doprava: auta s modely, která opravdu jezdí po silnicích ─────────────── */

type Route = { pts: Pt[]; cum: number[]; len: number }

/** Izometrická dodávka: stín + korba + kabina. Malá, ale čitelná i oddáleně. */
function Truck({ g }: { g: React.RefObject<SVGGElement | null> }) {
  return (
    <g ref={g} style={{ willChange: 'transform' }}>
      <ellipse cx={0} cy={1.5} rx={7} ry={3} fill="#000" opacity={0.28} />
      {/* korba */}
      <polygon points="-6,-1 0,2 0,-4 -6,-7" fill="#8a5a3b" />
      <polygon points="0,2 6,-1 6,-7 0,-4" fill="#b07a4e" />
      <polygon points="-6,-7 0,-4 6,-7 0,-10" fill="#d09a66" />
      {/* kabina */}
      <polygon points="3,-1 6,0.5 6,-3.5 3,-5" fill="#3f4a5a" />
      <polygon points="6,0.5 8.5,-0.7 8.5,-4.7 6,-3.5" fill="#55637a" />
      <polygon points="3,-5 6,-3.5 8.5,-4.7 5.5,-6.2" fill="#74869f" />
      {/* kola */}
      <ellipse cx={-3.5} cy={0.6} rx={1.5} ry={0.9} fill="#14181f" />
      <ellipse cx={3.5} cy={0.2} rx={1.5} ry={0.9} fill="#14181f" />
    </g>
  )
}

function pointAt(route: Route, t: number): Pt {
  const d = t * route.len
  let i = 1
  while (i < route.cum.length - 1 && route.cum[i] < d) i++
  const seg = route.cum[i] - route.cum[i - 1] || 1
  const f = (d - route.cum[i - 1]) / seg
  const a = route.pts[i - 1]; const b = route.pts[i]
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

/**
 * Spočítá trasy pro auta: od státního tahu po souvislé síti k produkčním
 * budovám a zpět. BFS je multi-source ze všech státních dlaždic, takže
 * „parent“ řetěz dá nejkratší cestu k síti pro kteroukoli dlaždici.
 */
function buildRoutes(map: MapData): Route[] {
  const byPos = new Map<string, MapPlot>()
  for (const p of map.plots) byPos.set(`${p.x},${p.y}`, p)
  const isRoad = (p: MapPlot) => p.type === 'road' || p.b_code === 'road'
  const roads = map.plots.filter(isRoad)
  const parent = new Map<string, string | null>()
  const queue: MapPlot[] = []
  for (const r of roads) if (r.type === 'road') { parent.set(`${r.x},${r.y}`, null); queue.push(r) }
  while (queue.length > 0) {
    const t = queue.shift()!
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = `${t.x + dx},${t.y + dy}`
      if (parent.has(k)) continue
      const n = byPos.get(k)
      if (n && isRoad(n)) { parent.set(k, `${t.x},${t.y}`); queue.push(n) }
    }
  }
  const routes: Route[] = []
  for (const p of map.plots) {
    // auto jezdí, dokud má budova co odvážet: výroba i plný sklad (= čeká na odvoz)
    if (!p.b_id || (p.b_status !== 'producing' && p.b_status !== 'full') || !p.connected) continue
    if (routes.length >= 40) break
    let entry: string | null = null
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = `${p.x + dx},${p.y + dy}`
      if (parent.has(k)) { entry = k; break }
    }
    if (!entry) continue
    const pts: Pt[] = [tileCenter(p.x, p.y)]
    let cur: string | null = entry
    while (cur) {
      const [x, y] = [Number(cur.split(',')[0]), Number(cur.split(',')[1])]
      pts.push(tileCenter(x, y))
      cur = parent.get(cur) ?? null
    }
    pts.reverse() // od hlavního tahu k budově
    const cum = [0]
    let len = 0
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
      cum.push(len)
    }
    if (len > 1) routes.push({ pts, cum, len })
  }
  return routes
}

/** Vrstva aut: rAF smyčka posouvá dodávky po trasách (ping-pong tam a zpět). */
function TrafficLayer({ map, clockSpeed }: { map: MapData; clockSpeed: number }) {
  const routes = useMemo(() => buildRoutes(map), [map])
  const refs = useRef<Array<React.RefObject<SVGGElement | null>>>([])
  refs.current = routes.map((_, i) => refs.current[i] ?? { current: null })
  const speedRef = useRef(clockSpeed)
  speedRef.current = clockSpeed

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let clock = 0
    const step = (now: number) => {
      const dt = now - last
      last = now
      clock += dt * (0.00006 * speedRef.current)   // 0 = pauza → auta stojí
      routes.forEach((r, i) => {
        const el = refs.current[i]?.current
        if (!el) return
        const u = (clock + i * 0.37) % 2
        const t = u < 1 ? u : 2 - u
        const p = pointAt(r, t)
        el.setAttribute('transform', `translate(${p.x.toFixed(1)},${(p.y - 2).toFixed(1)})`)
      })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [routes])

  if (routes.length === 0) return null
  return (
    <g className="traffic" pointerEvents="none">
      {routes.map((_, i) => <Truck key={i} g={refs.current[i]} />)}
    </g>
  )
}

/**
 * Izometrická mapa světa — herní pohled.
 *
 * Painter's algorithm: dlaždice i budovy kreslíme seřazené podle hloubky (x+y),
 * takže bližší objekty správně překrývají vzdálenější a budovy „stojí“ za sebou.
 *
 * K velkému světu (40×20 = 800 pozemků) patří ovládání kamery: kolečko = zoom
 * na kurzor, tažení = posun, dvojklik / tlačítko ⤢ = celý svět.
 */
export default function WorldMap({ map, myCompanyId, selectedPlotId, onSelectPlot, clockSpeed }: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [view, setView] = useState<View | null>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  const bounds = useMemo(
    () => (map ? gridBounds(map.grid.w, map.grid.h) : gridBounds(40, 20)),
    [map],
  )

  const ordered = useMemo(
    () => (map ? [...map.plots].sort((a, b) => (a.x + a.y) - (b.x + b.y) || a.x - b.x) : []),
    [map],
  )

  // Když se změní svět (reset / jiná mapa), skoč zpět na celou mapu.
  useEffect(() => {
    setView({ x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height })
  }, [bounds.x, bounds.y, bounds.width, bounds.height])

  const onHover = useCallback((id: string | null) => setHoverId(id), [])
  const onSelect = useCallback((p: MapPlot) => onSelectPlot(p), [onSelectPlot])

  const v = view ?? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
  const minW = bounds.width / 8   // maximální přiblížení
  const maxW = bounds.width       // maximální oddálení = celý svět

  /** Klientské souřadnice myši → souřadnice v SVG (přes inverzní CTM). */
  function toSvg(e: { clientX: number; clientY: number }): Pt | null {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!svg || !ctm) return null
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }

  /** Zoom na bod pod kurzorem; poměr stran viewBoxu zůstává, jen se škáluje. */
  function zoomAt(factor: number, focus?: Pt | null) {
    const nw = Math.max(minW, Math.min(maxW, v.w * factor))
    if (nw === v.w) return
    const f = focus ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 }
    const k = nw / v.w
    setView({ x: f.x - (f.x - v.x) * k, y: f.y - (f.y - v.y) * k, w: nw, h: v.h * k })
  }

  function resetView() {
    setView({ x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height })
  }

  // Kolečko myši: React má wheel listener pasivní, takže preventDefault musí
  // jít přes nativní listener — jinak by stránka při zoomu skákala.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(e.deltaY > 0 ? 1.16 : 1 / 1.16, toSvg(e))
    }
    svg.addEventListener('wheel', handler, { passive: false })
    return () => svg.removeEventListener('wheel', handler)
  })

  if (!map) return <div className="empty">načítám mapu světa…</div>

  return (
    <div className="map-stage">
      <svg
        ref={svgRef}
        viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
        className="worldmap"
        role="img"
        aria-label="Izometrická mapa světa"
        onDoubleClick={resetView}
        onPointerDown={(e) => {
          const p = toSvg(e)
          if (p) drag.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y }
        }}
        onPointerMove={(e) => {
          if (!drag.current || !svgRef.current) return
          const r = svgRef.current.getBoundingClientRect()
          const scale = v.w / r.width
          setView({
            ...v,
            x: drag.current.vx - (e.clientX - drag.current.x) * scale,
            y: drag.current.vy - (e.clientY - drag.current.y) * scale,
          })
        }}
        onPointerUp={() => { drag.current = null }}
        onPointerLeave={() => { drag.current = null }}
        onClick={(e) => { if (e.target === e.currentTarget) onSelectPlot(null) }}
      >
        <defs>
          <linearGradient id="skyfade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#16233a" />
            <stop offset="55%" stopColor="#0d1524" />
            <stop offset="100%" stopColor="#080d16" />
          </linearGradient>
        </defs>
        <rect x={v.x} y={v.y} width={v.w} height={v.h} fill="url(#skyfade)" />

        {ordered.map((p) => (
          <Tile
            key={p.id}
            plot={p}
            myCompanyId={myCompanyId}
            isSel={p.id === selectedPlotId}
            isHover={p.id === hoverId}
            onSelect={onSelect}
            onHover={onHover}
          />
        ))}

        {map && <TrafficLayer map={map} clockSpeed={clockSpeed} />}
      </svg>

      <div className="map-tools">
        <button className="map-tool" title="Přiblížit" onClick={() => zoomAt(1 / 1.4)}>＋</button>
        <button className="map-tool" title="Oddálit" onClick={() => zoomAt(1.4)}>−</button>
        <button className="map-tool" title="Celý svět (nebo dvojklik na mapu)" onClick={resetView}>⤢</button>
      </div>
    </div>
  )
}

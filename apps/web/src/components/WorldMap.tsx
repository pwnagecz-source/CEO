import { useMemo, useState } from 'react'
import type { MapData, MapPlot } from '../api'
import {
  FLOOR_H, TILE_H, TILE_W, diamond, diamondPoints, gridBounds, ownerColor, poly,
  tileCenter, up, type Pt,
} from '../game/iso'
import { STATUS_GLOW, skinFor, terrainFor } from '../game/art'

type Props = {
  map: MapData | null
  myCompanyId: string | null
  selectedPlotId: string | null
  onSelectPlot: (plot: MapPlot | null) => void
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
              <polygon points={`0,${-h * 0.78} ${3.6},${-h * 0.12} ${-3.6},${-h * 0.12}`} fill="#356243" />
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
        <path
          d={`M ${c.x - 12} ${c.y} q 6 -3 12 0 q 6 3 12 0`}
          stroke="#7fb2d9" strokeWidth={1} fill="none"
        />
        <path
          d={`M ${c.x - 8} ${c.y + 6} q 5 -2.5 10 0`}
          stroke="#6ea3c9" strokeWidth={0.8} fill="none"
        />
      </g>
    )
  }
  return null
}

/** Izometrická budova: hranol s nasvícenými stěnami a střechou. */
function Building({ plot, c }: { plot: MapPlot; c: Pt }) {
  const skin = skinFor(plot.b_industry, plot.b_retail)
  const tier = plot.b_tier ?? 1
  const level = plot.b_level ?? 1
  // Výška roste s tierem (větší provozy) i úrovní — ale s stropem, ať mapa
  // nepřeroste sama sebe.
  const hgt = Math.min(64, 16 + tier * 7 + (level - 1) * FLOOR_H * 0.6)
  const inset = 7 // budova nestojí až po okraj dlaždice
  const g = diamondPoints(c.x, c.y, TILE_W - inset * 2, TILE_H - inset)
  const glow = plot.b_status ? STATUS_GLOW[plot.b_status] : undefined

  const leftWall = poly([g.left, g.bottom, up(g.bottom, hgt), up(g.left, hgt)])
  const rightWall = poly([g.bottom, g.right, up(g.right, hgt), up(g.bottom, hgt)])
  const roof = poly([up(g.top, hgt), up(g.right, hgt), up(g.bottom, hgt), up(g.left, hgt)])

  return (
    <g>
      {/* vržený stín */}
      <polygon points={diamond(c.x + 3, c.y + 3, TILE_W - inset, TILE_H - inset * 0.6)}
               fill="#000" opacity={0.22} />
      <polygon points={leftWall} fill={skin.wallDark} />
      <polygon points={rightWall} fill={skin.wall} />
      <polygon points={roof} fill={skin.roof} />
      {/* hrana střechy pro čitelnost */}
      <polygon points={roof} fill="none" stroke="#00000033" strokeWidth={0.6} />

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
            fill={lit ? '#ffe9a8' : '#242a33'}
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
            fill="#e8e2d4"
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

      {/* komín / větrák pro průmysl a energii */}
      {(plot.b_industry === 'metallurgy' || plot.b_industry === 'energy') && (
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

/**
 * Izometrická mapa světa — herní pohled.
 *
 * Painter's algorithm: dlaždice i budovy kreslíme seřazené podle hloubky (x+y),
 * takže bližší objekty správně překrývají vzdálenější a budovy „stojí“ za sebou.
 */
export default function WorldMap({ map, myCompanyId, selectedPlotId, onSelectPlot }: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null)

  const bounds = useMemo(
    () => (map ? gridBounds(map.grid.w, map.grid.h) : gridBounds(24, 12)),
    [map],
  )

  const ordered = useMemo(
    () => (map ? [...map.plots].sort((a, b) => (a.x + a.y) - (b.x + b.y) || a.x - b.x) : []),
    [map],
  )

  if (!map) return <div className="empty">načítám mapu světa…</div>

  return (
    <svg
      viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
      className="worldmap"
      role="img"
      aria-label="Izometrická mapa světa"
      onClick={(e) => { if (e.target === e.currentTarget) onSelectPlot(null) }}
    >
      <defs>
        <linearGradient id="skyfade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#141a24" />
          <stop offset="100%" stopColor="#0b0e13" />
        </linearGradient>
      </defs>
      <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} fill="url(#skyfade)" />

      {ordered.map((p) => {
        const c = tileCenter(p.x, p.y)
        const owned = p.owner_id !== null
        const terr = terrainFor(p.type, owned)
        const isMine = owned && p.owner_id === myCompanyId
        const isSel = p.id === selectedPlotId
        const isHover = p.id === hoverId
        const oc = ownerColor(p.owner_id)

        return (
          <g
            key={p.id}
            className="tile"
            onClick={() => onSelectPlot(p)}
            onMouseEnter={() => setHoverId(p.id)}
            onMouseLeave={() => setHoverId(null)}
          >
            <title>
              {`[${p.x}, ${p.y}] ${terr.label}` +
               (owned ? ` · ${p.owner_name}${isMine ? ' (ty)' : ''}` : ' · volný pozemek') +
               (p.b_name ? `\n${p.b_name} · lvl ${p.b_level} · ${p.b_status}` : '')}
            </title>

            {/* podklad dlaždice */}
            <polygon points={diamond(c.x, c.y)} fill={terr.fill} />
            {/* nasvícená horní hrana */}
            <polyline
              points={`${c.x - TILE_W / 2},${c.y} ${c.x},${c.y - TILE_H / 2} ${c.x + TILE_W / 2},${c.y}`}
              fill="none" stroke={terr.edge} strokeWidth={1}
            />
            <TerrainDetail plot={p} c={c} />

            {/* vlastnictví */}
            {owned && (
              <polygon
                points={diamond(c.x, c.y, TILE_W - 4, TILE_H - 2)}
                fill="none" stroke={oc} strokeWidth={isMine ? 1.6 : 1}
                opacity={isMine ? 0.95 : 0.5}
              />
            )}

            {/* budova */}
            {p.b_id && <Building plot={p} c={c} />}

            {/* výběr / hover */}
            {(isSel || isHover) && (
              <polygon
                points={diamond(c.x, c.y)}
                fill={isSel ? '#4ea8ff22' : '#ffffff0d'}
                stroke={isSel ? '#4ea8ff' : '#ffffff66'}
                strokeWidth={isSel ? 1.8 : 1}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

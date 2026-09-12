import type { Audit, Company, Macro, MapData, MapPlot } from '../api'
import { compact, money, pct } from '../fmt'
import { STATUS_GLOW, TERRAIN, terrainFor } from '../game/art'
import { ownerColor } from '../game/iso'
import WorldMap from './WorldMap'

type Props = {
  map: MapData | null
  company: Company | null
  companies: { id: string; name: string }[]
  companyId: string | null
  onSelectCompany: (id: string) => void
  macro: Macro | null
  audit: Audit | null
  selectedPlot: MapPlot | null
  onSelectPlot: (p: MapPlot | null) => void
  onOpenTerminal: () => void
}

const STATUS_LABEL: Record<string, string> = {
  producing: 'vyrábí', construction: 'staví se', idle: 'stojí',
  starved: 'chybí vstupy', full: 'sklad plný', paused: 'pozastaveno',
}

/**
 * Herní pohled: mapa jako hlavní scéna, kolem ní jen to, co hráč opravdu čte.
 * Žádné bid/ask tabulky, žádné invarianty v obličeji — ty zůstávají v Terminálu.
 */
export default function GameView({
  map, company, companies, companyId, onSelectCompany, macro, audit,
  selectedPlot, onSelectPlot, onOpenTerminal,
}: Props) {
  const myPlots = map?.plots.filter((p) => p.owner_id === companyId) ?? []
  const myBuildings = myPlots.filter((p) => p.b_id)

  return (
    <div className="game">
      {/* ── HUD ─────────────────────────────────────────────────────────── */}
      <div className="hud">
        <div className="hud-left">
          <select
            className="hud-company"
            value={companyId ?? ''}
            onChange={(e) => onSelectCompany(e.target.value)}
          >
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="hud-stat">
            <span className="hud-k">Peníze</span>
            <span className="hud-v money">{money(company?.cash ?? 0)}</span>
          </div>
          <div className="hud-stat">
            <span className="hud-k">Sklad</span>
            <span className="hud-v">{money(company?.inventoryValue ?? 0)}</span>
          </div>
          <div className="hud-stat">
            <span className="hud-k">Budovy</span>
            <span className="hud-v">{myBuildings.length}</span>
          </div>
          <div className="hud-stat">
            <span className="hud-k">Pozemky</span>
            <span className="hud-v">{myPlots.length}</span>
          </div>
          <div className="hud-stat">
            <span className="hud-k">Ekonomika světa</span>
            <span className="hud-v dim">{compact(macro?.m2)}</span>
          </div>
        </div>
        <div className="hud-right">
          {audit && <span className={`badge ${audit.ok ? 'pass' : 'fail'}`}>{audit.ok ? 'svět v pořádku' : 'pozor'}</span>}
          <button className="ghost" onClick={onOpenTerminal}>Terminál →</button>
        </div>
      </div>

      {/* ── scéna + inspektor ───────────────────────────────────────────── */}
      <div className="game-body">
        <div className="map-wrap">
          <WorldMap
            map={map}
            myCompanyId={companyId}
            selectedPlotId={selectedPlot?.id ?? null}
            onSelectPlot={onSelectPlot}
          />
          <div className="map-legend">
            {Object.entries(TERRAIN).filter(([k]) => k !== 'unowned').map(([k, t]) => (
              <span key={k} className="lg">
                <i style={{ background: t.fill, borderColor: t.edge }} />{t.label}
              </span>
            ))}
            <span className="lg"><i className="dot" style={{ background: STATUS_GLOW.producing }} />vyrábí</span>
            <span className="lg"><i className="dot" style={{ background: STATUS_GLOW.construction }} />staví se</span>
          </div>
        </div>

        <aside className="inspector">
          {!selectedPlot && (
            <div className="insp-empty">
              <h3>Klikni na dlaždici</h3>
              <p className="dim">
                Mapa je celý tvůj svět: {map?.grid.w ?? 24}×{map?.grid.h ?? 12} pozemků.
                Barevný obrys = majitel, tečka nad budovou = co právě dělá.
              </p>
              <p className="dim">
                Tvé pozemky mají silný obrys v barvě
                <i className="swatch" style={{ background: ownerColor(companyId) }} />.
              </p>
            </div>
          )}

          {selectedPlot && (
            <>
              <div className="insp-head">
                <span className="insp-coord">[{selectedPlot.x}, {selectedPlot.y}]</span>
                <span className="dim">{terrainFor(selectedPlot.type, selectedPlot.owner_id !== null).label}</span>
              </div>

              {selectedPlot.owner_id ? (
                <div className="insp-owner" style={{ borderColor: ownerColor(selectedPlot.owner_id) }}>
                  {selectedPlot.owner_name}
                  {selectedPlot.owner_id === companyId && <span className="badge info">tvé</span>}
                </div>
              ) : (
                <div className="insp-owner dim">volný pozemek</div>
              )}

              {selectedPlot.b_id ? (
                <div className="insp-building">
                  <h3>{selectedPlot.b_name}</h3>
                  <div className="insp-status" style={{ color: STATUS_GLOW[selectedPlot.b_status ?? 'idle'] }}>
                    <i className="dot" style={{ background: STATUS_GLOW[selectedPlot.b_status ?? 'idle'] }} />
                    {STATUS_LABEL[selectedPlot.b_status ?? 'idle'] ?? selectedPlot.b_status}
                  </div>
                  <table className="insp-table">
                    <tbody>
                      <tr><td className="dim">Úroveň</td><td>{selectedPlot.b_level}</td></tr>
                      <tr><td className="dim">Odvětví</td><td>{selectedPlot.b_industry ?? '—'}</td></tr>
                      <tr><td className="dim">Produkuje</td><td>{selectedPlot.b_output ?? '—'}</td></tr>
                      {selectedPlot.b_retail && <tr><td className="dim">Prodejna</td><td>ano (NPC zákazníci)</td></tr>}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="insp-empty">
                  <p className="dim">
                    {selectedPlot.owner_id === companyId
                      ? 'Tvůj pozemek bez budovy. Stavění přijde v další fázi.'
                      : selectedPlot.richness !== 1
                        ? `Bohatství ložiska ${pct(selectedPlot.richness - 1, 0)} oproti průměru.`
                        : 'Bez budovy.'}
                  </p>
                </div>
              )}

              <button className="ghost wide" onClick={() => onSelectPlot(null)}>Zavřít</button>
            </>
          )}

          <div className="insp-tip">
            <h4>Tip</h4>
            <p className="dim">
              Surovinové budovy (les, důl, voda) musí stát na správném terénu —
              proto mapa terén vůbec ukazuje. Továrny chtějí průmyslovou zónu,
              obchody komerční.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}

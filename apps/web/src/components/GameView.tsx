import type { Audit, CatalogRow, Company, Macro, MapData, MapPlot, QuestState } from '../api'
import { compact, money, pct } from '../fmt'
import { STATUS_GLOW, TERRAIN, terrainFor } from '../game/art'
import { ownerColor } from '../game/iso'
import QuestRail from './QuestRail'
import WorldMap from './WorldMap'

type Props = {
  map: MapData | null
  catalog: CatalogRow[]
  company: Company | null
  companies: { id: string; name: string }[]
  companyId: string | null
  onSelectCompany: (id: string) => void
  macro: Macro | null
  audit: Audit | null
  selectedPlot: MapPlot | null
  onSelectPlot: (p: MapPlot | null) => void
  onBuy: (plot: MapPlot) => void
  onBuild: (plot: MapPlot, code: string) => void
  onNewCompany: () => void
  onOpenTerminal: () => void
  onQuickSell: (itemCode: string) => void
  quests: QuestState | null
  busy: string | null
  err: string | null
}

const STATUS_LABEL: Record<string, string> = {
  producing: 'vyrábí', construction: 'staví se', idle: 'stojí',
  starved: 'chybí vstupy', full: 'sklad plný', paused: 'pozastaveno',
}

/**
 * Herní pohled: mapa jako hlavní scéna, inspektor jako jediné ovládací místo.
 * Tady se nakupuje pozemek a staví budova — jeden klik, žádné tabulky bid/ask.
 */
export default function GameView({
  map, catalog, company, companies, companyId, onSelectCompany, macro, audit,
  selectedPlot, onSelectPlot, onBuy, onBuild, onNewCompany, onOpenTerminal, onQuickSell,
  quests, busy, err,
}: Props) {
  const terminalLocked = quests !== null && !quests.terminalUnlocked
  const myPlots = map?.plots.filter((p) => p.owner_id === companyId) ?? []
  const myBuildings = myPlots.filter((p) => p.b_id)
  const cash = company?.cash ?? 0

  /** Co lze postavit na vybraném terénu (katalog filtrovaný podle plot_type). */
  const buildable = selectedPlot
    ? catalog.filter((c) => c.plot_type === selectedPlot.type)
    : []

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
            <span className="hud-v money">{money(cash)}</span>
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
          <button className="ghost" onClick={onNewCompany}>＋ Nová firma</button>
          <button
            className={'ghost' + (terminalLocked ? ' is-locked' : '')}
            title={terminalLocked
              ? 'Terminál se odemkne po prvním prodeji (úkol „Prodej první zboží“)'
              : 'Expertní order book a příkazy'}
            onClick={onOpenTerminal}
          >
            {terminalLocked ? '🔒 Terminál' : 'Terminál →'}
          </button>
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
          <QuestRail quests={quests} />
          {busy && <div className="insp-busy">{busy}</div>}
          {err && <div className="insp-err">{err}</div>}

          {!selectedPlot && (
            <div className="insp-empty">
              <h3>Klikni na dlaždici</h3>
              <p className="dim">
                Svět má {map?.grid.w ?? 40}×{map?.grid.h ?? 20} pozemků. Volné si můžeš koupit,
                na vlastní postavit. Barevný obrys = majitel, tečka nad budovou = co právě dělá.
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
                <div className="insp-owner dim">volný pozemek · {money(selectedPlot.assessed_value)}</div>
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
                      <tr><td className="dim">Produkuje</td><td>{selectedPlot.b_output ?? '—'}</td></tr>
                      <tr><td className="dim">Kapacita/h</td><td>{catalog.find((c) => c.code === selectedPlot.b_code)?.throughput ?? '—'}</td></tr>
                      <tr><td className="dim">Provozní náklad/h</td><td>{money(catalog.find((c) => c.code === selectedPlot.b_code)?.upkeep_hour ?? 0)}</td></tr>
                      {selectedPlot.b_retail && <tr><td className="dim">Prodejna</td><td>ano (NPC zákazníci)</td></tr>}
                    </tbody>
                  </table>
                </div>
              ) : selectedPlot.owner_id === companyId ? (
                <div className="insp-build">
                  <h3>Co tady postavíš?</h3>
                  <p className="dim">Na tomto terénu jde postavit:</p>
                  {buildable.length === 0 && <p className="dim">Nic — terén se pro stavbu nehodí.</p>}
                  {buildable.map((b) => (
                    <div key={b.code} className="build-opt">
                      <div className="build-opt__main">
                        <span className="build-opt__name">{b.name}</span>
                        <span className="build-opt__meta">
                          {b.output_name ?? '—'} · {compact(b.throughput)}/h ·
                          provoz {money(b.upkeep_hour)}/h
                        </span>
                      </div>
                      <button className="btn btn--primary btn--sm"
                        disabled={!!busy || cash < b.capex}
                        onClick={() => onBuild(selectedPlot, b.code)}>
                        {money(b.capex)}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="insp-buy">
                  <p className="dim">
                    {selectedPlot.richness !== 1 && (
                      <>Ložisko je o <strong>{pct(selectedPlot.richness - 1, 0)}</strong> bohatší/chudší
                        než průměr. </>)}
                    Terén <strong>{terrainFor(selectedPlot.type, false).label}</strong> umožňuje
                    stavět: {buildable.map((b) => b.name).join(', ') || 'nic'}.
                  </p>
                  {!selectedPlot.owner_id && (
                    <button className="btn btn--primary wide"
                      disabled={!!busy || cash < selectedPlot.assessed_value}
                      onClick={() => onBuy(selectedPlot)}>
                      Koupit pozemek · {money(selectedPlot.assessed_value)}
                    </button>
                  )}
                </div>
              )}

              <button className="ghost wide" onClick={() => onSelectPlot(null)}>Zavřít</button>
            </>
          )}

          {(company?.inventory ?? []).some((r) => r.available > 0) && (
            <div className="insp-stock">
              <h3>Tvůj sklad</h3>
              {(company?.inventory ?? []).filter((r) => r.available > 0).map((r) => (
                <div key={`${r.item}-${r.quality_tier}`} className="stock-row">
                  <span className="stock-row__name">{r.name}</span>
                  <span className="stock-row__qty">{Math.round(r.available)} ks</span>
                  <button className="btn btn--sm" disabled={!!busy}
                    title="Prodat vše najednou (market order)"
                    onClick={() => onQuickSell(r.item)}>⚡ Prodat</button>
                </div>
              ))}
              <p className="dim">Prodej jde přes order book — cenu určuje trh, ne hra.</p>
            </div>
          )}

          <div className="insp-tip">
            <h4>Jak to funguje</h4>
            <p className="dim">
              Surovinové budovy (les, důl, voda) musí stát na správném terénu —
              proto mapa terén vůbec ukazuje. Továrny chtějí průmyslovou zónu,
              obchody komerční. Nákup i stavba odečtou peníze z tvé pokladny
              a zmizí z ekonomiky světa (proto ceny neklesají donekonečna).
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}

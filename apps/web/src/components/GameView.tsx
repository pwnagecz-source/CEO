import { useEffect, useState } from 'react'
import type {
  Audit, CatalogRow, Clock, Company, Macro, MapData, MapPlot, QuestState, RoadQuote,
  RouteMode, RouteQuoteResult, TransportRoute,
} from '../api'
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
  onOpenResearch: () => void
  onOpenContracts: () => void
  onOpenFinance: () => void
  onUpgrade: (buildingId: string) => void
  onDemolish: (buildingId: string) => void
  onQuickSell: (itemCode: string) => void
  onHireRoad: (plot: MapPlot) => void
  onOpenCodex: () => void
  onSpeed: (speed: number) => void
  quests: QuestState | null
  clock: Clock | null
  roadQuote: RoadQuote | null
  routes: TransportRoute[]
  routeFrom: MapPlot | null
  routeQuote: RouteQuoteResult | null
  routeQuoteErr: string | null
  onRouteFrom: (p: MapPlot | null) => void
  onCreateRoute: (to: MapPlot, mode: RouteMode, vehicles: number) => void
  onDeleteRoute: (id: string) => void
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
  onHireRoad, onOpenCodex, onOpenResearch, onOpenContracts, onOpenFinance,
  onUpgrade, onDemolish, onSpeed, quests, clock, roadQuote,
  routes, routeFrom, routeQuote, routeQuoteErr, onRouteFrom, onCreateRoute, onDeleteRoute,
  busy, err,
}: Props) {
  // Úrovňová křivka je stejná jako na serveru: xpForLevel(n) = 250·(n−1)·n
  const coLevel = company?.level ?? 1
  const coXp = company?.xp ?? 0
  const xpPrev = 250 * (coLevel - 1) * coLevel
  const xpNext = coLevel >= 10 ? null : 250 * coLevel * (coLevel + 1)
  const xpPct = xpNext === null ? 100
    : Math.min(100, Math.round(((coXp - xpPrev) / (xpNext - xpPrev)) * 100))
  const terminalLocked = quests !== null && !quests.terminalUnlocked
  // Cargo formulář: vybraný druh dopravy a počet vozidel pro aktuální nabídku.
  const [rMode, setRMode] = useState<RouteMode>('truck')
  const [rVehicles, setRVehicles] = useState(1)
  useEffect(() => {
    if (routeQuote) {
      setRMode(routeQuote.modes[0]?.mode ?? 'truck')
      setRVehicles(1)
    }
  }, [routeQuote])
  const offer = routeQuote?.modes.find((m) => m.mode === rMode) ?? routeQuote?.modes[0]
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
          <div className="hud-clock" title="Herní čas: tick = jedna hodina">
            <span className="hud-clock__label">
              🗓 Den {clock?.day ?? 1} · {String(clock?.hour ?? 0).padStart(2, '0')}:00
            </span>
            <div className="hud-speed">
              {[0, 1, 2, 4].map((sp) => (
                <button key={sp}
                  className={'hud-speed__btn' + ((clock?.speed ?? 1) === sp ? ' is-sel' : '')}
                  title={sp === 0 ? 'Pauza' : `Rychlost ${sp}×`}
                  onClick={() => onSpeed(sp)}>
                  {sp === 0 ? '⏸' : `${sp}×`}
                </button>
              ))}
            </div>
          </div>
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
          <div className="hud-stat hud-level" title={`${coXp} XP${xpNext !== null ? ` · další úroveň v ${xpNext} XP` : ' · max'}`}>
            <span className="hud-k">Úroveň</span>
            <span className="hud-v">⭐ {coLevel}</span>
            <div className="xpbar"><i style={{ width: `${xpPct}%` }} /></div>
          </div>
          <div className="hud-stat">
            <span className="hud-k">Ekonomika světa</span>
            <span className="hud-v dim">{compact(macro?.m2)}</span>
          </div>
        </div>
        <div className="hud-right">
          {audit && <span className={`badge ${audit.ok ? 'pass' : 'fail'}`}>{audit.ok ? 'svět v pořádku' : 'pozor'}</span>}
          <button className="ghost" title="Státní zakázky — garantovaný odbyt" onClick={onOpenContracts}>📋 Zakázky</button>
          <button className="ghost" title="Úrovně, XP a výzkumný strom" onClick={onOpenResearch}>🔬 Výzkum</button>
          <button className="ghost" title="Výsledovka, půjčky, manažeři" onClick={onOpenFinance}>💰 Finance</button>
          <button className="ghost" onClick={onOpenCodex}>📖 Kniha</button>
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
            clockSpeed={clock?.speed ?? 1}
            hourOfDay={clock?.hour ?? 12}
            routes={routes}
          />
          {routeFrom && (
            <div className="route-draft">
              🚚 Trasa z <strong>{routeFrom.b_name ?? `[${routeFrom.x},${routeFrom.y}]`}</strong> —
              klikni na cílovou budovu
              <button className="ghost" onClick={() => onRouteFrom(null)}>✕ zrušit</button>
            </div>
          )}
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

              {selectedPlot.b_id && selectedPlot.owner_id === companyId && !selectedPlot.connected && (
                <div className="insp-road">
                  <strong>🚧 Bez silnice.</strong>
                  <p className="dim">
                    Produkce stojí, dokud pozemek nenapojíš na státní síť.
                    {roadQuote && <> Nejkratší trasa: <strong>{roadQuote.tiles} dl.</strong> za{' '}
                      <strong>{money(roadQuote.cost)}</strong>.</>}
                  </p>
                  <button className="btn btn--primary wide" disabled={!!busy}
                    onClick={() => onHireRoad(selectedPlot)}>
                    🚜 Najmout stavební firmu
                  </button>
                  <p className="dim">
                    …nebo kup sousední pozemky a postav „Silnici“ sám — vyjde to stejně,
                    jen to naklikáš.
                  </p>
                </div>
              )}

              {selectedPlot.b_id ? (
                <div className="insp-building">
                  <h3>{selectedPlot.b_name}</h3>
                  <div className="insp-status" style={{ color: STATUS_GLOW[selectedPlot.b_status ?? 'idle'] }}>
                    <i className="dot" style={{ background: STATUS_GLOW[selectedPlot.b_status ?? 'idle'] }} />
                    {STATUS_LABEL[selectedPlot.b_status ?? 'idle'] ?? selectedPlot.b_status}
                  </div>
                  <div className="insp-cargo-btns">
                    {routeFrom?.id === selectedPlot.id ? (
                      <button className="ghost wide" onClick={() => onRouteFrom(null)}>
                        ✕ Zrušit výběr odkud
                      </button>
                    ) : (
                      <button className="ghost wide" onClick={() => onRouteFrom(selectedPlot)}>
                        🚚 Vézt zboží odsud…
                      </button>
                    )}
                  </div>
                  {selectedPlot.owner_id === companyId && (
                    <div className="insp-cargo-btns">
                      {(() => {
                        const bt = catalog.find((c) => c.code === selectedPlot.b_code)
                        const lvl = selectedPlot.b_level ?? 1
                        const atMax = bt ? lvl >= bt.max_level : false
                        const cost = bt ? Math.round(bt.capex * 0.6 * lvl * 100) / 100 : 0
                        return (
                          <button className="ghost" disabled={!!busy || atMax}
                            title={atMax ? 'Maximální úroveň'
                              : `+30 % výkon, +35 % sklad (úroveň firmy musí být ${lvl + 1}+)`}
                            onClick={() => onUpgrade(selectedPlot.b_id!)}>
                            {atMax ? '⬆ Max úroveň' : `⬆ Upgrade · ${money(cost)}`}
                          </button>
                        )
                      })()}
                      <button className="ghost danger" disabled={!!busy}
                        title="Zbourá budovu; stát odkoupí 25 % capexu × úroveň. Trasy přes pozemek se zruší."
                        onClick={() => onDemolish(selectedPlot.b_id!)}>
                        🧨 Zbourat
                      </button>
                    </div>
                  )}
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

              {routeFrom && routeFrom.id !== selectedPlot.id && (
                <div className="insp-cargo">
                  <h3>🚚 Nová trasa</h3>
                  <p className="dim">
                    {routeFrom.b_name} → {selectedPlot.b_name ?? 'cíl'}
                  </p>
                  {routeQuoteErr && <div className="insp-err">{routeQuoteErr}</div>}
                  {offer && (
                    <>
                      <div className="cargo-modes">
                        {routeQuote?.modes.map((m) => (
                          <button key={m.mode}
                            className={'cargo-mode' + (offer.mode === m.mode ? ' is-sel' : '')}
                            onClick={() => setRMode(m.mode)}>
                            {m.mode === 'truck' ? '🚚 po silnici' : '🚢 po vodě'}
                            <span className="dim">{m.distance} dl.</span>
                          </button>
                        ))}
                      </div>
                      <div className="cargo-vehicles">
                        <span className="dim">Vozidel:</span>
                        <button className="btn btn--sm" disabled={rVehicles <= 1}
                          onClick={() => setRVehicles((n) => n - 1)}>−</button>
                        <strong>{rVehicles}×</strong>
                        <button className="btn btn--sm" disabled={rVehicles >= 8}
                          onClick={() => setRVehicles((n) => n + 1)}>＋</button>
                      </div>
                      <table className="insp-table">
                        <tbody>
                          <tr><td className="dim">Kapacita</td>
                            <td>{offer.capacityPerHour * rVehicles} ks/h</td></tr>
                          <tr><td className="dim">Přepravné</td>
                            <td>{money(offer.feePerHour * rVehicles)}/h při plném naložení</td></tr>
                          <tr><td className="dim">Vozový park</td>
                            <td>{money(offer.setupPerVehicle * rVehicles)} jednorázově</td></tr>
                        </tbody>
                      </table>
                      <button className="btn btn--primary wide" disabled={!!busy}
                        onClick={() => onCreateRoute(selectedPlot, offer.mode, rVehicles)}>
                        Založit trasu · {money(offer.setupPerVehicle * rVehicles)}
                      </button>
                    </>
                  )}
                </div>
              )}

              <button className="ghost wide" onClick={() => onSelectPlot(null)}>Zavřít</button>
            </>
          )}

          {routes.length > 0 && (
            <div className="insp-routes">
              <h3>🚚 Tvoje trasy ({routes.length})</h3>
              {routes.map((r) => (
                <div key={r.id} className="route-row">
                  <span className="route-row__icon">{r.mode === 'truck' ? '🚚' : '🚢'}</span>
                  <span className="route-row__name">
                    {r.from.building ?? '?'} → {r.to.building ?? '?'}
                    <span className="dim">
                      {' '}{r.vehicles}× · {r.distance} dl · {compact(r.capacityPerHour)} ks/h ·
                      svezeno {compact(r.hauledTotal)} ks
                    </span>
                  </span>
                  <button className="btn btn--sm" disabled={!!busy} title="Zrušit trasu"
                    onClick={() => onDeleteRoute(r.id)}>✕</button>
                </div>
              ))}
              <p className="dim">
                Přepravné se platí jen za skutečně svezené zboží. Trasa vyprázdní
                plný sklad — proto se vyplatí vézt z dolu/tábora do skladu či obchodu.
              </p>
            </div>
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
